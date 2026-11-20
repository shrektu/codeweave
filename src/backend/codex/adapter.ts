import { randomUUID } from "node:crypto";

import type { z } from "zod";

import type { AgentEvent } from "../../domain/events";
import { ERROR_KIND_RATE_LIMIT } from "../../domain/constants";
import type { PermissionProfile } from "../../domain/types";
import {
  AgentStartFailure,
  InvalidOptionError,
  TurnInProgressError,
  UnknownPermissionError,
  type AgentAdapter,
  type AgentHandle,
  type AgentStartResult,
  type AgentStartSpec,
  type TurnOptions,
} from "../agentAdapter";
import type { AgentProcess, AgentProcesses } from "../agentProcesses";
import {
  DEFAULT_STOP_GRACE_MS,
  PROCESS_EXITED_MESSAGE,
  STDERR_TAIL_CHARS,
} from "../constants";
import type { StopResult } from "../process/container";

import {
  APPROVALS_REVIEWER_USER,
  CodexDecision,
  CodexMethod,
  CodexNotification,
  CodexPermissionChoice,
  CodexPermissionScope,
  CodexServerRequest,
  CodexTurnStatus,
  DEFAULT_RATE_LIMIT_READ_TIMEOUT_MS,
  NEEDS_LOGIN_MESSAGE,
  RPC_CODE_INVALID_PARAMS,
  RPC_CODE_METHOD_NOT_FOUND,
  RPC_CODE_PEER_CLOSED,
  RPC_MESSAGE_INVALID_PARAMS,
  RPC_MESSAGE_METHOD_NOT_FOUND,
  STOP_REASON_CANCELLED,
  STOP_REASON_END_TURN,
  TURN_FAILED_MESSAGE,
} from "./constants";
import {
  EMPTY_RATE_LIMITS,
  commandPermission,
  fileChangeOf,
  fileChangePermission,
  mapAgentMessageDelta,
  mapItemCompleted,
  mapItemStarted,
  mapTurnError,
  mergeRateLimits,
  permissionsPermission,
  policyFor,
  replaceRateLimits,
  sandboxPolicyFor,
  toRateLimitEvent,
  type ProfilePolicy,
  type RateLimitState,
} from "./events";
import { openCodexAccount, withTimeout } from "./handshake";
import { buildCodexLaunch } from "./launch";
import {
  AccountRateLimitsUpdatedSchema,
  AgentMessageDeltaParamsSchema,
  CommandApprovalParamsSchema,
  EmptyResultSchema,
  ErrorNotificationParamsSchema,
  FileChangeApprovalParamsSchema,
  ItemNotificationParamsSchema,
  ModelReroutedParamsSchema,
  PermissionsApprovalParamsSchema,
  RateLimitsReadResponseSchema,
  ThreadStartResponseSchema,
  TurnCompletedParamsSchema,
  TurnStartResponseSchema,
  type Turn,
  type TurnCompletedParams,
} from "./protocol";
import {
  CodexRpcError,
  createCodexRpc,
  type CodexRpc,
  type RpcId,
} from "./rpc";

export interface CodexAdapterDeps {
  readonly processes: AgentProcesses;
  readonly envFor: (spec: AgentStartSpec) => Record<string, string>;
  readonly executableFor: (spec: AgentStartSpec) => string;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string;
  readonly stopGraceMs?: number;
  readonly rateLimitReadTimeoutMs?: number;
}

type Listener = (event: AgentEvent) => void;
type PermissionRequestEvent = Extract<
  AgentEvent,
  { type: "permission_request" }
>;

interface ApprovalAnswers {
  readonly resultFor: (optionId: string) => unknown;
  readonly declined: unknown;
}

interface PendingApproval extends ApprovalAnswers {
  readonly rpcId: RpcId;
  readonly optionIds: ReadonlySet<string>;
}

interface ActiveTurn {
  turnId: string | null;
  readonly idReady: PromiseWithResolvers<string | null>;
  readonly completed: PromiseWithResolvers<TurnCompletedParams>;
}

class ProcessExitedError extends Error {
  constructor() {
    super(PROCESS_EXITED_MESSAGE);
    this.name = "ProcessExitedError";
  }
}

