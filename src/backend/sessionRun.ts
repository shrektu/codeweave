import { randomUUID } from "node:crypto";

import {
  DEFAULT_MAX_RESULT_CHARS,
  NO_MESSAGE_KEY,
  RATE_LIMIT_STATUS_REJECTED,
} from "../domain/constants";
import { buildContextPackage } from "../domain/contextPackage";
import type { AgentEvent } from "../domain/events";
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
  type AccountRuntime,
  type RotationController,
  type RotationPhase,
  type StartResult,
} from "../domain/rotation";
import {
  createSecretMasker,
  createStreamingMasker,
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
  type SwitchLogEntry,
} from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type { FlowRef, LimitView, SessionView } from "../shared/views";

import {
  AgentStartFailure,
  UnknownPermissionError,
  type AgentHandle,
  type AgentStartResult,
} from "./agentAdapter";
import { createInFlight } from "./inFlight";
import { PROCESS_EXITED_MESSAGE, SESSION_CLOSED_MESSAGE } from "./constants";
import { ProbeStillRunningError } from "./limitProbe";
import { pickOption, toPermissionQuery } from "./permissionQuery";
import type { StopResult } from "./process/container";
import type { SessionServiceDeps } from "./session";
import { toSessionView } from "./sessionView";
import { configuredExecutable } from "./settingsService";
import { transitionError } from "./transitionError";
import {
  beginPrompt,
  NO_PROMPT,
  recordTurn,
  type CurrentPrompt,
  type PromptOverrides,
  type TurnRoutingSpec,
} from "./turnRouting";

type PermissionRequest = Extract<AgentEvent, { type: "permission_request" }>;

interface RunSpec extends TurnRoutingSpec {
  readonly cwd: string;
  readonly profile: PermissionProfile;
  readonly flowRef: FlowRef | null;
}

const INACTIVE_PHASES: readonly RotationPhase["phase"][] = [
  "stopped",
  "halted",
  "failed",
];
const NEEDS_LOGIN: AccountRuntime = { status: "needs_login" };

function textEventFor(key: string, text: string): AgentEvent {
  return key === NO_MESSAGE_KEY
    ? { type: "text", text }
    : { type: "text", messageId: key, text };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exhaustedOnly(
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

export class SessionRun {
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
  private currentPrompt: CurrentPrompt = NO_PROMPT;
  private readonly limits = new Map<string, LimitView>();
  private readonly handles = new Map<string, AgentHandle>();
  private readonly retired = new WeakSet<AgentHandle>();
  private readonly deciding = new Set<string>();
  private readonly launching = createInFlight();
  private readonly logging = createInFlight();
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
    const idle = this.activeTurns === 0 && this.launching.size() === 0;
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

  prompt(text: string, overrides: PromptOverrides = {}): void {
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
    const begun = beginPrompt(this.state, overrides);
    this.state = begun.state;
    this.currentPrompt = begun.prompt;
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

  markClosed(): void {
    this.closed = true;
  }

  async close(): Promise<void> {
    await this.discard();
    this.publish();
  }

  async discard(): Promise<void> {
    this.closed = true;
    await this.launching.settled();
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
    await Promise.all([this.launching.settled(), this.logging.settled()]);
    this.failure = null;
    this.state = {
      ...this.state,
      permissions: expireAll(this.state.permissions),
    };
  }

  private publish(): void {
    this.deps.broadcast("session/changed", this.view());
  }

  private launch(account: Account): Promise<AgentStartResult> {
    return this.launching.track(() => this.spawnAgent(account));
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

  private logSwitch(entry: SwitchLogEntry): Promise<void> {
    return this.logging.track(async () => {
      await this.deps.store.appendSwitchLog(entry);
      this.deps.broadcast("switchLog/appended", entry);
    });
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
    const routed = recordTurn({
      state: this.state,
      accounts: this.registered,
      accountId,
      spec: this.spec,
      prompt: this.currentPrompt,
    });
    this.state = routed.state;
    const { model } = routed;
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
      if (optionId !== null && this.isPending(event.requestId)) {
        this.answerPermission(event.requestId, optionId);
      }
    } catch (error) {
      console.warn(
        `auto answer failed: ${event.requestId}: ${this.maskedText(error)}`,
      );
    }
    this.publish();
  }

  private isPending(requestId: string): boolean {
    return this.state.permissions.some(
      (record) => record.requestId === requestId && record.state === "pending",
    );
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
