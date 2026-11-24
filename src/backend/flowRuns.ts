import { MAX_PARALLEL_FLOWS, RETAINED_FLOW_RUNS } from "../domain/constants";
import { buildNodePrompt } from "../domain/flowPrompt";
import {
  FlowNodeRunStatus,
  FlowRunStatus,
  InvalidDecisionError,
  applyDecision,
  nodeFailed,
  nodeSucceeded,
  startRun,
  stopRun,
  type FlowDecision,
  type FlowRunState,
  type NodeInput,
  type Transition,
} from "../domain/flowRun";
import type { FlowDefinition } from "../domain/flows";
import { isAutoModel, type ModelChoice } from "../domain/modelChoice";
import {
  EdgeKind,
  FlowPlacement,
  FlowRunOrigin,
  type ProviderId,
  type WorktreeState,
} from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type {
  AgentView,
  FlowRunView,
  FlowsList,
  FlowView,
} from "../shared/views";

import type { ConnectionRegistry } from "./connections";
import { failure, highestSeq, watchTurn, type NodeOutcome } from "./nodeTurn";
import type { SessionService } from "./session";

function modelChoiceOf(
  nodeProvider: ProviderId | undefined,
  agent: AgentView,
): ModelChoice | null {
  const ownProvider =
    nodeProvider === undefined || nodeProvider === agent.provider;
  return ownProvider && agent.model !== null && !isAutoModel(agent.model)
    ? { provider: agent.provider, model: agent.model }
    : null;
}

export interface FlowRunDeps {
  readonly sessions: (runId: string) => SessionService;
  readonly releaseSessions: (runId: string) => Promise<void>;
  readonly mainSessionLive: () => boolean;
  readonly listFlows: (cwd?: string) => Promise<FlowsList>;
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly newRunId: () => string;
}

export type FlowStartRequest = ParamsMap["flow/start"] & {
  readonly origin?: FlowRunOrigin;
  readonly placement?: FlowPlacement;
  readonly branch?: string | null;
  readonly runId?: string;
  readonly definitionsCwd?: string | null;
  readonly ownerSessionId?: string | null;
};

export interface FlowRunService {
  views(): FlowRunView[];
  view(runId: string): FlowRunView | null;
  start(request: FlowStartRequest): Promise<FlowRunView>;
  stop(runId: string): Promise<void>;
  stopAll(): Promise<void>;
  decide(params: ParamsMap["flow/decide"], note?: string): Promise<FlowRunView>;
  answerPermission(runId: string, requestId: string, optionId: string): void;
  isOpen(runId: string): boolean;
  hasOpenRuns(): boolean;
  hasOpenUserRuns(): boolean;
  onChanged(listener: (view: FlowRunView) => void): () => void;
  shutdown(): Promise<void>;
}

interface ActiveRun {
  state: FlowRunState;
  readonly flow: FlowDefinition;
  readonly agents: ReadonlyMap<string, AgentView>;
}

interface Opening {
  cancelled: boolean;
  readonly settled: PromiseWithResolvers<undefined>;
}

interface RunIdentity {
  readonly runId: string;
  readonly cwd: string;
  readonly origin: FlowRunOrigin;
  readonly placement: FlowPlacement;
  readonly branch: string | null;
  readonly ownerSessionId: string | null;
}

type DecisionLog = FlowRunView["decisions"];

const ACTIVE_STATUSES: readonly FlowRunStatus[] = [
  FlowRunStatus.running,
  FlowRunStatus.awaitingDecision,
];
const FLOW_ALREADY_RUNNING_MESSAGE = "A flow is already running in this folder";
const FLOW_LIMIT_MESSAGE = `At most ${String(MAX_PARALLEL_FLOWS)} flows can run at once`;
const SESSION_ALREADY_RUNNING_MESSAGE = "A session is already running";
const BLANK_TASK_MESSAGE = "The task must not be blank";
const UNKNOWN_RUN_MESSAGE = "Unknown flow run";
const UNKNOWN_PERMISSION_MESSAGE = "Unknown permission request";
const NODE_STOPPED_MESSAGE = "The flow run was stopped";
const START_CANCELLED_MESSAGE = "The flow run was stopped before it started";
const SHUT_DOWN_MESSAGE = "The flow runner has shut down";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpen(state: FlowRunState): boolean {
  return ACTIVE_STATUSES.includes(state.status);
}

