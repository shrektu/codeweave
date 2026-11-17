import { API_PROVIDERS } from "../../domain/apiProviders";
import {
  ERROR_KIND_RATE_LIMIT,
  MS_PER_SECOND,
  RATE_LIMIT_STATUS_REJECTED,
} from "../../domain/constants";
import type { AgentEvent } from "../../domain/events";
import {
  PermissionProfile,
  type EpochMillis,
  type EpochSeconds,
} from "../../domain/types";
import {
  InvalidOptionError,
  TurnInProgressError,
  UnknownPermissionError,
  type AgentHandle,
  type AgentStartSpec,
  type TurnOptions,
} from "../agentAdapter";
import type { AgentProcess } from "../agentProcesses";
import {
  STOP_REASON_CANCELLED,
  STOP_REASON_END_TURN,
} from "../codex/constants";
import { withTimeout } from "../codex/handshake";
import { PROCESS_EXITED_MESSAGE } from "../constants";
import type { StopResult } from "../process/container";

import {
  OpencodeHttpError,
  type OpencodeClient,
  type PromptModel,
} from "./client";
import {
  LONG_RETRY_THRESHOLD_MS,
  OpencodeAgent,
  OpencodeEventType,
  OpencodePermissionResponse,
  OpencodeRole,
  SESSION_BUSY_MESSAGE,
  STREAM_CLOSED_MESSAGE,
  TURN_FAILED_MESSAGE,
} from "./constants";
import { removeKeyFile, removeRunFiles, type RunFiles } from "./config";
import { classifySessionError, type SessionErrorClass } from "./errors";
import {
  createEventMapper,
  SessionScope,
  type OpencodeEventMapper,
} from "./events";
import type { OpencodeEvent, SessionErrorInfo } from "./protocol";
import type { Redactor } from "./redact";
import type { ProcessWatch } from "./watch";

type Listener = (event: AgentEvent) => void;
type EventOf<T extends OpencodeEvent["type"]> = Extract<
  OpencodeEvent,
  { type: T }
>;

interface PendingPermission {
  readonly sessionId: string;
  readonly optionIds: ReadonlySet<string>;
}

interface ActiveTurn {
  readonly done: PromiseWithResolvers<undefined>;
  sent: boolean;
  cancelled: boolean;
  terminal: boolean;
  settled: boolean;
  fallback: NodeJS.Timeout | null;
  gateTimer: NodeJS.Timeout | null;
  droppedError: { readonly info: SessionErrorInfo | undefined } | null;
}

export interface OpencodeHandleInit {
  readonly spec: AgentStartSpec;
  readonly agentProcess: AgentProcess;
  readonly watch: ProcessWatch;
  readonly files: RunFiles;
  readonly client: OpencodeClient;
  readonly redact: Redactor;
  readonly now: () => EpochMillis;
  readonly stopGraceMs: number;
  readonly staleGateGraceMs: number;
}

function newTurn(): ActiveTurn {
  return {
    done: Promise.withResolvers<undefined>(),
    sent: false,
    cancelled: false,
    terminal: false,
    settled: false,
    fallback: null,
    gateTimer: null,
    droppedError: null,
  };
}

function agentFor(profile: PermissionProfile): OpencodeAgent {
  return profile === PermissionProfile.plan
    ? OpencodeAgent.plan
    : OpencodeAgent.build;
}

const PERMISSION_RESPONSES: readonly string[] = Object.values(
  OpencodePermissionResponse,
);

