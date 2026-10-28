import { randomUUID } from "node:crypto";

import {
  DEFAULT_MAX_RESULT_CHARS,
  MS_PER_SECOND,
  RATE_LIMIT_STATUS_REJECTED,
} from "../domain/constants";
import { buildContextPackage } from "../domain/contextPackage";
import type { AgentEvent } from "../domain/events";
import { decidePermission } from "../domain/permissionPolicy";
import {
  beginAnswer,
  expireAll,
  resolve,
  type PermissionRecord,
  type TransitionFailure,
} from "../domain/permissionRecords";
import {
  createRateLimitDetector,
  type RateLimitDetector,
  type TurnOutcome,
} from "../domain/rateLimit";
import {
  createRotationController,
  type AccountRuntime,
  type RotationController,
  type RotationPhase,
  type RotationPorts,
  type StartResult,
} from "../domain/rotation";
import {
  INITIAL_SESSION_STATE,
  reduceSession,
  type SessionState,
} from "../domain/sessionReducer";
import {
  PermissionProfile,
  type Account,
  type EpochMillis,
  type SwitchLogEntry,
  type WorktreeState,
} from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type { FlowRef, LimitView, SessionView } from "../shared/views";

import {
  AgentStartFailure,
  UnknownPermissionError,
  type AgentAdapter,
  type AgentHandle,
  type AgentStartResult,
} from "./agentAdapter";
import type { ConnectionRegistry } from "./connections";
import {
  CONTAINER_UNAVAILABLE_MESSAGE,
  PROCESS_EXITED_MESSAGE,
  SESSION_CLOSED_MESSAGE,
} from "./constants";
import { pickOption, toPermissionQuery } from "./permissionQuery";
import type { StopResult } from "./process/container";
import { toSessionView } from "./sessionView";
import type { JsonStore } from "./storage";

type PermissionRequest = Extract<AgentEvent, { type: "permission_request" }>;

export interface ContainerStatus {
  readonly available: boolean;
  readonly message: string | null;
}

export interface SessionServiceDeps {
  readonly adapter: AgentAdapter;
  readonly store: JsonStore;
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly now: () => EpochMillis;
  readonly schedule: RotationPorts["schedule"];
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
  readonly newRunId: () => string;
  readonly resolveClaudeExecutable: (configured: string | null) => string;
  readonly stopGraceMs: number;
  readonly containerStatus: ContainerStatus;
}

export interface SessionService {
  view(): SessionView | null;
  start(params: ParamsMap["session/start"]): Promise<SessionView>;
  prompt(text: string): Promise<void>;
  stop(): Promise<void>;
  answerPermission(requestId: string, optionId: string): void;
  isInUse(accountId: string): boolean;
  runtimeOf(accountId: string): AccountRuntime;
  onRuntimeChanged(listener: () => void): () => void;
  setAccounts(accounts: readonly Account[]): void;
  shutdown(): Promise<void>;
}

interface RunSpec {
  readonly cwd: string;
  readonly profile: PermissionProfile;
  readonly flowRef: FlowRef | null;
}

const INACTIVE_PHASES: readonly RotationPhase["phase"][] = [
  "stopped",
  "halted",
  "failed",
];
const READY: AccountRuntime = { status: "ready" };
const PREVIOUS_AGENT_RUNNING_MESSAGE = "The previous agent is still running";

function transitionError(reason: TransitionFailure): IpcError {
  switch (reason) {
    case "expired":
      return new IpcError(IpcErrorCode.EXPIRED, "Permission request expired");
    case "resolved":
    case "already_answering":
      return new IpcError(
        IpcErrorCode.CONFLICT,
        "Permission request was already answered",
      );
    case "unknown_option":
      return new IpcError(
        IpcErrorCode.VALIDATION,
        "Option is not offered by this request",
      );
    case "not_answering":
      return new IpcError(
        IpcErrorCode.INTERNAL,
        "Permission request is not being answered",
      );
  }
}