function toFlowRunView(
  state: FlowRunState,
  identity: RunIdentity,
  decisions: DecisionLog,
  nodeModels: ReadonlyMap<string, string>,
): FlowRunView {
  return {
    runId: state.runId,
    flowId: state.flowId,
    flowTitle: state.flowTitle,
    cwd: state.cwd,
    task: state.task,
    status: state.status,
    round: Math.max(0, ...state.rounds.values()),
    maxRounds: state.maxRounds,
    currentNodeId:
      state.nodes.find((node) => node.status === FlowNodeRunStatus.running)
        ?.id ?? null,
    nodes: state.nodes.map((node) => ({
      ...node,
      model: nodeModels.get(node.id) ?? null,
    })),
    decision: state.decision === null ? null : { ...state.decision },
    decisions: decisions.map((entry) => ({ ...entry })),
    failure: state.failure,
    origin: identity.origin,
    placement: identity.placement,
    branch: identity.branch,
    ownerSessionId: identity.ownerSessionId,
  };
}

function toDefinition(view: FlowView): FlowDefinition {
  return {
    id: view.id,
    title: view.title,
    maxRounds: view.maxRounds,
    nodes: view.nodes.map(({ id, agent, provider, taskClass }) => ({
      id,
      agent,
      ...(provider === null ? {} : { provider }),
      ...(taskClass === null ? {} : { taskClass }),
    })),
    edges: view.edges.map((edge) => ({ ...edge })),
  };
}

function unknownFlow(list: FlowsList, flowId: string): IpcError {
  const broken = list.errors.find(
    (error) => error.file === `flows/${flowId}.md`,
  );
  return broken === undefined
    ? new IpcError(IpcErrorCode.NOT_FOUND, `Unknown flow "${flowId}"`)
    : new IpcError(
        IpcErrorCode.VALIDATION,
        `Flow "${flowId}" is invalid: ${broken.messages.join("; ")}`,
      );
}

class FlowRun {
  readonly runId: string;
  readonly cwd: string;
  readonly origin: FlowRunOrigin;
  private readonly identity: RunIdentity;
  private readonly deps: FlowRunDeps;
  private readonly onChange: (view: FlowRunView) => void;
  private readonly decisions: DecisionLog = [];
  private readonly nodeModels = new Map<string, string>();
  private active: ActiveRun | null = null;
  private opening: Opening | null = null;
  private pumpRunning = false;
  private pumping: Promise<void> = Promise.resolve();

  constructor(
    deps: FlowRunDeps,
    identity: RunIdentity,
    onChange: (view: FlowRunView) => void,
  ) {
    this.deps = deps;
    this.identity = identity;
    this.runId = identity.runId;
    this.cwd = identity.cwd;
    this.origin = identity.origin;
    this.onChange = onChange;
  }

  view(): FlowRunView | null {
    return this.active === null ? null : this.viewOf(this.active.state);
  }

  isActive(): boolean {
    return (
      this.opening !== null ||
      this.pumpRunning ||
      (this.active !== null && isOpen(this.active.state))
    );
  }

