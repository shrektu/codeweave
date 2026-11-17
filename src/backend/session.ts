import { randomUUID } from "node:crypto";

import {
  DEFAULT_MAX_RESULT_CHARS,
  MS_PER_SECOND,
  NO_MESSAGE_KEY,
  RATE_LIMIT_STATUS_REJECTED,
} from "../domain/constants";
import { buildContextPackage } from "../domain/contextPackage";
import type { AgentEvent } from "../domain/events";
import { explicitModelOn, type ModelChoice } from "../domain/modelChoice";
import { decidePermission } from "../domain/permissionPolicy";
import { rotationPool } from "../domain/rotationPool";
import {
  beginAnswer,
  expireAll,
  resolve,
  type PermissionRecord,
} from "../domain/permissionRecords";
import {
  createRateLimitDetector,
  type RateLimitDetector,
  type TurnOutcome,
} from "../domain/rateLimit";
import {
  createRotationController,
  mergeRuntime,
  type AccountRuntime,
  type RotationController,
  type RotationPhase,
  type RotationPorts,
  type StartResult,
} from "../domain/rotation";
import {
  createSecretMasker,
  createStreamingMasker,
  type SecretEntry,
  type SecretMasker,
  type StreamingMasker,
} from "../domain/secretMask";
import {
  INITIAL_SESSION_STATE,
  reduceSession,
  type SessionState,
} from "../domain/sessionReducer";
import {
  PermissionProfile,
  ProviderId,
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
import { ProbeStillRunningError } from "./limitProbe";
import { pickOption, toPermissionQuery } from "./permissionQuery";
import type { StopResult } from "./process/container";
import { toSessionView } from "./sessionView";
import { observeViews } from "./sessionViews";
import { configuredExecutable } from "./settingsService";
import type { JsonStore } from "./storage";
import { transitionError } from "./transitionError";

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
  readonly resolveExecutable: (
    provider: ProviderId,
    configured: string | null,
  ) => string;
  readonly stopGraceMs: number;
  readonly containerStatus: ContainerStatus;
  readonly externalRuntime: (accountId: string) => AccountRuntime | null;
  readonly beforeLaunch: (accountId: string) => Promise<void>;
  readonly isBlocked: (accountId: string) => boolean;
  readonly hasKey: (accountId: string) => boolean;
  readonly secrets: (accounts: readonly Account[]) => readonly SecretEntry[];
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
  onViewChanged(listener: (view: SessionView | null) => void): () => void;
  isLive(): boolean;
  isSettled(): boolean;
  setAccounts(accounts: readonly Account[]): void;
  shutdown(): Promise<void>;
}

interface RunSpec {
  readonly cwd: string;
  readonly profile: PermissionProfile;
  readonly flowRef: FlowRef | null;
  readonly model: ModelChoice | null;
}

const INACTIVE_PHASES: readonly RotationPhase["phase"][] = [
  "stopped",
  "halted",
  "failed",
];
const READY: AccountRuntime = { status: "ready" };
const NEEDS_LOGIN: AccountRuntime = { status: "needs_login" };
const PREVIOUS_AGENT_RUNNING_MESSAGE = "The previous agent is still running";
const NO_USABLE_ACCOUNT_MESSAGE = "No usable account";

function startError(
  account: Account,
  result: AgentStartResult,
  mask: (text: string) => string,
): IpcError {
  if (!result.ok && result.reason === AgentStartFailure.needsLogin) {
    return new IpcError(
      IpcErrorCode.CONFLICT,
      `Account ${account.label} needs login`,
    );
  }
  return new IpcError(
    IpcErrorCode.UNAVAILABLE,
    mask(`Could not start the agent: ${result.ok ? "" : result.message}`),
  );
}

