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
import { EdgeKind, type WorktreeState } from "../domain/types";
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

export interface FlowRunDeps {
  readonly sessions: SessionService;
  readonly listFlows: (cwd: string) => Promise<FlowsList>;
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly newRunId: () => string;
}

export interface FlowRunService {
  view(): FlowRunView | null;
  start(params: ParamsMap["flow/start"]): Promise<FlowRunView>;
  stop(): Promise<void>;
  decide(params: ParamsMap["flow/decide"]): Promise<FlowRunView>;
  isActive(): boolean;
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

const ACTIVE_STATUSES: readonly FlowRunStatus[] = [
  FlowRunStatus.running,
  FlowRunStatus.awaitingDecision,
];
const FLOW_ALREADY_RUNNING_MESSAGE = "A flow is already running";
const SESSION_ALREADY_RUNNING_MESSAGE = "A session is already running";
const BLANK_TASK_MESSAGE = "The task must not be blank";
const UNKNOWN_RUN_MESSAGE = "Unknown flow run";
const NODE_STOPPED_MESSAGE = "The flow run was stopped";
const START_CANCELLED_MESSAGE = "The flow run was stopped before it started";
const SHUT_DOWN_MESSAGE = "The flow runner has shut down";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpen(state: FlowRunState): boolean {
  return ACTIVE_STATUSES.includes(state.status);
}

function toFlowRunView(state: FlowRunState): FlowRunView {
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
    nodes: state.nodes.map((node) => ({ ...node })),
    decision: state.decision === null ? null : { ...state.decision },
    failure: state.failure,
  };
}

function toDefinition(view: FlowView): FlowDefinition {
  return {
    id: view.id,
    title: view.title,
    maxRounds: view.maxRounds,
    nodes: view.nodes.map(({ id, agent, provider }) => ({
      id,
      agent,
      ...(provider === null ? {} : { provider }),
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

class FlowRunner implements FlowRunService {
  private readonly deps: FlowRunDeps;
  private current: ActiveRun | null = null;
  private opening: Opening | null = null;
  private closed = false;
  private pumpRunning = false;
  private pumping: Promise<void> = Promise.resolve();

  constructor(deps: FlowRunDeps) {
    this.deps = deps;
  }

  view(): FlowRunView | null {
    return this.current === null ? null : toFlowRunView(this.current.state);
  }

  isActive(): boolean {
    return (
      this.opening !== null ||
      this.pumpRunning ||
      (this.current !== null && isOpen(this.current.state))
    );
  }

  async start({
    cwd,
    flowId,
    task,
  }: ParamsMap["flow/start"]): Promise<FlowRunView> {
    this.assertIdle();
    if (task.trim() === "") {
      throw new IpcError(IpcErrorCode.VALIDATION, BLANK_TASK_MESSAGE);
    }
    const opening: Opening = {
      cancelled: false,
      settled: Promise.withResolvers<undefined>(),
    };
    this.opening = opening;
    try {
      const list = await this.deps.listFlows(cwd);
      if (opening.cancelled) {
        throw new IpcError(IpcErrorCode.CONFLICT, START_CANCELLED_MESSAGE);
      }
      const flow = list.flows.find((candidate) => candidate.id === flowId);
      if (flow === undefined) {
        throw unknownFlow(list, flowId);
      }
      const definition = toDefinition(flow);
      const transition = startRun(definition, {
        runId: this.deps.newRunId(),
        cwd,
        task,
        maxRounds: flow.maxRounds,
      });
      this.current = {
        state: transition.state,
        flow: definition,
        agents: new Map(list.agents.map((agent) => [agent.id, agent])),
      };
      this.launch(this.current, transition);
      return toFlowRunView(transition.state);
    } finally {
      this.opening = null;
      opening.settled.resolve(undefined);
    }
  }

  async decide({
    runId,
    decision,
  }: ParamsMap["flow/decide"]): Promise<FlowRunView> {
    const run = this.current;
    if (run?.state.runId !== runId) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, UNKNOWN_RUN_MESSAGE);
    }
    const transition = this.transition(run, decision);
    this.launch(run, transition);
    return Promise.resolve(toFlowRunView(transition.state));
  }

  async stop(): Promise<void> {
    await this.cancelOpening();
    const run = this.current;
    if (run !== null && isOpen(run.state)) {
      const sessionNeeded = run.state.status === FlowRunStatus.running;
      this.commit(run, stopRun(run.state).state);
      if (sessionNeeded) {
        await this.deps.sessions.stop();
      }
    }
    await this.pumping;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.stop();
  }

  private async cancelOpening(): Promise<void> {
    if (this.opening === null) {
      return;
    }
    this.opening.cancelled = true;
    await this.opening.settled.promise;
  }

  private assertIdle(): void {
    if (this.closed) {
      throw new IpcError(IpcErrorCode.UNAVAILABLE, SHUT_DOWN_MESSAGE);
    }
    if (this.isActive()) {
      throw new IpcError(IpcErrorCode.CONFLICT, FLOW_ALREADY_RUNNING_MESSAGE);
    }
    if (this.deps.sessions.isLive()) {
      throw new IpcError(
        IpcErrorCode.CONFLICT,
        SESSION_ALREADY_RUNNING_MESSAGE,
      );
    }
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
    this.deps.broadcast("flow/changed", toFlowRunView(state));
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
      });
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
        await this.deps.sessions.stop().catch((error: unknown) => {
          console.error("failed to stop the node session", error);
        });
      }
    }
  }

  private async openSession(run: ActiveRun, nodeId: string): Promise<void> {
    const { node, agent } = this.resolve(run, nodeId);
    await this.deps.sessions.start({
      cwd: run.state.cwd,
      profile: agent.permissionProfile,
      provider: node.provider ?? agent.provider,
      flowRef: { flowId: run.state.flowId, nodeId },
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
    const { sessions } = this.deps;
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

export function createFlowRunService(deps: FlowRunDeps): FlowRunService {
  return new FlowRunner(deps);
}