  async begin({
    flowId,
    task,
    definitionsCwd,
  }: Pick<
    FlowStartRequest,
    "flowId" | "task" | "definitionsCwd"
  >): Promise<FlowRunView> {
    const opening: Opening = {
      cancelled: false,
      settled: Promise.withResolvers<undefined>(),
    };
    this.opening = opening;
    try {
      const list = await this.deps.listFlows(
        definitionsCwd === null ? undefined : (definitionsCwd ?? this.cwd),
      );
      if (opening.cancelled) {
        throw new IpcError(IpcErrorCode.CONFLICT, START_CANCELLED_MESSAGE);
      }
      const flow = list.flows.find((candidate) => candidate.id === flowId);
      if (flow === undefined) {
        throw unknownFlow(list, flowId);
      }
      const definition = toDefinition(flow);
      const transition = startRun(definition, {
        runId: this.runId,
        cwd: this.cwd,
        task,
        maxRounds: flow.maxRounds,
      });
      const run: ActiveRun = {
        state: transition.state,
        flow: definition,
        agents: new Map(list.agents.map((agent) => [agent.id, agent])),
      };
      this.active = run;
      this.launch(run, transition);
      return this.viewOf(transition.state);
    } finally {
      this.opening = null;
      opening.settled.resolve(undefined);
    }
  }