class CodexNeedsLoginError extends Error {
  constructor() {
    super(NEEDS_LOGIN_MESSAGE);
    this.name = "CodexNeedsLoginError";
  }
}

const DECISION_ANSWERS: ApprovalAnswers = {
  resultFor: (optionId) => ({ decision: optionId }),
  declined: { decision: CodexDecision.decline },
};

const DENIED_PERMISSIONS = {
  permissions: {},
  scope: CodexPermissionScope.turn,
};

function permissionAnswers(
  requested: Readonly<Record<string, unknown>>,
): ApprovalAnswers {
  return {
    resultFor: (optionId) =>
      optionId === CodexPermissionChoice.grant
        ? { permissions: requested, scope: CodexPermissionScope.turn }
        : DENIED_PERMISSIONS,
    declined: DENIED_PERMISSIONS,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPeerClosed(error: unknown): boolean {
  return error instanceof CodexRpcError && error.code === RPC_CODE_PEER_CLOSED;
}

function exitedEvent(): AgentEvent {
  return {
    type: "turn_error",
    errorKind: null,
    rpcCode: null,
    message: PROCESS_EXITED_MESSAGE,
  };
}

function newActiveTurn(): ActiveTurn {
  return {
    turnId: null,
    idReady: Promise.withResolvers<string | null>(),
    completed: Promise.withResolvers<TurnCompletedParams>(),
  };
}

class CodexAppServerSession implements AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  private readonly agentProcess: AgentProcess;
  private readonly rpc: CodexRpc;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly fileChangePaths = new Map<string, string[]>();
  private readonly exitSignal: Promise<void>;
  private readonly rateLimitReadTimeoutMs: number;
  private resolveExit: () => void = () => undefined;
  private threadId = "";
  private model: string | null = null;
  private reportedModel: string | null = null;
  private readonly stopGraceMs: number;
  private appliedPolicy: ProfilePolicy;
  private policy: ProfilePolicy;
  private limits: RateLimitState = EMPTY_RATE_LIMITS;
  private limitsRevision = 0;
  private limitsAnnounced = true;
  private stderrText = "";
  private exited = false;
  private exitEmitted = false;
  private stopping = false;
  private turn: Promise<void> | null = null;
  private active: ActiveTurn | null = null;

  constructor(
    spec: AgentStartSpec,
    agentProcess: AgentProcess,
    rateLimitReadTimeoutMs: number,
    stopGraceMs: number,
  ) {
    this.accountId = spec.account.id;
    this.runId = spec.runId;
    this.agentProcess = agentProcess;
    this.rateLimitReadTimeoutMs = rateLimitReadTimeoutMs;
    this.stopGraceMs = stopGraceMs;
    this.appliedPolicy = policyFor(spec.profile);
    this.policy = this.appliedPolicy;
    this.exitSignal = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.watchProcess();
    const { contained } = agentProcess;
    this.rpc = createCodexRpc(contained.stdout, contained.stdin);
    this.rpc.onNotification((method, params) => {
      this.onNotification(method, params);
    });
    this.rpc.onServerRequest((id, method, params) => {
      this.onServerRequest(id, method, params);
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string, options: TurnOptions): Promise<void> {
    if (this.turn !== null) {
      throw new TurnInProgressError(this.runId);
    }
    const current = this.runTurn(text, options);
    this.turn = current;
    await current.finally(() => {
      this.turn = this.turn === current ? null : this.turn;
    });
  }

  async handshake(spec: AgentStartSpec): Promise<void> {
    await this.untilExit(this.negotiate(spec));
  }

  stderrTail(): string {
    return this.stderrText;
  }

  answerPermission(requestId: string, optionId: string): void {
    const request = this.takePending(requestId, optionId);
    this.rpc.respond(request.rpcId, request.resultFor(optionId));
  }

  private takePending(requestId: string, optionId: string): PendingApproval {
    const request = this.pending.get(requestId);
    if (request === undefined) {
      throw new UnknownPermissionError(requestId);
    }
    if (!request.optionIds.has(optionId)) {
      throw new InvalidOptionError(requestId, optionId);
    }
    this.pending.delete(requestId);
    return request;
  }

  private watchProcess(): void {
    const { contained } = this.agentProcess;
    contained.stdin.on("error", (error: Error) => {
      console.warn(`codex stdin error: ${this.runId}`, error);
    });
    contained.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = `${this.stderrText}${chunk.toString()}`.slice(
        -STDERR_TAIL_CHARS,
      );
    });
    contained.onExit(() => {
      this.handleExit();
    });
  }

  setProfile(profile: PermissionProfile): Promise<void> {
    this.policy = policyFor(profile);
    return Promise.resolve();
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (this.exited || active === null) {
      return;
    }
    try {
      await this.untilExit(
        withTimeout(this.interruptActive(active), this.stopGraceMs),
      );
    } catch (error) {
      if (!(error instanceof ProcessExitedError)) {
        console.warn(`cancel did not complete: ${this.runId}`, error);
      }
    }
  }

  private async interruptActive(active: ActiveTurn): Promise<void> {
    const turnId = active.turnId ?? (await active.idReady.promise);
    if (turnId !== null && !this.exited) {
      await this.interrupt(turnId);
    }
  }

  async stop(graceMs: number): Promise<StopResult> {
    this.stopping = true;
    this.cancelPending();
    await this.interruptRunningTurn(graceMs).catch((error: unknown) => {
      console.warn(`cancel before stop failed: ${this.runId}`, error);
    });
    const result = await this.agentProcess.stop(graceMs);
    this.handleExit();
    return result;
  }

  private async interruptRunningTurn(graceMs: number): Promise<void> {
    const turnId = this.active?.turnId ?? null;
    if (!this.exited && turnId !== null) {
      await withTimeout(this.interrupt(turnId), graceMs);
    }
  }

  private interrupt(turnId: string): Promise<unknown> {
    return this.rpc.request(
      CodexMethod.turnInterrupt,
      { threadId: this.threadId, turnId },
      EmptyResultSchema,
    );
  }

  private untilExit<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      this.exitSignal.then((): never => {
        throw new ProcessExitedError();
      }),
      this.rpc.closed.then((): never => {
        throw new ProcessExitedError();
      }),
    ]);
  }

  private async negotiate(spec: AgentStartSpec): Promise<void> {
    const { needsLogin } = await openCodexAccount(this.rpc);
    if (needsLogin) {
      throw new CodexNeedsLoginError();
    }
    await this.loadInitialRateLimits();
    const thread = await this.rpc.request(
      CodexMethod.threadStart,
      {
        cwd: spec.cwd,
        approvalPolicy: this.appliedPolicy.approvalPolicy,
        sandbox: this.appliedPolicy.sandbox,
        approvalsReviewer: APPROVALS_REVIEWER_USER,
      },
      ThreadStartResponseSchema,
    );
    this.threadId = thread.thread.id;
    this.model = thread.model ?? null;
  }

  private async loadInitialRateLimits(): Promise<void> {
    try {
      await withTimeout(this.readRateLimits(), this.rateLimitReadTimeoutMs);
      this.limitsAnnounced = false;
    } catch (error) {
      console.warn(`rate limit read failed: ${this.runId}`, error);
    }
  }

  private async readRateLimits(): Promise<void> {
    this.limitsRevision += 1;
    const ticket = this.limitsRevision;
    const response = await this.rpc.request(
      CodexMethod.rateLimitsRead,
      undefined,
      RateLimitsReadResponseSchema,
    );
    if (ticket !== this.limitsRevision) {
      return;
    }
    this.limits = replaceRateLimits(
      response.rateLimits,
      response.ordinaryUsageAllowed,
      response.rateLimitsByLimitId,
    );
  }

  private writeLimits(next: RateLimitState): void {
    this.limits = next;
    this.limitsRevision += 1;
  }

  private async runTurn(text: string, options: TurnOptions): Promise<void> {
    this.announceRateLimits();
    this.model = options.model ?? this.model;
    this.reportedModel = null;
    this.announceModel();
    const active = newActiveTurn();
    this.active = active;
    const events = await this.driveTurn(text, active, options);
    this.active = null;
    this.cancelPending();
    this.turn = null;
    for (const event of events) {
      this.emit(event);
    }
  }

  private async driveTurn(
    text: string,
    active: ActiveTurn,
    options: TurnOptions,
  ): Promise<AgentEvent[]> {
    try {
      const desired = this.policy;
      const started = await this.untilExit(
        this.rpc.request(
          CodexMethod.turnStart,
          this.turnParams(text, desired, options.model),
          TurnStartResponseSchema,
        ),
      );
      this.appliedPolicy = desired;
      active.turnId = started.turn.id;
      active.idReady.resolve(started.turn.id);
      const completed = await this.untilExit(active.completed.promise);
      return await this.finishTurn(completed.turn);
    } catch (error) {
      active.idReady.resolve(null);
      return [this.failureEvent(error)];
    }
  }

  private turnParams(
    text: string,
    desired: ProfilePolicy,
    model: string | null,
  ): Readonly<Record<string, unknown>> {
    const changed =
      desired.approvalPolicy !== this.appliedPolicy.approvalPolicy ||
      desired.sandbox !== this.appliedPolicy.sandbox;
    return {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      ...(model === null ? {} : { model }),
      ...(changed
        ? {
            approvalPolicy: desired.approvalPolicy,
            sandboxPolicy: sandboxPolicyFor(desired.sandbox),
          }
        : {}),
    };
  }

  private failureEvent(error: unknown): AgentEvent {
    if (this.exited || error instanceof ProcessExitedError) {
      return exitedEvent();
    }
    if (isPeerClosed(error)) {
      return exitedEvent();
    }
    return {
      type: "turn_error",
      errorKind: null,
      rpcCode: error instanceof CodexRpcError ? error.code : null,
      message: messageOf(error),
    };
  }

  private async finishTurn(turn: Turn): Promise<AgentEvent[]> {
    switch (turn.status) {
      case CodexTurnStatus.completed:
        return [{ type: "turn_end", stopReason: STOP_REASON_END_TURN }];
      case CodexTurnStatus.interrupted:
        return [{ type: "turn_end", stopReason: STOP_REASON_CANCELLED }];
      default:
        return this.failedTurnEvents(turn);
    }
  }

  private async failedTurnEvents(turn: Turn): Promise<AgentEvent[]> {
    const error =
      turn.error === null || turn.error === undefined
        ? ({
            type: "turn_error",
            errorKind: null,
            rpcCode: null,
            message: TURN_FAILED_MESSAGE,
          } satisfies AgentEvent)
        : mapTurnError(turn.error);
    if (error.errorKind !== ERROR_KIND_RATE_LIMIT) {
      return [error];
    }
    return [...(await this.exhaustionEvents()), error];
  }

  private async exhaustionEvents(): Promise<AgentEvent[]> {
    try {
      await this.untilExit(
        withTimeout(this.readRateLimits(), this.rateLimitReadTimeoutMs),
      );
    } catch (error) {
      if (error instanceof ProcessExitedError) {
        throw error;
      }
      console.warn(
        `rate limit read after failure failed: ${this.runId}`,
        error,
      );
      return [];
    }
    this.limitsAnnounced = true;
    const event = toRateLimitEvent(this.limits, true);
    return event === null ? [] : [event];
  }

  private announceRateLimits(): void {
    if (this.limitsAnnounced) {
      return;
    }
    this.limitsAnnounced = true;
    const event = toRateLimitEvent(this.limits);
    if (event !== null) {
      this.emit(event);
    }
  }

  private announceModel(): void {
    if (this.model !== null && this.model !== this.reportedModel) {
      this.reportedModel = this.model;
      this.emit({ type: "model", model: this.model });
    }
  }

  private onModelRerouted(params: unknown): void {
    const parsed = this.parse(
      ModelReroutedParamsSchema,
      CodexNotification.modelRerouted,
      params,
    );
    if (parsed !== null) {
      this.model = parsed.toModel;
      this.announceModel();
    }
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case CodexNotification.modelRerouted:
        this.onModelRerouted(params);
        return;
      case CodexNotification.itemStarted:
        this.onItemStarted(params);
        return;
      case CodexNotification.itemCompleted:
        this.onItemCompleted(params);
        return;
      case CodexNotification.agentMessageDelta:
        this.onAgentMessageDelta(params);
        return;
      case CodexNotification.turnCompleted:
        this.onTurnCompleted(params);
        return;
      case CodexNotification.error:
        this.onErrorNotification(params);
        return;
      case CodexNotification.rateLimitsUpdated:
        this.onRateLimitsUpdated(params);
        return;
      default:
        return;
    }
  }

  private parse<S extends z.ZodType>(
    schema: S,
    method: string,
    params: unknown,
  ): z.output<S> | null {
    const parsed = schema.safeParse(params);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn(`invalid ${method} payload: ${this.runId}`, parsed.error);
    return null;
  }

  private onItemStarted(params: unknown): void {
    const parsed = this.parse(
      ItemNotificationParamsSchema,
      CodexNotification.itemStarted,
      params,
    );
    if (parsed === null) {
      return;
    }
    const fileChange = fileChangeOf(parsed.item);
    if (fileChange !== null) {
      this.fileChangePaths.set(fileChange.itemId, fileChange.paths);
    }
    for (const event of mapItemStarted(parsed.item)) {
      this.emit(event);
    }
  }

  private onItemCompleted(params: unknown): void {
    const parsed = this.parse(
      ItemNotificationParamsSchema,
      CodexNotification.itemCompleted,
      params,
    );
    if (parsed === null) {
      return;
    }
    for (const event of mapItemCompleted(parsed.item)) {
      this.emit(event);
    }
  }

  private onAgentMessageDelta(params: unknown): void {
    const parsed = this.parse(
      AgentMessageDeltaParamsSchema,
      CodexNotification.agentMessageDelta,
      params,
    );
    if (parsed !== null) {
      this.emit(mapAgentMessageDelta(parsed));
    }
  }

  private onTurnCompleted(params: unknown): void {
    const parsed = this.parse(
      TurnCompletedParamsSchema,
      CodexNotification.turnCompleted,
      params,
    );
    const active = this.active;
    if (
      parsed !== null &&
      active !== null &&
      (active.turnId === null || active.turnId === parsed.turn.id)
    ) {
      active.completed.resolve(parsed);
    }
  }

  private onErrorNotification(params: unknown): void {
    const parsed = this.parse(
      ErrorNotificationParamsSchema,
      CodexNotification.error,
      params,
    );
    if (parsed?.willRetry === true) {
      this.emit({ type: "api_retry" });
    }
  }

  private onRateLimitsUpdated(params: unknown): void {
    const parsed = this.parse(
      AccountRateLimitsUpdatedSchema,
      CodexNotification.rateLimitsUpdated,
      params,
    );
    if (parsed === null) {
      return;
    }
    this.writeLimits(mergeRateLimits(this.limits, parsed.rateLimits));
    this.limitsAnnounced = true;
    const event = toRateLimitEvent(this.limits);
    if (event !== null) {
      this.emit(event);
    }
  }

  private onServerRequest(id: RpcId, method: string, params: unknown): void {
    switch (method) {
      case CodexServerRequest.commandApproval:
        this.onCommandApproval(id, params);
        return;
      case CodexServerRequest.fileChangeApproval:
        this.onFileChangeApproval(id, params);
        return;
      case CodexServerRequest.permissionsApproval:
        this.onPermissionsApproval(id, params);
        return;
      default:
        this.rpc.respondError(
          id,
          RPC_CODE_METHOD_NOT_FOUND,
          RPC_MESSAGE_METHOD_NOT_FOUND,
        );
    }
  }

  private onCommandApproval(id: RpcId, params: unknown): void {
    const parsed = this.parse(
      CommandApprovalParamsSchema,
      CodexServerRequest.commandApproval,
      params,
    );
    if (parsed === null) {
      this.rejectInvalid(id);
      return;
    }
    this.requestApproval(
      id,
      commandPermission(randomUUID(), parsed),
      DECISION_ANSWERS,
    );
  }

  private onFileChangeApproval(id: RpcId, params: unknown): void {
    const parsed = this.parse(
      FileChangeApprovalParamsSchema,
      CodexServerRequest.fileChangeApproval,
      params,
    );
    if (parsed === null) {
      this.rejectInvalid(id);
      return;
    }
    this.requestApproval(
      id,
      fileChangePermission(
        randomUUID(),
        parsed.itemId,
        this.fileChangePaths.get(parsed.itemId) ?? [],
      ),
      DECISION_ANSWERS,
    );
  }

  private onPermissionsApproval(id: RpcId, params: unknown): void {
    const parsed = this.parse(
      PermissionsApprovalParamsSchema,
      CodexServerRequest.permissionsApproval,
      params,
    );
    if (parsed === null) {
      this.rejectInvalid(id);
      return;
    }
    this.requestApproval(
      id,
      permissionsPermission(randomUUID(), parsed),
      permissionAnswers(parsed.permissions),
    );
  }

  private rejectInvalid(id: RpcId): void {
    this.rpc.respondError(
      id,
      RPC_CODE_INVALID_PARAMS,
      RPC_MESSAGE_INVALID_PARAMS,
    );
  }

  private requestApproval(
    id: RpcId,
    event: PermissionRequestEvent,
    answers: ApprovalAnswers,
  ): void {
    if (this.stopping || this.exited) {
      this.rpc.respond(id, answers.declined);
      return;
    }
    this.pending.set(event.requestId, {
      ...answers,
      rpcId: id,
      optionIds: new Set(event.options.map((option) => option.optionId)),
    });
    this.emit(event);
  }

  private cancelPending(): void {
    for (const request of this.pending.values()) {
      if (!this.exited) {
        this.rpc.respond(request.rpcId, request.declined);
      }
    }
    this.pending.clear();
  }

  private handleExit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.cancelPending();
    this.resolveExit();
    this.rpc.close();
    const settled = this.turn ?? Promise.resolve();
    void settled.then(() => {
      this.announceExit();
    });
  }

  private announceExit(): void {
    if (this.exitEmitted) {
      return;
    }
    this.exitEmitted = true;
    this.emit({ type: "process_exit" });
  }

  private emit(event: AgentEvent): void {
    [...this.listeners].forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`codex event listener failed: ${this.runId}`, error);
      }
    });
  }
}