function isPermissionResponse(
  value: string,
): value is OpencodePermissionResponse {
  return PERMISSION_RESPONSES.includes(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rateLimitEvents(
  resetsAt: EpochSeconds | null,
  message: string,
): AgentEvent[] {
  return [
    {
      type: "rate_limit",
      status: RATE_LIMIT_STATUS_REJECTED,
      resetsAt,
      rateLimitType: null,
      utilization: null,
    },
    {
      type: "turn_error",
      errorKind: ERROR_KIND_RATE_LIMIT,
      rpcCode: null,
      message,
    },
  ];
}

function latestId(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return a > b ? a : b;
}

export class OpencodeHandle implements AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  private readonly ctx: OpencodeHandleInit;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly streamAbort = new AbortController();
  private busy = false;
  private staleBefore: { readonly after: string | null } | null = null;
  private lastMessageId: string | null = null;
  private mapper: OpencodeEventMapper | null = null;
  private profile: PermissionProfile;
  private sessionId = "";
  private unavailable: string | null = null;
  private stopping = false;
  private exited = false;
  private turn: ActiveTurn | null = null;
  private finalizing: Promise<void> | null = null;

  constructor(ctx: OpencodeHandleInit) {
    this.ctx = ctx;
    this.accountId = ctx.spec.account.id;
    this.runId = ctx.spec.runId;
    this.profile = ctx.spec.profile;
    void ctx.watch.exited.then(() => {
      this.handleExit();
    });
  }

  async open(): Promise<void> {
    const { client, watch, files, spec } = this.ctx;
    const stream = await watch.untilExit(
      client.events(this.streamAbort.signal),
    );
    void this.consume(stream);
    await watch.untilExit(client.warmUp());
    await removeKeyFile(files);
    this.sessionId = await watch.untilExit(client.createSession());
    this.mapper = createEventMapper(this.sessionId, spec.cwd);
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
    const turn = newTurn();
    this.turn = turn;
    try {
      if (await this.ensureIdle(turn)) {
        await this.sendPrompt(turn, text, options.model);
      }
      await turn.done.promise;
    } finally {
      this.settle(turn);
      this.turn = this.turn === turn ? null : this.turn;
    }
  }

  answerPermission(requestId: string, optionId: string): void {
    const request = this.pending.get(requestId);
    if (request === undefined) {
      throw new UnknownPermissionError(requestId);
    }
    if (!request.optionIds.has(optionId) || !isPermissionResponse(optionId)) {
      throw new InvalidOptionError(requestId, optionId);
    }
    this.pending.delete(requestId);
    void this.reply(request.sessionId, requestId, optionId);
  }

  setProfile(profile: PermissionProfile): Promise<void> {
    this.profile = profile;
    return Promise.resolve();
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (turn === null || turn.terminal || this.unavailable !== null) {
      return;
    }
    turn.cancelled = true;
    this.releaseIdleWaiters();
    if (this.staleBefore !== null && turn.sent && turn.fallback === null) {
      turn.fallback = setTimeout(() => {
        this.endCancelled(turn);
      }, this.ctx.stopGraceMs);
    }
    await this.abortQuietly();
  }

  async stop(graceMs: number): Promise<StopResult> {
    this.stopping = true;
    this.releaseIdleWaiters();
    await this.rejectPending();
    if (
      this.turn !== null &&
      !this.turn.terminal &&
      this.unavailable === null
    ) {
      this.turn.cancelled = true;
      await this.abortQuietly();
    }
    this.streamAbort.abort();
    const result = await this.ctx.agentProcess.stop(graceMs);
    this.handleExit();
    await this.finalize();
    return result;
  }

  private async ensureIdle(turn: ActiveTurn): Promise<boolean> {
    if (await this.idleAfterWait(turn)) {
      return true;
    }
    await this.abortQuietly();
    if (await this.idleAfterWait(turn)) {
      return true;
    }
    this.failTurn(turn, SESSION_BUSY_MESSAGE);
    return false;
  }

  private async idleAfterWait(turn: ActiveTurn): Promise<boolean> {
    return (
      (await this.serverReportsIdle(turn)) ||
      (await this.waitForIdle(turn)) ||
      (await this.serverReportsIdle(turn))
    );
  }

  private async serverReportsIdle(turn: ActiveTurn): Promise<boolean> {
    if (!this.busy || this.unavailable !== null || this.interrupted(turn)) {
      return true;
    }
    try {
      const statuses = await this.ctx.client.sessionStatus();
      if (!statuses.has(this.sessionId)) {
        const after = await this.ctx.client.latestMessageId(this.sessionId);
        this.staleBefore = { after };
        this.busy = false;
      }
    } catch (error) {
      console.warn(`opencode session status failed: ${this.runId}`, error);
    }
    return !this.busy;
  }

  private interrupted(turn: ActiveTurn): boolean {
    return turn.cancelled || this.stopping;
  }

  private waitForIdle(turn: ActiveTurn): Promise<boolean> {
    if (!this.busy || this.unavailable !== null || this.interrupted(turn)) {
      return Promise.resolve(true);
    }
    const idle = Promise.withResolvers<boolean>();
    const release = (): void => {
      clearTimeout(timer);
      this.idleWaiters.delete(release);
      idle.resolve(true);
    };
    const timer = setTimeout(() => {
      this.idleWaiters.delete(release);
      idle.resolve(false);
    }, this.ctx.stopGraceMs);
    this.idleWaiters.add(release);
    return idle.promise;
  }

  private markIdle(): void {
    this.busy = false;
    this.releaseIdleWaiters();
  }

  private releaseIdleWaiters(): void {
    [...this.idleWaiters].forEach((release) => {
      release();
    });
  }

  private promptModel(modelId: string | null): PromptModel | null {
    const { api } = this.ctx.spec.account;
    return modelId === null || api === undefined
      ? null
      : {
          providerID: API_PROVIDERS[api.provider].opencodeId,
          modelID: modelId,
        };
  }

  private async sendPrompt(
    turn: ActiveTurn,
    text: string,
    model: string | null,
  ): Promise<void> {
    if (this.interrupted(turn)) {
      this.endCancelled(turn);
      return;
    }
    if (this.unavailable !== null) {
      this.failTurn(turn, this.unavailable);
      return;
    }
    turn.sent = true;
    this.busy = true;
    this.staleBefore = {
      after: latestId(this.staleBefore?.after ?? null, this.lastMessageId),
    };
    try {
      await this.ctx.client.promptAsync({
        sessionId: this.sessionId,
        text,
        agent: agentFor(this.profile),
        model: this.promptModel(model),
      });
    } catch (error) {
      if (error instanceof OpencodeHttpError) {
        this.busy = false;
      }
      this.failTurn(turn, this.ctx.redact(messageOf(error)));
    }
  }

  private async consume(stream: AsyncIterable<OpencodeEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        this.onEvent(event);
      }
      this.streamLost();
    } catch (error) {
      if (!this.streamAbort.signal.aborted) {
        console.error(`opencode event stream failed: ${this.runId}`, error);
        this.streamLost();
      }
    }
  }

  private streamLost(): void {
    if (this.stopping || this.exited) {
      return;
    }
    this.unavailable = STREAM_CLOSED_MESSAGE;
    this.releaseIdleWaiters();
    if (this.turn !== null) {
      this.failTurn(this.turn, STREAM_CLOSED_MESSAGE);
    }
  }

  private onEvent(event: OpencodeEvent): void {
    const mapper = this.mapper;
    if (mapper === null) {
      return;
    }
    const mapped = mapper.map(event);
    const own = mapper.scopeOf(event) === SessionScope.own;
    switch (event.type) {
      case OpencodeEventType.partUpdated:
        mapped.forEach((agentEvent) => {
          this.emit(agentEvent);
        });
        return;
      case OpencodeEventType.permissionAsked:
        this.onPermission(event, mapped);
        return;
      case OpencodeEventType.sessionStatus:
        if (own && this.staleBefore === null) {
          this.onStatus(event);
        }
        return;
      case OpencodeEventType.sessionIdle:
        if (own && this.staleBefore === null) {
          this.onIdle();
        }
        return;
      case OpencodeEventType.sessionError:
        if (!own) {
          return;
        }
        if (this.staleBefore === null) {
          this.onSessionError(event.properties.error);
        } else {
          this.onGatedError(event.properties.error);
        }
        return;
      case OpencodeEventType.messageUpdated:
        if (own) {
          this.onMessage(event.properties.info);
          mapped.forEach((agentEvent) => {
            this.emit(agentEvent);
          });
        }
        return;
      case OpencodeEventType.sessionCreated:
      case OpencodeEventType.sessionUpdated:
        return;
    }
  }

  private onMessage(info: {
    readonly id: string;
    readonly role: string;
  }): void {
    this.lastMessageId = latestId(this.lastMessageId, info.id);
    const gate = this.staleBefore;
    if (gate === null || info.role !== OpencodeRole.user) {
      return;
    }
    if (gate.after === null || info.id > gate.after) {
      this.staleBefore = null;
      if (this.turn !== null) {
        this.clearGateTimer(this.turn);
      }
    }
  }

  private onGatedError(info: SessionErrorInfo | undefined): void {
    const turn = this.turn;
    if (turn === null || !turn.sent || turn.terminal) {
      return;
    }
    turn.droppedError = { info };
    turn.gateTimer ??= setTimeout(() => {
      void this.resolveGate(turn);
    }, this.ctx.staleGateGraceMs);
  }

  private clearGateTimer(turn: ActiveTurn): void {
    if (turn.gateTimer !== null) {
      clearTimeout(turn.gateTimer);
      turn.gateTimer = null;
    }
  }

  private async resolveGate(turn: ActiveTurn): Promise<void> {
    turn.gateTimer = null;
    if (!this.gateBlocks(turn) || (await this.userMessageInFlight())) {
      return;
    }
    if (this.gateBlocks(turn)) {
      this.staleBefore = null;
      this.onSessionError(turn.droppedError?.info);
    }
  }

  private gateBlocks(turn: ActiveTurn): boolean {
    return !turn.settled && !turn.terminal && this.staleBefore !== null;
  }

  private async userMessageInFlight(): Promise<boolean> {
    const after = this.staleBefore?.after ?? null;
    try {
      const latest = await this.ctx.client.latestMessageId(this.sessionId);
      return latest !== null && (after === null || latest > after);
    } catch (error) {
      console.warn(`opencode gate resolution failed: ${this.runId}`, error);
      return false;
    }
  }

  private onPermission(
    event: EventOf<typeof OpencodeEventType.permissionAsked>,
    mapped: readonly AgentEvent[],
  ): void {
    const [request] = mapped;
    if (request?.type !== "permission_request") {
      return;
    }
    const sessionId = event.properties.sessionID ?? this.sessionId;
    if (this.stopping || this.turn === null || this.turn.terminal) {
      void this.reply(
        sessionId,
        request.requestId,
        OpencodePermissionResponse.reject,
      );
      return;
    }
    this.pending.set(request.requestId, {
      sessionId,
      optionIds: new Set(request.options.map((option) => option.optionId)),
    });
    this.emit(request);
  }

  private onStatus(
    event: EventOf<typeof OpencodeEventType.sessionStatus>,
  ): void {
    const { status } = event.properties;
    const turn = this.turn;
    if (
      status.type !== "retry" ||
      turn === null ||
      !turn.sent ||
      turn.terminal
    ) {
      return;
    }
    const { next } = status;
    if (
      next === undefined ||
      next - this.ctx.now() <= LONG_RETRY_THRESHOLD_MS
    ) {
      this.emit({ type: "api_retry" });
      return;
    }
    this.conclude(
      turn,
      rateLimitEvents(
        Math.floor(next / MS_PER_SECOND),
        this.ctx.redact(status.message ?? TURN_FAILED_MESSAGE),
      ),
    );
    void this.abortQuietly();
  }

  private onIdle(): void {
    this.markIdle();
    const turn = this.turn;
    if (turn === null || !turn.sent || turn.settled) {
      return;
    }
    if (!turn.terminal) {
      turn.terminal = true;
      this.emit(this.turnEnd(turn.cancelled));
    }
    this.settle(turn);
  }

  private onSessionError(info: SessionErrorInfo | undefined): void {
    const turn = this.turn;
    if (turn === null || !turn.sent || turn.terminal) {
      return;
    }
    const classified = classifySessionError(info, this.ctx.now());
    const cancelled = classified.aborted && (turn.cancelled || this.stopping);
    this.conclude(
      turn,
      cancelled ? [this.turnEnd(true)] : this.errorEvents(classified),
    );
  }

  private errorEvents(classified: SessionErrorClass): AgentEvent[] {
    const message = this.ctx.redact(classified.message);
    if (classified.errorKind === ERROR_KIND_RATE_LIMIT) {
      return rateLimitEvents(classified.resetsAt, message);
    }
    return [
      {
        type: "turn_error",
        errorKind: classified.errorKind,
        rpcCode: null,
        message,
      },
    ];
  }

  private turnEnd(cancelled: boolean): AgentEvent {
    return {
      type: "turn_end",
      stopReason: cancelled ? STOP_REASON_CANCELLED : STOP_REASON_END_TURN,
    };
  }

  private conclude(turn: ActiveTurn, events: readonly AgentEvent[]): void {
    turn.terminal = true;
    events.forEach((event) => {
      this.emit(event);
    });
    turn.fallback = setTimeout(() => {
      this.settle(turn);
    }, this.ctx.stopGraceMs);
  }

  private failTurn(turn: ActiveTurn, message: string): void {
    if (turn.settled) {
      return;
    }
    if (!turn.terminal) {
      turn.terminal = true;
      this.emit(
        this.stopping
          ? this.turnEnd(true)
          : { type: "turn_error", errorKind: null, rpcCode: null, message },
      );
    }
    this.settle(turn);
  }

  private endCancelled(turn: ActiveTurn): void {
    if (turn.settled) {
      return;
    }
    if (!turn.terminal) {
      turn.terminal = true;
      this.emit(this.turnEnd(true));
    }
    this.settle(turn);
  }

  private settle(turn: ActiveTurn): void {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    this.clearGateTimer(turn);
    if (turn.fallback !== null) {
      clearTimeout(turn.fallback);
    }
    turn.done.resolve(undefined);
  }

  private reply(
    sessionId: string,
    permissionId: string,
    response: OpencodePermissionResponse,
  ): Promise<void> {
    return this.ctx.client
      .replyPermission(sessionId, permissionId, response)
      .catch((error: unknown) => {
        console.warn(`opencode permission reply failed: ${this.runId}`, error);
      });
  }

  private async rejectPending(): Promise<void> {
    const requests = [...this.pending];
    this.pending.clear();
    await Promise.all(
      requests.map(([id, request]) =>
        this.reply(request.sessionId, id, OpencodePermissionResponse.reject),
      ),
    );
  }

  private abortQuietly(): Promise<void> {
    return withTimeout(
      this.ctx.client.abort(this.sessionId),
      this.ctx.stopGraceMs,
    ).catch((error: unknown) => {
      console.warn(`opencode abort failed: ${this.runId}`, error);
    });
  }

  private handleExit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.unavailable = PROCESS_EXITED_MESSAGE;
    this.releaseIdleWaiters();
    this.streamAbort.abort();
    this.pending.clear();
    if (this.turn !== null) {
      this.failTurn(this.turn, PROCESS_EXITED_MESSAGE);
    }
    if (!this.stopping) {
      void this.finalize();
    }
  }

  private finalize(): Promise<void> {
    this.finalizing ??= removeRunFiles(this.ctx.files)
      .catch((error: unknown) => {
        console.error(
          `opencode run files cleanup failed: ${this.runId}`,
          error,
        );
      })
      .then(() => {
        this.emit({ type: "process_exit" });
      });
    return this.finalizing;
  }

  private emit(event: AgentEvent): void {
    [...this.listeners].forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`opencode event listener failed: ${this.runId}`, error);
      }
    });
  }
}