  decide(decision: FlowDecision, note: string | null): FlowRunView {
    const run = this.active;
    if (run === null) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, UNKNOWN_RUN_MESSAGE);
    }
    const pending = run.state.decision;
    const transition = this.transition(run, decision);
    if (pending !== null) {
      this.decisions.push({
        nodeId: pending.nodeId,
        reason: pending.reason,
        decision,
        note,
      });
    }
    this.launch(run, transition);
    return this.viewOf(transition.state);
  }

  private viewOf(state: FlowRunState): FlowRunView {
    return toFlowRunView(state, this.identity, this.decisions, this.nodeModels);
  }

  answerPermission(requestId: string, optionId: string): void {
    if (!this.isActive()) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, UNKNOWN_PERMISSION_MESSAGE);
    }
    this.deps.sessions(this.runId).answerPermission(requestId, optionId);
  }

  async stop(): Promise<void> {
    await this.cancelOpening();
    const run = this.active;
    if (run !== null && isOpen(run.state)) {
      const sessionNeeded = run.state.status === FlowRunStatus.running;
      this.commit(run, stopRun(run.state).state);
      if (sessionNeeded) {
        await this.deps.sessions(this.runId).stop();
      }
    }
    await this.pumping;
    await this.releaseSessions();
  }

  private async cancelOpening(): Promise<void> {
    if (this.opening === null) {
      return;
    }
    this.opening.cancelled = true;
    await this.opening.settled.promise;
  }

  private releaseSessions(): Promise<void> {
    if (this.active !== null && isOpen(this.active.state)) {
      return Promise.resolve();
    }
    return this.deps.releaseSessions(this.runId).catch((error: unknown) => {
      console.error("failed to release the run's sessions", error);
    });
  }

  private transition(run: ActiveRun, decision: FlowDecision): Transition {
    try {
      return applyDecision(run.state, run.flow, decision);
    } catch (error) {
      throw error instanceof InvalidDecisionError
        ? new IpcError(IpcErrorCode.VALIDATION, error.message)
        : error;
    }
  }

  private commit(run: ActiveRun, state: FlowRunState): void {
    run.state = state;
    this.onChange(this.viewOf(state));
  }

  private launch(run: ActiveRun, first: Transition): void {
    this.pumpRunning = true;
    this.pumping = this.pump(run, first)
      .catch((error: unknown) => {
        console.error("flow run crashed", error);
        this.crash(run, errorText(error));
      })
      .finally(() => {
        this.pumpRunning = false;
      })
      .then(() => this.releaseSessions());
  }

  private crash(run: ActiveRun, message: string): void {
    const running = run.state.nodes.find(
      (node) => node.status === FlowNodeRunStatus.running,
    );
    if (isOpen(run.state)) {
      this.commit(run, nodeFailed(run.state, running?.id ?? "", message).state);
    }
  }

  private async pump(run: ActiveRun, first: Transition): Promise<void> {
    let transition = first;
    this.commit(run, transition.state);
    while (transition.command.type === "run_node") {
      const { nodeId, inputs } = transition.command;
      const outcome = await this.visit(run, nodeId, inputs);
      if (run.state.status !== FlowRunStatus.running) {
        return;
      }
      transition = outcome.ok
        ? nodeSucceeded(run.state, run.flow, nodeId, outcome.text)
        : nodeFailed(run.state, nodeId, outcome.message);
      this.commit(run, transition.state);
    }
  }

  private async visit(
    run: ActiveRun,
    nodeId: string,
    inputs: readonly NodeInput[],
  ): Promise<NodeOutcome> {
    let opened = false;
    try {
      await this.openSession(run, nodeId);
      opened = true;
      return await this.converse(run, nodeId, inputs);
    } catch (error) {
      return failure(errorText(error));
    } finally {
      if (opened) {
        this.recordNodeModel(nodeId);
        await this.deps
          .sessions(this.runId)
          .stop()
          .catch((error: unknown) => {
            console.error("failed to stop the node session", error);
          });
      }
    }
  }

  private recordNodeModel(nodeId: string): void {
    const view = this.deps.sessions(this.runId).view();
    const last = view?.turns.at(-1);
    const model = view?.currentModel ?? last?.effectiveModel ?? last?.model;
    if (model !== undefined && model !== null) {
      this.nodeModels.set(nodeId, model);
    }
  }

  private async openSession(run: ActiveRun, nodeId: string): Promise<void> {
    const { node, agent } = this.resolve(run, nodeId);
    const model = modelChoiceOf(node.provider, agent);
    const taskClass = node.taskClass ?? agent.taskClass;
    await this.deps.sessions(this.runId).start({
      cwd: run.state.cwd,
      profile: agent.permissionProfile,
      provider: node.provider ?? agent.provider,
      flowRef: { flowId: run.state.flowId, nodeId },
      ...(model === null ? {} : { model }),
      ...(taskClass === null ? {} : { taskClass }),
    });
  }

  private resolve(
    run: ActiveRun,
    nodeId: string,
  ): { node: FlowDefinition["nodes"][number]; agent: AgentView } {
    const node = run.flow.nodes.find((candidate) => candidate.id === nodeId);
    const agent = run.agents.get(node?.agent ?? "");
    if (node === undefined || agent === undefined) {
      throw new Error(`Node "${nodeId}" has no agent`);
    }
    return { node, agent };
  }

  private async converse(
    run: ActiveRun,
    nodeId: string,
    inputs: readonly NodeInput[],
  ): Promise<NodeOutcome> {
    const sessions = this.deps.sessions(this.runId);
    const baseline = highestSeq(sessions.view()?.messages ?? []);
    const worktree = await this.deps.inspectWorktree(run.state.cwd);
    if (run.state.status !== FlowRunStatus.running) {
      return failure(NODE_STOPPED_MESSAGE);
    }
    const watch = watchTurn(sessions, baseline);
    try {
      await sessions.prompt(this.promptFor(run, nodeId, inputs, worktree));
      return await watch.outcome;
    } finally {
      watch.dispose();
    }
  }

  private promptFor(
    run: ActiveRun,
    nodeId: string,
    inputs: readonly NodeInput[],
    worktree: WorktreeState,
  ): string {
    const { agent } = this.resolve(run, nodeId);
    return buildNodePrompt({
      flowTitle: run.state.flowTitle,
      nodeId,
      agentRole: agent.role,
      agentBody: agent.body,
      task: run.state.task,
      inputs,
      worktree,
      givesVerdict: run.flow.edges.some(
        (edge) => edge.kind === EdgeKind.reviews && edge.from === nodeId,
      ),
    });
  }
}

class FlowRunPool implements FlowRunService {
  private readonly deps: FlowRunDeps;
  private readonly runs = new Map<string, FlowRun>();
  private readonly listeners = new Set<(view: FlowRunView) => void>();
  private closed = false;