function startError(account: Account, result: AgentStartResult): IpcError {
  if (!result.ok && result.reason === AgentStartFailure.needsLogin) {
    return new IpcError(
      IpcErrorCode.CONFLICT,
      `Account ${account.label} needs login`,
    );
  }
  return new IpcError(
    IpcErrorCode.UNAVAILABLE,
    `Could not start the agent: ${result.ok ? "" : result.message}`,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SessionRunInit {
  deps: SessionServiceDeps;
  spec: RunSpec;
  accounts: readonly Account[];
  initial: Account;
  onRuntimeSettled: () => void;
}

class SessionRun {
  readonly id = randomUUID();
  private readonly deps: SessionServiceDeps;
  private readonly spec: RunSpec;
  private readonly onRuntimeSettled: () => void;
  private readonly controller: RotationController;
  private accounts: readonly Account[];
  private state: SessionState = INITIAL_SESSION_STATE;
  private readonly userPrompts: string[] = [];
  private readonly limits = new Map<string, LimitView>();
  private readonly handles = new Map<string, AgentHandle>();
  private readonly retired = new WeakSet<AgentHandle>();
  private readonly deciding = new Set<string>();
  private readonly launching = new Set<Promise<unknown>>();
  private current: AgentHandle | null = null;
  private detector: RateLimitDetector | null = null;
  private activeTurns = 0;
  private failure: string | null = null;
  private closed = false;
  private worktreeRoot: Promise<string> | null = null;

  constructor({
    deps,
    spec,
    accounts,
    initial,
    onRuntimeSettled,
  }: SessionRunInit) {
    this.deps = deps;
    this.onRuntimeSettled = onRuntimeSettled;
    this.spec = spec;
    this.accounts = accounts;
    this.controller = createRotationController(
      {
        stopAgent: (accountId) => this.stopAgent(accountId),
        startAgent: (accountId) => this.startAgent(accountId),
        sendPrompt: (accountId, text) => this.runTurn(accountId, text),
        buildContextPackage: () => this.buildContext(),
        appendSwitchLog: (entry) => this.logSwitch(entry),
        schedule: deps.schedule,
        now: deps.now,
      },
      accounts,
      initial.id,
      this.id,
    );
  }

  async begin(account: Account): Promise<void> {
    const result = await this.launch(account);
    if (!result.ok) {
      this.controller.dispose();
      throw startError(account, result);
    }
    this.controller.subscribe(() => {
      this.publish();
      this.onRuntimeSettled();
    });
  }

  view(): SessionView {
    return toSessionView({
      id: this.id,
      cwd: this.spec.cwd,
      profile: this.spec.profile,
      phase: this.phase(),
      state: this.state,
      limits: [...this.limits.values()],
      turnInFlight: this.activeTurns > 0,
      flowRef: this.spec.flowRef,
      hiddenRequestIds: this.deciding,
    });
  }

  phase(): RotationPhase {
    return this.failure === null
      ? this.controller.phase()
      : {
          phase: "failed",
          reason: this.failure,
          runningAccountId: this.current?.accountId ?? null,
        };
  }

  isLive(): boolean {
    return !INACTIVE_PHASES.includes(this.phase().phase);
  }

  hasAgents(): boolean {
    return this.handles.size > 0;
  }

  isInUse(accountId: string): boolean {
    if (this.controller.busy()) {
      return true;
    }
    const phase = this.phase();
    switch (phase.phase) {
      case "running":
      case "waiting":
        return phase.accountId === accountId;
      case "switching":
        return phase.from === accountId || phase.to === accountId;
      default:
        return false;
    }
  }

  runtimeOf(accountId: string): AccountRuntime {
    return this.controller.runtime().get(accountId) ?? READY;
  }

  runtime(): ReadonlyMap<string, AccountRuntime> {
    return this.controller.runtime();
  }

  setAccounts(accounts: readonly Account[]): void {
    this.accounts = accounts;
    this.controller.setAccounts(accounts);
  }

  prompt(text: string): void {
    const phase = this.phase();
    if (
      phase.phase !== "running" ||
      this.activeTurns > 0 ||
      this.controller.busy()
    ) {
      throw new IpcError(
        IpcErrorCode.SESSION_BUSY,
        "The session cannot take a prompt right now",
      );
    }
    this.userPrompts.push(text);
    void this.userTurn(phase.accountId, text);
  }

  answerPermission(requestId: string, optionId: string): void {
    const record = this.state.permissions.find(
      (item) => item.requestId === requestId,
    );
    if (record === undefined) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, "Unknown permission request");
    }
    const began = beginAnswer(record, optionId);
    if (!began.ok) {
      throw transitionError(began.reason);
    }
    this.replacePermission(began.record);
    this.deliver(began.record, optionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.launching]);
    await Promise.all(
      [...this.handles.keys()].map((accountId) =>
        this.stopAgent(accountId).catch((error: unknown) => {
          console.error(`failed to stop ${accountId}`, error);
        }),
      ),
    );
    this.controller.dispose();
    this.failure = null;
    this.state = {
      ...this.state,
      permissions: expireAll(this.state.permissions),
    };
    this.publish();
  }

  private publish(): void {
    this.deps.broadcast("session/changed", this.view());
  }

  private launch(account: Account): Promise<AgentStartResult> {
    const pending = this.spawnAgent(account);
    this.launching.add(pending);
    return pending.finally(() => {
      this.launching.delete(pending);
    });
  }

  private async spawnAgent(account: Account): Promise<AgentStartResult> {
    const settings = await this.deps.store.readSettings();
    const result = await this.deps.adapter.start({
      account,
      cwd: this.spec.cwd,
      profile: this.spec.profile,
      runId: this.deps.newRunId(),
      claudeExecutable: this.deps.resolveClaudeExecutable(
        settings.claudeExecutable,
      ),
    });
    if (!result.ok) {
      return result;
    }
    if (this.closed) {
      await this.haltHandle(result.handle);
      return {
        ok: false,
        reason: AgentStartFailure.error,
        message: SESSION_CLOSED_MESSAGE,
      };
    }
    this.register(result.handle);
    return result;
  }

  private register(handle: AgentHandle): void {
    this.handles.set(handle.accountId, handle);
    this.current = handle;
    handle.subscribe((event) => {
      this.onEvent(handle, event);
    });
  }

  private async haltHandle(handle: AgentHandle): Promise<StopResult> {
    this.retired.add(handle);
    await handle.cancel().catch((error: unknown) => {
      console.warn(`cancel before stop failed: ${handle.runId}`, error);
    });
    return handle.stop(this.deps.stopGraceMs);
  }

  private async stopAgent(accountId: string): Promise<{ ok: boolean }> {
    const handle = this.handles.get(accountId);
    if (handle === undefined) {
      return { ok: true };
    }
    const result = await this.haltHandle(handle);
    if (result.ok) {
      this.handles.delete(accountId);
    }
    return { ok: result.ok };
  }

  private async startAgent(accountId: string): Promise<StartResult> {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === undefined) {
      return { ok: false, reason: AgentStartFailure.error };
    }
    const result = await this.launch(account);
    if (result.ok) {
      return { ok: true };
    }
    console.error(`failed to start ${accountId}: ${result.message}`);
    return { ok: false, reason: result.reason };
  }

  private async buildContext(): Promise<string> {
    const worktree = await this.deps.inspectWorktree(this.spec.cwd);
    const { turnLog, previousTurnLog } = this.state;
    return buildContextPackage({
      userPrompts: this.userPrompts,
      interruptedTurn: turnLog.length > 0 ? turnLog : previousTurnLog,
      worktree,
      maxResultChars: DEFAULT_MAX_RESULT_CHARS,
    });
  }

  private async logSwitch(entry: SwitchLogEntry): Promise<void> {
    await this.deps.store.appendSwitchLog(entry);
    this.deps.broadcast("switchLog/appended", entry);
  }

  private async userTurn(accountId: string, text: string): Promise<void> {
    this.activeTurns += 1;
    try {
      const outcome = await this.runTurn(accountId, text);
      await this.controller.onTurnSettled(accountId, outcome);
    } catch (error) {
      console.error(`turn failed on ${accountId}`, error);
    } finally {
      this.activeTurns -= 1;
      this.publish();
      this.onRuntimeSettled();
    }
  }

  private async runTurn(accountId: string, text: string): Promise<TurnOutcome> {
    const handle = this.current;
    if (this.closed || handle?.accountId !== accountId) {
      return { kind: "failed", message: SESSION_CLOSED_MESSAGE };
    }
    this.activeTurns += 1;
    const detector = createRateLimitDetector(this.deps.now);
    this.detector = detector;
    this.publish();
    try {
      await handle.prompt(text);
    } catch (error) {
      console.error(`prompt failed on ${accountId}`, error);
      this.onEvent(handle, {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: errorText(error),
      });
    }
    this.detector = null;
    this.activeTurns -= 1;
    const outcome = detector.settle();
    if (outcome.kind === "exhausted") {
      this.limits.set(accountId, {
        accountId,
        status: RATE_LIMIT_STATUS_REJECTED,
        resetsAt: outcome.resetsAt,
        rateLimitType: outcome.rateLimitType,
        utilization: detector.snapshot()?.utilization ?? null,
        observedAt: this.deps.now(),
      });
    }
    this.publish();
    return outcome;
  }

  private onEvent(handle: AgentHandle, event: AgentEvent): void {
    if (handle !== this.current) {
      return;
    }
    this.state = reduceSession(this.state, event);
    this.detector?.observe(event);
    switch (event.type) {
      case "rate_limit":
        this.recordLimit(handle.accountId);
        break;
      case "permission_request":
        this.routePermission(event);
        break;
      case "process_exit":
        this.handleExit(handle);
        break;
      default:
        break;
    }
    this.publish();
  }

  private recordLimit(accountId: string): void {
    const snapshot = this.detector?.snapshot() ?? null;
    if (snapshot !== null) {
      this.limits.set(accountId, {
        accountId,
        status: snapshot.status,
        resetsAt: snapshot.resetsAt,
        rateLimitType: snapshot.rateLimitType,
        utilization: snapshot.utilization,
        observedAt: this.deps.now(),
      });
    }
  }

  private handleExit(handle: AgentHandle): void {
    if (this.retired.has(handle)) {
      return;
    }
    this.failure = PROCESS_EXITED_MESSAGE;
    this.controller.dispose();
  }

  private routePermission(event: PermissionRequest): void {
    if (this.spec.profile === PermissionProfile.ask) {
      return;
    }
    this.deciding.add(event.requestId);
    void this.autoAnswer(event);
  }

  private async autoAnswer(event: PermissionRequest): Promise<void> {
    const optionId = await this.decideOption(event);
    this.deciding.delete(event.requestId);
    try {
      if (optionId !== null) {
        this.answerPermission(event.requestId, optionId);
      }
    } catch (error) {
      console.warn(`auto answer failed: ${event.requestId}`, error);
    }
    this.publish();
  }

  private async decideOption(event: PermissionRequest): Promise<string | null> {
    try {
      const decision = decidePermission(
        toPermissionQuery(event, this.spec.cwd),
        this.spec.profile,
        { worktreeRoot: await this.rootOfWorktree() },
      );
      return pickOption(decision, event.options);
    } catch (error) {
      console.error(`permission decision failed: ${event.requestId}`, error);
      this.worktreeRoot = null;
      return null;
    }
  }

  private rootOfWorktree(): Promise<string> {
    this.worktreeRoot ??= this.deps
      .inspectWorktree(this.spec.cwd)
      .then((worktree) => (worktree.isRepo ? worktree.root : worktree.cwd));
    return this.worktreeRoot;
  }

  private deliver(answering: PermissionRecord, optionId: string): void {
    const { requestId } = answering;
    try {
      if (this.current === null) {
        throw new UnknownPermissionError(requestId);
      }
      this.current.answerPermission(requestId, optionId);
    } catch (error) {
      if (error instanceof UnknownPermissionError) {
        expireAll([answering]).forEach((record) => {
          this.replacePermission(record);
        });
        this.publish();
        throw new IpcError(IpcErrorCode.EXPIRED, "Permission request expired");
      }
      throw error;
    }
    const done = resolve(answering);
    if (done.ok) {
      this.replacePermission(done.record);
    }
    this.publish();
  }

  private replacePermission(record: PermissionRecord): void {
    this.state = {
      ...this.state,
      permissions: this.state.permissions.map((item) =>
        item.requestId === record.requestId ? record : item,
      ),
    };
  }
}