function spawnCodex(
  deps: CodexAdapterDeps,
  spec: AgentStartSpec,
): Promise<AgentProcess> {
  const launch = buildCodexLaunch({
    executable: deps.executableFor(spec),
    configDir: spec.account.configDir,
    env: deps.envFor(spec),
    platform: deps.platform,
    comSpec: deps.comSpec,
    tools: spec.tools,
  });
  return deps.processes.start({
    command: launch.command,
    args: launch.args,
    env: launch.env,
    cwd: spec.cwd,
    runId: spec.runId,
    ...(launch.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
  });
}

async function abortStart(
  session: CodexAppServerSession,
  error: unknown,
  graceMs: number,
): Promise<AgentStartResult> {
  const needsLogin = error instanceof CodexNeedsLoginError;
  const tail = session.stderrTail();
  await session.stop(graceMs).catch((stopError: unknown) => {
    console.error(
      `stop after failed start failed: ${session.runId}`,
      stopError,
    );
  });
  const message = messageOf(error);
  return {
    ok: false,
    reason: needsLogin ? AgentStartFailure.needsLogin : AgentStartFailure.error,
    message: needsLogin || tail === "" ? message : `${message}\n${tail}`,
  };
}

export function createCodexAdapter(deps: CodexAdapterDeps): AgentAdapter {
  const graceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const readTimeoutMs =
    deps.rateLimitReadTimeoutMs ?? DEFAULT_RATE_LIMIT_READ_TIMEOUT_MS;

  return {
    async start(spec: AgentStartSpec): Promise<AgentStartResult> {
      let agentProcess: AgentProcess;
      try {
        agentProcess = await spawnCodex(deps, spec);
      } catch (error) {
        return {
          ok: false,
          reason: AgentStartFailure.error,
          message: messageOf(error),
        };
      }
      const session = new CodexAppServerSession(
        spec,
        agentProcess,
        readTimeoutMs,
        graceMs,
      );
      try {
        await session.handshake(spec);
      } catch (error) {
        return abortStart(session, error, graceMs);
      }
      return { ok: true, handle: session };
    },
  };
}