  constructor(deps: FlowRunDeps) {
    this.deps = deps;
  }

  views(): FlowRunView[] {
    return [...this.runs.values()].flatMap((run) => {
      const view = run.view();
      return view === null ? [] : [view];
    });
  }

  view(runId: string): FlowRunView | null {
    return this.runs.get(runId)?.view() ?? null;
  }

  isOpen(runId: string): boolean {
    return this.runs.get(runId)?.isActive() ?? false;
  }

  hasOpenRuns(): boolean {
    return this.openRuns().length > 0;
  }

  hasOpenUserRuns(): boolean {
    return this.openRuns().some((run) => run.origin === FlowRunOrigin.user);
  }

  onChanged(listener: (view: FlowRunView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(request: FlowStartRequest): Promise<FlowRunView> {
    this.assertCanStart(request);
    const run = new FlowRun(
      this.deps,
      {
        runId: request.runId ?? this.deps.newRunId(),
        cwd: request.cwd,
        origin: request.origin ?? FlowRunOrigin.user,
        placement: request.placement ?? FlowPlacement.inPlace,
        branch: request.branch ?? null,
        ownerSessionId: request.ownerSessionId ?? null,
      },
      (view) => {
        this.publish(view);
      },
    );
    const started = run.begin(request);
    this.runs.set(run.runId, run);
    this.evictFinished();
    try {
      return await started;
    } catch (error) {
      this.runs.delete(run.runId);
      throw error;
    }
  }

  async decide(
    { runId, decision }: ParamsMap["flow/decide"],
    note?: string,
  ): Promise<FlowRunView> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, UNKNOWN_RUN_MESSAGE);
    }
    return Promise.resolve(run.decide(decision, note ?? null));
  }

  answerPermission(runId: string, requestId: string, optionId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, UNKNOWN_RUN_MESSAGE);
    }
    run.answerPermission(requestId, optionId);
  }

  async stop(runId: string): Promise<void> {
    await this.runs.get(runId)?.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.stop()));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  private openRuns(): FlowRun[] {
    return [...this.runs.values()].filter((run) => run.isActive());
  }

  private publish(view: FlowRunView): void {
    this.deps.broadcast("flow/changed", view);
    this.listeners.forEach((listener) => {
      listener(view);
    });
  }

  private assertCanStart(request: FlowStartRequest): void {
    if (this.closed) {
      throw new IpcError(IpcErrorCode.UNAVAILABLE, SHUT_DOWN_MESSAGE);
    }
    const origin = request.origin ?? FlowRunOrigin.user;
    if (origin === FlowRunOrigin.user && this.deps.mainSessionLive()) {
      throw new IpcError(
        IpcErrorCode.CONFLICT,
        SESSION_ALREADY_RUNNING_MESSAGE,
      );
    }
    const open = this.openRuns();
    if (open.length >= MAX_PARALLEL_FLOWS) {
      throw new IpcError(IpcErrorCode.CONFLICT, FLOW_LIMIT_MESSAGE);
    }
    if (open.some((run) => run.cwd === request.cwd)) {
      throw new IpcError(IpcErrorCode.CONFLICT, FLOW_ALREADY_RUNNING_MESSAGE);
    }
    if (request.task.trim() === "") {
      throw new IpcError(IpcErrorCode.VALIDATION, BLANK_TASK_MESSAGE);
    }
  }

  private evictFinished(): void {
    const surplus = Math.max(0, this.runs.size - RETAINED_FLOW_RUNS);
    [...this.runs.values()]
      .filter((run) => !run.isActive())
      .slice(0, surplus)
      .forEach((run) => {
        this.runs.delete(run.runId);
      });
  }
}

export function createFlowRunService(deps: FlowRunDeps): FlowRunService {
  return new FlowRunPool(deps);
}
