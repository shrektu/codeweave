import { randomUUID } from "node:crypto";

import { PROVIDER_IMAGE_INPUT } from "../domain/attachments";
import {
  DEFAULT_MAX_RESULT_CHARS,
  NO_MESSAGE_KEY,
  RATE_LIMIT_STATUS_REJECTED,
} from "../domain/constants";
import {
  buildContextPackage,
  ContextPackageReason,
  promptText,
} from "../domain/contextPackage";
import type { AgentEvent } from "../domain/events";
import { mergeLimitWindows, type LimitWindow } from "../domain/limitWindows";
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
  applyServedModel,
  recordPrompt,
  reduceSession,
  resetServedState,
  type SessionState,
} from "../domain/sessionReducer";
import {
  PermissionProfile,
  ProviderId,
  type Account,
  type SwitchLogEntry,
} from "../domain/types";
import { PROVIDER_DISPLAY_NAMES } from "../shared/constants";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type {
  AttachmentView,
  FlowRef,
  LimitView,
  NativeSessionRef,
  SessionView,
} from "../shared/views";

import type { AccountReservations } from "./accountReservations";
import {
  AgentStartFailure,
  UnknownPermissionError,
  type AgentHandle,
  type AgentToolAccess,
  type AgentStartResult,
  type PromptImage,
} from "./agentAdapter";
import { createInFlight } from "./inFlight";
import { PROCESS_EXITED_MESSAGE, SESSION_CLOSED_MESSAGE } from "./constants";
import { ProbeStillRunningError } from "./limitProbe";
import type { LeaseMode } from "./locks";
import { pickOption, toPermissionQuery } from "./permissionQuery";
import { realPermissionContext, withRealPaths } from "./permissionScope";
import type { StopResult } from "./process/container";
import type { SessionServiceDeps, ResumeSeed } from "./session";
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
  readonly explicitFolder: boolean;
  readonly profile: PermissionProfile;
  readonly flowRef: FlowRef | null;
  readonly tools: AgentToolAccess | null;
  readonly preamble: string | null;
  readonly resume?: readonly NativeSessionRef[];
}

const INACTIVE_PHASES: readonly RotationPhase["phase"][] = [
  "stopped",
  "halted",
  "failed",
];
const NEEDS_LOGIN: AccountRuntime = { status: "needs_login" };
const PREAMBLE_SEPARATOR = "\n\n";
const TOOL_TOKEN_LABEL = "flow tool token";
const COMPACT_PROMPT_TEXT = "/compact";

const TurnKind = {
  prompt: "prompt",
  compact: "compact",
} as const;
type TurnKind = (typeof TurnKind)[keyof typeof TurnKind];

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
  leaseMode: LeaseMode;
  reserved: AccountReservations;
  loginFailures: ReadonlySet<string>;
  onRuntimeSettled: () => void;
  resume?: ResumeSeed;
}