function textEventFor(key: string, text: string): AgentEvent {
  return key === NO_MESSAGE_KEY
    ? { type: "text", text }
    : { type: "text", messageId: key, text };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exhaustedOnly(
  deps: SessionServiceDeps,
): (accountId: string) => AccountRuntime | null {
  return (accountId) => {
    const runtime = deps.externalRuntime(accountId);
    return runtime?.status === "exhausted" ? runtime : null;
  };
}

function externalRuntimeOf(
  deps: SessionServiceDeps,
  loginFailures: ReadonlySet<string>,
): (accountId: string) => AccountRuntime | null {
  const exhausted = exhaustedOnly(deps);
  return (accountId) =>
    loginFailures.has(accountId) ? NEEDS_LOGIN : exhausted(accountId);
}

interface SessionRunInit {
  deps: SessionServiceDeps;
  spec: RunSpec;
  provider: ProviderId;
  registered: readonly Account[];
  accounts: readonly Account[];
  initial: Account;
  reserved: Set<string>;
  loginFailures: ReadonlySet<string>;
  onRuntimeSettled: () => void;
}

class SessionRun {
  readonly id = randomUUID();
  readonly provider: ProviderId;
  private readonly deps: SessionServiceDeps;
  private readonly spec: RunSpec;
  private readonly onRuntimeSettled: () => void;
  private readonly reserved: Set<string>;
  private readonly loginFailures: ReadonlySet<string>;
  private readonly controller: RotationController;
  private accounts: readonly Account[];
  private registered: readonly Account[];
  private readonly streaming: StreamingMasker = createStreamingMasker(() =>
    this.secretMasker(),
  );
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
    provider,
    registered,
    accounts,
    initial,
    reserved,
    loginFailures,
    onRuntimeSettled,
  }: SessionRunInit) {
    this.deps = deps;
    this.reserved = reserved;
    this.loginFailures = loginFailures;
    this.provider = provider;
    this.onRuntimeSettled = onRuntimeSettled;
    this.spec = spec;
    this.registered = registered;
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
        externalRuntime: externalRuntimeOf(deps, loginFailures),
      },
      accounts,
      initial.id,
      this.id,
    );
  }

  async begin(account: Account): Promise<AgentStartResult> {
    const result = await this.launch(account);
    if (!result.ok) {
      this.controller.dispose();
      return result;
    }
    this.controller.subscribe(() => {
      this.publish();
      this.onRuntimeSettled();
    });
    return result;
  }

  view(): SessionView {
    return toSessionView({
      id: this.id,
      cwd: this.spec.cwd,
      provider: this.provider,
      accounts: this.registered,
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

  isSettled(): boolean {
    const idle = this.activeTurns === 0 && this.launching.size === 0;
    return idle && this.phase().phase === "running" && !this.controller.busy();
  }

  hasAgents(): boolean {
    return this.handles.size > 0;
  }

  isInUse(accountId: string): boolean {
    return this.controller.busy() || this.handles.has(accountId);
  }

  ownRuntimeOf(accountId: string): AccountRuntime | null {
    return (
      this.controller.runtime().get(accountId) ??
      (this.loginFailures.has(accountId) ? NEEDS_LOGIN : null)
    );
  }

  runtime(): ReadonlyMap<string, AccountRuntime> {
    return this.controller.runtime();
  }

  maskText(text: string): string {
    return this.secretMasker().mask(text);
  }

  private maskedText(error: unknown): string {
    return this.maskText(errorText(error));
  }

  setAccounts(accounts: readonly Account[]): void {
    this.registered = accounts;
    this.accounts = rotationPool(this.provider, accounts);
    this.controller.setAccounts(this.accounts);
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
          console.error(
            `failed to stop ${accountId}: ${this.maskedText(error)}`,
          );
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
    this.reserved.add(account.id);
    try {
      return await this.reserveAndStart(account);
    } finally {
      this.reserved.delete(account.id);
    }
  }

  private async reserveAndStart(account: Account): Promise<AgentStartResult> {
    try {
      await this.deps.beforeLaunch(account.id);
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof ProbeStillRunningError
            ? AgentStartFailure.unavailable
            : AgentStartFailure.error,
        message: errorText(error),
      };
    }
    const settings = await this.deps.store.readSettings();
    const result = await this.deps.adapter.start({
      account,
      cwd: this.spec.cwd,
      profile: this.spec.profile,
      runId: this.deps.newRunId(),
      executable: this.deps.resolveExecutable(
        account.provider,
        configuredExecutable(settings, account.provider),
      ),
    });
    if (!result.ok) {
      return result;
    }
    if (this.closed) {
      const stopped = await this.haltHandle(result.handle);
      if (!stopped.ok) {
        this.handles.set(result.handle.accountId, result.handle);
      }
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
      console.warn(
        `cancel before stop failed: ${handle.runId}: ${this.maskedText(error)}`,
      );
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
    console.error(
      `failed to start ${accountId}: ${this.maskText(result.message)}`,
    );
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
      console.error(`turn failed on ${accountId}: ${this.maskedText(error)}`);
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
    const model = explicitModelOn(this.registered, accountId, this.spec.model);
    try {
      await handle.prompt(text, { model });
    } catch (error) {
      console.error(`prompt failed on ${accountId}: ${this.maskedText(error)}`);
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
    for (const safe of this.sanitize(event)) {
      this.applyEvent(handle, safe);
    }
  }

  private sanitize(event: AgentEvent): AgentEvent[] {
    if (event.type === "text") {
      const text = this.streaming.push(
        event.messageId ?? NO_MESSAGE_KEY,
        event.text,
      );
      return text === "" ? [] : [{ ...event, text }];
    }
    return [
      ...this.streaming
        .flushAll()
        .map(({ key, text }) => textEventFor(key, text)),
      this.secretMasker().maskDeep(event),
    ];
  }

  private secretMasker(): SecretMasker {
    return createSecretMasker(this.deps.secrets(this.registered));
  }

  private applyEvent(handle: AgentHandle, event: AgentEvent): void {
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
      console.warn(
        `auto answer failed: ${event.requestId}: ${this.maskedText(error)}`,
      );
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
      console.error(
        `permission decision failed: ${event.requestId}: ${this.maskedText(error)}`,
      );
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

interface CreatedRun {
  readonly run: SessionRun;
  readonly initial: Account;
}

interface RunWiring {
  readonly runtimeOf: (accountId: string) => AccountRuntime;
  readonly reserved: Set<string>;
  readonly loginFailures: ReadonlySet<string>;
  readonly onRuntimeSettled: () => void;
}

function canStartWith(
  deps: SessionServiceDeps,
  wiring: RunWiring,
  account: Account,
): boolean {
  const keyed =
    account.provider !== ProviderId.opencode || deps.hasKey(account.id);
  return (
    keyed &&
    !wiring.loginFailures.has(account.id) &&
    !deps.isBlocked(account.id) &&
    isUsable(wiring.runtimeOf(account.id), deps.now())
  );
}

async function createRun(
  deps: SessionServiceDeps,
  params: ParamsMap["session/start"],
  wiring: RunWiring,
): Promise<CreatedRun> {
  const registered = (await deps.store.readAccounts()).toSorted(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
  const provider = params.provider ?? registered[0]?.provider;
  if (provider === undefined) {
    throw new IpcError(IpcErrorCode.CONFLICT, NO_USABLE_ACCOUNT_MESSAGE);
  }
  const accounts = rotationPool(provider, registered);
  const initial = accounts.find((account) =>
    canStartWith(deps, wiring, account),
  );
  if (initial === undefined) {
    throw new IpcError(IpcErrorCode.CONFLICT, NO_USABLE_ACCOUNT_MESSAGE);
  }
  const settings = await deps.store.readSettings();
  const run = new SessionRun({
    deps,
    spec: {
      cwd: params.cwd,
      profile: params.profile ?? settings.permissionProfile,
      flowRef: params.flowRef ?? null,
      model: params.model ?? null,
    },
    provider,
    registered,
    accounts,
    initial,
    reserved: wiring.reserved,
    loginFailures: wiring.loginFailures,
    onRuntimeSettled: wiring.onRuntimeSettled,
  });
  return { run, initial };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const views = observeViews(deps.broadcast);
  const observed: SessionServiceDeps = { ...deps, broadcast: views.broadcast };
  let run: SessionRun | null = null;
  let opening: SessionRun | null = null;
  let starting = false;
  const reserved = new Set<string>();
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
  const exhaustedProbe = exhaustedOnly(deps);
  const ownRuntimeOf = (accountId: string): AccountRuntime | null =>
    run?.ownRuntimeOf(accountId) ?? null;
  const runtimeOf = (accountId: string): AccountRuntime =>
    mergeRuntime(
      ownRuntimeOf(accountId),
      deps.externalRuntime(accountId),
      deps.now(),
    );
  const startRuntimeOf = (accountId: string): AccountRuntime =>
    mergeRuntime(
      ownRuntimeOf(accountId),
      exhaustedProbe(accountId),
      deps.now(),
    );
  const openRun = async (
    params: ParamsMap["session/start"],
    loginFailures: ReadonlySet<string>,
  ): Promise<CreatedRun> => {
    opening = null;
    const created = await createRun(observed, params, {
      runtimeOf: startRuntimeOf,
      reserved,
      loginFailures,
      onRuntimeSettled: checkRuntime,
    });
    opening = created.run;
    return created;
  };
  const isLoginFailure = (
    result: AgentStartResult,
    account: Account,
  ): boolean =>
    !result.ok &&
    result.reason === AgentStartFailure.needsLogin &&
    account.provider === ProviderId.opencode;
  const isRetryable = (result: AgentStartResult, initial: Account): boolean =>
    isLoginFailure(result, initial) ||
    (!result.ok &&
      result.reason === AgentStartFailure.unavailable &&
      deps.isBlocked(initial.id));
  const reopen = async (
    params: ParamsMap["session/start"],
    loginFailures: ReadonlySet<string>,
    failed: CreatedRun,
    result: AgentStartResult,
  ): Promise<CreatedRun> => {
    try {
      return await openRun(params, loginFailures);
    } catch (error) {
      const exhausted =
        error instanceof IpcError && error.code === IpcErrorCode.CONFLICT;
      if (exhausted && loginFailures.has(failed.initial.id)) {
        throw startError(failed.initial, result, (text) =>
          failed.run.maskText(text),
        );
      }
      throw error;
    }
  };
  const beginRun = async (
    params: ParamsMap["session/start"],
  ): Promise<{ created: CreatedRun; result: AgentStartResult }> => {
    const loginFailures = new Set<string>();
    let created = await openRun(params, loginFailures);
    let result = await created.run.begin(created.initial);
    while (isRetryable(result, created.initial)) {
      if (isLoginFailure(result, created.initial)) {
        loginFailures.add(created.initial.id);
      }
      created = await reopen(params, loginFailures, created, result);
      result = await created.run.begin(created.initial);
    }
    return { created, result };
  };
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
        const { created, result } = await beginRun(params);
        if (!result.ok) {
          throw startError(created.initial, result, (text) =>
            created.run.maskText(text),
          );
        }
        run = created.run;
      } finally {
        opening = null;
        starting = false;
      }
      const view = run.view();
      observed.broadcast("session/changed", view);
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
    onViewChanged: views.listen,
    isLive: () => starting || (run?.isLive() ?? false),
    isSettled: () => run?.isSettled() ?? false,
    answerPermission: (requestId, optionId) => {
      requireRun().answerPermission(requestId, optionId);
    },
    isInUse: (accountId) =>
      reserved.has(accountId) ||
      (opening?.isInUse(accountId) ?? false) ||
      (run?.isInUse(accountId) ?? false),
    runtimeOf,
    setAccounts: (next) => {
      run?.setAccounts(next);
    },
    shutdown: async () => {
      await run?.close();
    },
  };
}