function runtimeSignature(
  runtime: ReadonlyMap<string, AccountRuntime> | undefined,
): string {
  const informative = [...(runtime ?? [])]
    .filter(([, value]) => value.status !== READY.status)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(informative);
}

function isUsable(runtime: AccountRuntime, now: EpochMillis): boolean {
  return (
    runtime.status === "ready" ||
    (runtime.status === "exhausted" && runtime.resetsAt * MS_PER_SECOND <= now)
  );
}

async function beginRun(
  deps: SessionServiceDeps,
  params: ParamsMap["session/start"],
  runtimeOf: (accountId: string) => AccountRuntime,
  onRuntimeSettled: () => void,
): Promise<SessionRun> {
  const accounts = (await deps.store.readAccounts()).toSorted(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
  const initial = accounts.find((account) =>
    isUsable(runtimeOf(account.id), deps.now()),
  );
  if (initial === undefined) {
    throw new IpcError(IpcErrorCode.CONFLICT, "No usable account");
  }
  const settings = await deps.store.readSettings();
  const run = new SessionRun({
    deps,
    spec: {
      cwd: params.cwd,
      profile: params.profile ?? settings.permissionProfile,
      flowRef: params.flowRef ?? null,
    },
    accounts,
    initial,
    onRuntimeSettled,
  });
  await run.begin(initial);
  return run;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  let run: SessionRun | null = null;
  let starting = false;
  let lastSignature = runtimeSignature(undefined);
  const listeners = new Set<() => void>();

  const checkRuntime = (): void => {
    const signature = runtimeSignature(run?.runtime());
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    listeners.forEach((listener) => {
      listener();
    });
  };
  const requireRun = (): SessionRun => {
    if (run === null) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, "There is no session");
    }
    return run;
  };
  const runtimeOf = (accountId: string): AccountRuntime =>
    run?.runtimeOf(accountId) ?? READY;
  const releasePrevious = async (): Promise<void> => {
    await run?.close();
    if (run?.hasAgents() === true) {
      throw new IpcError(IpcErrorCode.CONFLICT, PREVIOUS_AGENT_RUNNING_MESSAGE);
    }
  };

  return {
    view: () => run?.view() ?? null,
    async start(params): Promise<SessionView> {
      if (!deps.containerStatus.available) {
        throw new IpcError(
          IpcErrorCode.UNAVAILABLE,
          deps.containerStatus.message ?? CONTAINER_UNAVAILABLE_MESSAGE,
        );
      }
      if (starting || run?.isLive() === true) {
        throw new IpcError(
          IpcErrorCode.CONFLICT,
          "A session is already running",
        );
      }
      starting = true;
      try {
        await releasePrevious();
        run = await beginRun(deps, params, runtimeOf, checkRuntime);
      } finally {
        starting = false;
      }
      const view = run.view();
      deps.broadcast("session/changed", view);
      checkRuntime();
      return view;
    },
    prompt: async (text) => {
      requireRun().prompt(text);
      return Promise.resolve();
    },
    stop: async () => {
      await run?.close();
      checkRuntime();
    },
    onRuntimeChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    answerPermission: (requestId, optionId) => {
      requireRun().answerPermission(requestId, optionId);
    },
    isInUse: (accountId) => run?.isInUse(accountId) ?? false,
    runtimeOf,
    setAccounts: (next) => {
      run?.setAccounts(next);
    },
    shutdown: async () => {
      await run?.close();
    },
  };
}