export class SessionRun {
  readonly id: string;
  readonly createdAt: number;
  readonly provider: ProviderId;
  private readonly deps: SessionServiceDeps;
  private readonly spec: RunSpec;
  private readonly leaseMode: LeaseMode;
  private readonly onRuntimeSettled: () => void;
  private readonly reserved: AccountReservations;
  private readonly loginFailures: ReadonlySet<string>;
  private readonly controller: RotationController;
  private accounts: readonly Account[];
  private registered: readonly Account[];
  private readonly streaming: StreamingMasker = createStreamingMasker(() =>
    this.secretMasker(),
  );
  private state: SessionState;
  private resumeContext: string | null;
  private currentPrompt: CurrentPrompt = NO_PROMPT;
  private readonly limits = new Map<string, LimitView>();
  private readonly handles = new Map<string, AgentHandle>();
  private readonly nativeByAccount = new Map<string, string>();
  private readonly retired = new WeakSet<AgentHandle>();
  private readonly briefed = new WeakSet<AgentHandle>();
  private readonly deciding = new Set<string>();
  private readonly launching = createInFlight();
  private readonly logging = createInFlight();
  private current: AgentHandle | null = null;
  private detector: RateLimitDetector | null = null;
  private activeTurns = 0;
  private claiming = false;
  private compacting = false;
  private compactionHandoff: string | null = null;
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
    leaseMode,
    reserved,
    loginFailures,
    onRuntimeSettled,
    resume,
  }: SessionRunInit) {
    this.deps = deps;
    this.id = resume?.id ?? randomUUID();
    this.createdAt = resume?.createdAt ?? deps.now();
    this.state = resume?.state ?? INITIAL_SESSION_STATE;
    this.resumeContext = resume?.contextPackage ?? null;
    (resume?.nativeSessions ?? []).forEach((entry) => {
      this.nativeByAccount.set(entry.accountId, entry.nativeSessionId);
    });
    this.leaseMode = leaseMode;
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
    const phase = this.phase();
    return toSessionView({
      id: this.id,
      createdAt: this.createdAt,
      cwd: this.spec.cwd,
      explicitFolder: this.spec.explicitFolder,
      provider: this.provider,
      accounts: this.registered,
      profile: this.spec.profile,
      phase,
      state: this.state,
      limits: [...this.limits.values()],
      turnInFlight: this.activeTurns > 0 || this.claiming,
      canCompact:
        this.current?.compact !== undefined && phase.phase === "running",
      flowRef: this.spec.flowRef,
      orchestrate: this.spec.tools !== null,
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
    const idle =
      this.activeTurns === 0 && !this.claiming && this.launching.size() === 0;
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

  nativeSessions(): readonly NativeSessionRef[] {
    const ids = new Map(this.nativeByAccount);
    this.handles.forEach((handle) => {
      if (handle.nativeSessionId !== null) {
        ids.set(handle.accountId, handle.nativeSessionId);
      }
    });
    return [...ids].map(([accountId, nativeSessionId]) => ({
      accountId,
      nativeSessionId,
    }));
  }

  private maskedText(error: unknown): string {
    return this.maskText(errorText(error));
  }

  setAccounts(accounts: readonly Account[]): void {
    this.registered = accounts;
    this.accounts = rotationPool(this.provider, accounts);
    this.controller.setAccounts(this.accounts);
  }

  async prompt(text: string, overrides: PromptOverrides = {}): Promise<void> {
    const phase = this.phase();
    if (
      phase.phase !== "running" ||
      this.activeTurns > 0 ||
      this.claiming ||
      this.controller.busy()
    ) {
      throw this.busyError();
    }
    const attachments = overrides.attachments ?? [];
    const provider = this.providerOf(phase.accountId);
    if (attachments.length > 0 && !PROVIDER_IMAGE_INPUT[provider]) {
      throw new IpcError(
        IpcErrorCode.VALIDATION,
        `${PROVIDER_DISPLAY_NAMES[provider]} does not accept images`,
      );
    }
    this.claiming = true;
    this.compacting = false;
    this.publish();
    try {
      const images =
        attachments.length === 0 ? [] : await this.claimImages(attachments);
      const current = this.phase();
      if (
        this.closed ||
        current.phase !== "running" ||
        current.accountId !== phase.accountId
      ) {
        throw this.busyError();
      }
      const begun = beginPrompt(this.state, overrides);
      this.state = recordPrompt(
        begun.state,
        begun.prompt.seq,
        this.maskText(text),
        attachments,
      );
      this.currentPrompt = begun.prompt;
      const prefix = this.promptPrefix();
      void this.userTurn(current.accountId, text, prefix, images);
    } finally {
      this.claiming = false;
      this.publish();
    }
  }

  compact(): Promise<void> {
    const phase = this.phase();
    if (
      phase.phase !== "running" ||
      this.activeTurns > 0 ||
      this.claiming ||
      this.controller.busy()
    ) {
      throw this.busyError();
    }
    const provider = this.providerOf(phase.accountId);
    if (this.current?.compact === undefined) {
      throw new IpcError(
        IpcErrorCode.VALIDATION,
        `${PROVIDER_DISPLAY_NAMES[provider]} cannot compact the conversation`,
      );
    }
    this.claiming = true;
    this.publish();
    try {
      const current = this.phase();
      if (
        this.closed ||
        current.phase !== "running" ||
        current.accountId !== phase.accountId
      ) {
        throw this.busyError();
      }
      const begun = beginPrompt(this.state, {});
      this.state = recordPrompt(
        begun.state,
        begun.prompt.seq,
        this.maskText(COMPACT_PROMPT_TEXT),
      );
      this.currentPrompt = begun.prompt;
      void this.userTurn(
        current.accountId,
        COMPACT_PROMPT_TEXT,
        null,
        [],
        TurnKind.compact,
      );
    } finally {
      this.claiming = false;
      this.publish();
    }
    return Promise.resolve();
  }

  private promptPrefix(): string | null {
    if (this.compactionHandoff !== null) {
      return this.compactionHandoff;
    }
    return this.resumeContext === null || this.current?.resumed === true
      ? null
      : this.resumeContext;
  }

  private busyError(): IpcError {
    return new IpcError(
      IpcErrorCode.SESSION_BUSY,
      "The session cannot take a prompt right now",
    );
  }

  private providerOf(accountId: string): ProviderId {
    return (
      this.accounts.find((account) => account.id === accountId)?.provider ??
      this.provider
    );
  }

  private claimImages(
    attachments: readonly AttachmentView[],
  ): Promise<PromptImage[]> {
    return Promise.all(
      attachments.map(async (attachment) => ({
        path: await this.deps.attachments.claim(this.id, attachment),
        mimeType: attachment.mimeType,
        name: attachment.name,
      })),
    );
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
    this.compacting = false;
    this.compactionHandoff = null;
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
    this.deps.publishView(this.view());
  }

  private launch(account: Account): Promise<AgentStartResult> {
    return this.launching.track(() => this.spawnAgent(account));
  }

  private async spawnAgent(account: Account): Promise<AgentStartResult> {
    const release = this.reserved.reserve(account.id);
    try {
      return await this.reserveAndStart(account);
    } finally {
      release();
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
    const result = await this.startAdapter(account);
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

  private async startAdapter(account: Account): Promise<AgentStartResult> {
    const settings = await this.deps.store.readSettings();
    const runId = this.deps.newRunId();
    const nativeSessionId = this.nativeByAccount.get(account.id);
    this.deps.leaseModes.set(runId, this.leaseMode);
    try {
      return await this.deps.adapter.start({
        account,
        cwd: this.spec.cwd,
        profile: this.spec.profile,
        runId,
        executable: this.deps.resolveExecutable(
          account.provider,
          configuredExecutable(settings, account.provider),
        ),
        ...(this.spec.tools === null ? {} : { tools: this.spec.tools }),
        ...(nativeSessionId === undefined
          ? {}
          : { resume: { nativeSessionId } }),
      });
    } finally {
      this.deps.leaseModes.clear(runId);
    }
  }

  private register(handle: AgentHandle): void {
    this.handles.set(handle.accountId, handle);
    if (handle.nativeSessionId !== null) {
      this.nativeByAccount.set(handle.accountId, handle.nativeSessionId);
    }
    this.state = resetServedState(this.state);
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
    if (handle.nativeSessionId !== null) {
      this.nativeByAccount.set(accountId, handle.nativeSessionId);
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
      reason: ContextPackageReason.rotation,
      userPrompts: this.state.prompts.map(promptText),
      lastReply: null,
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

  private async userTurn(
    accountId: string,
    text: string,
    prefix: string | null,
    images: readonly PromptImage[] = [],
    kind: TurnKind = TurnKind.prompt,
  ): Promise<void> {
    this.activeTurns += 1;
    this.compacting = kind === TurnKind.compact;
    try {
      const outcome = await this.runTurn(accountId, text, prefix, images, kind);
      await this.controller.onTurnSettled(accountId, outcome);
    } catch (error) {
      console.error(`turn failed on ${accountId}: ${this.maskedText(error)}`);
    } finally {
      if (
        kind !== TurnKind.compact ||
        this.controller.phase().phase !== "waiting"
      ) {
        this.compacting = false;
      }
      this.activeTurns -= 1;
      this.publish();
      this.onRuntimeSettled();
    }
  }

  private async runTurn(
    accountId: string,
    text: string,
    prefix: string | null = null,
    images: readonly PromptImage[] = [],
    kind: TurnKind = TurnKind.prompt,
  ): Promise<TurnOutcome> {
    if (kind === TurnKind.prompt && this.compacting) {
      this.compactionHandoff = text;
      this.compacting = false;
      return { kind: "ok" };
    }
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
      if (kind === TurnKind.compact) {
        await this.compactHandle(handle);
      } else {
        await handle.prompt(this.briefedText(handle, text, prefix), {
          model,
          ...(images.length === 0 ? {} : { images }),
        });
        this.resumeContext = null;
        this.compactionHandoff = null;
      }
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
      this.recordExhausted(accountId, detector, outcome);
    }
    this.publish();
    return outcome;
  }

  private compactHandle(handle: AgentHandle): Promise<void> {
    if (handle.compact === undefined) {
      throw new IpcError(
        IpcErrorCode.VALIDATION,
        `${PROVIDER_DISPLAY_NAMES[this.providerOf(handle.accountId)]} cannot compact the conversation`,
      );
    }
    return handle.compact();
  }

  private recordExhausted(
    accountId: string,
    detector: RateLimitDetector,
    outcome: Extract<TurnOutcome, { kind: "exhausted" }>,
  ): void {
    this.limits.set(accountId, {
      accountId,
      status: RATE_LIMIT_STATUS_REJECTED,
      resetsAt: outcome.resetsAt,
      rateLimitType: outcome.rateLimitType,
      utilization: detector.snapshot()?.utilization ?? null,
      windows: this.mergedWindows(
        accountId,
        detector.snapshot()?.windows ?? [],
      ),
      observedAt: this.deps.now(),
    });
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

  private briefedText(
    handle: AgentHandle,
    text: string,
    prefix: string | null,
  ): string {
    const { preamble } = this.spec;
    const parts = prefix === null ? [] : [prefix];
    if (preamble !== null && !this.briefed.has(handle)) {
      this.briefed.add(handle);
      parts.push(preamble);
    }
    parts.push(text);
    return parts.join(PREAMBLE_SEPARATOR);
  }

  private secretMasker(): SecretMasker {
    const { tools } = this.spec;
    return createSecretMasker([
      ...this.deps.secrets(this.registered),
      ...(tools === null
        ? []
        : [{ value: tools.token, label: TOOL_TOKEN_LABEL }]),
    ]);
  }

  private applyEvent(handle: AgentHandle, event: AgentEvent): void {
    this.state =
      event.type === "model"
        ? applyServedModel(this.state, event.model, handle.accountId)
        : reduceSession(this.state, event);
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

  private mergedWindows(
    accountId: string,
    next: readonly LimitWindow[],
  ): LimitWindow[] {
    return mergeLimitWindows(this.limits.get(accountId)?.windows ?? [], next);
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
        windows: this.mergedWindows(accountId, snapshot.windows),
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
      const context = await realPermissionContext({
        worktreeRoot: await this.rootOfWorktree(),
        homeDir: this.deps.homeDir,
        protectedPaths: await this.deps.protectedPaths(),
      });
      const query = await withRealPaths(
        toPermissionQuery(event, this.spec.cwd),
        context,
      );
      const decision = decidePermission(query, this.spec.profile, context);
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
