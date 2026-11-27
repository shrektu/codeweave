import { API_PROVIDERS } from "../../domain/apiProviders";
import { ERROR_KIND_RATE_LIMIT, MS_PER_SECOND } from "../../domain/constants";
import type { AgentEvent } from "../../domain/events";
import { readPromptImages, type PromptImage } from "../agentAdapter";
import { withTimeout } from "../codex/handshake";

import {
  OpencodeHttpError,
  type OpencodeClient,
  type PromptModel,
} from "./client";
import {
  LONG_RETRY_THRESHOLD_MS,
  OpencodeEventType,
  OpencodeRole,
  SESSION_BUSY_MESSAGE,
  TURN_FAILED_MESSAGE,
} from "./constants";
import { removeKeyFile } from "./config";
import { classifySessionError, type SessionErrorClass } from "./errors";
import {
  createEventMapper,
  SessionScope,
  type OpencodeEventMapper,
} from "./events";
import {
  OpencodeHandleBase,
  agentFor,
  existingSessionId,
  messageOf,
  rateLimitEvents,
  turnEnd,
  type HandleBaseInit,
} from "./handleBase";
import type { OpencodeEvent, SessionErrorInfo } from "./protocol";

const COMPACT_MODEL_UNKNOWN_MESSAGE = "OpenCode compaction needs a known model";

type EventOf<T extends OpencodeEvent["type"]> = Extract<
  OpencodeEvent,
  { type: T }
>;

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

export interface OpencodeHandleInit extends HandleBaseInit {
  readonly client: OpencodeClient;
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

function latestId(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return a > b ? a : b;
}

export class OpencodeHandle extends OpencodeHandleBase<
  ActiveTurn,
  OpencodeEvent
> {
  private readonly ctx: OpencodeHandleInit;
  private readonly idleWaiters = new Set<() => void>();
  private busy = false;
  private staleBefore: { readonly after: string | null } | null = null;
  private lastMessageId: string | null = null;
  private lastModelId: string | null = null;
  private mapper: OpencodeEventMapper | null = null;

  constructor(ctx: OpencodeHandleInit) {
    super(ctx, (...reply) => ctx.client.replyPermission(...reply));
    this.ctx = ctx;
    this.wakeHooks.push(() => {
      this.releaseIdleWaiters();
    });
  }

  async open(): Promise<void> {
    const { client, watch, files, spec } = this.ctx;
    const stream = await watch.untilExit(
      client.events(this.streamAbort.signal),
    );
    this.consume(stream);
    await watch.untilExit(client.warmUp());
    await removeKeyFile(files);
    const resumedId = await existingSessionId(
      spec.resume?.nativeSessionId,
      watch,
      (sessionId) => client.sessionExists(sessionId),
      this.runId,
    );
    this.sessionId =
      resumedId ?? (await watch.untilExit(client.createSession()));
    this.nativeSessionId = this.sessionId;
    this.resumed = resumedId !== null;
    this.mapper = createEventMapper(this.sessionId, spec.cwd);
  }

  protected override createTurn(): ActiveTurn {
    return newTurn();
  }

  protected override needsCancelFallback(turn: ActiveTurn): boolean {
    return this.staleBefore !== null && turn.sent;
  }

  protected override interruptQuietly(): Promise<void> {
    return this.abortQuietly();
  }

  protected override dispatch(event: OpencodeEvent): void {
    this.onEvent(event);
  }

  protected override settle(turn: ActiveTurn): void {
    this.clearGateTimer(turn);
    super.settle(turn);
  }

  protected override async ensureIdle(turn: ActiveTurn): Promise<boolean> {
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

  private servedModel(): PromptModel | null {
    const { api } = this.ctx.spec.account;
    const modelId = this.lastModelId ?? api?.model ?? null;
    return modelId === null || api === undefined
      ? null
      : {
          providerID: API_PROVIDERS[api.provider].opencodeId,
          modelID: modelId,
        };
  }

  protected override async sendPrompt(
    turn: ActiveTurn,
    text: string,
    model: string | null,
    images: readonly PromptImage[] | undefined,
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
        images: await readPromptImages(images),
      });
      this.lastModelId = model ?? this.lastModelId;
    } catch (error) {
      if (error instanceof OpencodeHttpError) {
        this.busy = false;
      }
      this.failTurn(turn, this.ctx.redact(messageOf(error)));
    }
  }

  protected override sendCompact(turn: ActiveTurn): Promise<void> {
    if (this.interrupted(turn)) {
      this.endCancelled(turn);
      return Promise.resolve();
    }
    if (this.unavailable !== null) {
      this.failTurn(turn, this.unavailable);
      return Promise.resolve();
    }
    const model = this.servedModel();
    if (model === null) {
      this.failTurn(turn, COMPACT_MODEL_UNKNOWN_MESSAGE);
      return Promise.resolve();
    }
    turn.sent = true;
    this.busy = true;
    void this.ctx.client
      .summarize(this.sessionId, model, this.streamAbort.signal)
      .catch((error: unknown) => {
        if (error instanceof OpencodeHttpError) {
          this.busy = false;
        }
        if (turn.cancelled || this.stopping) {
          this.endCancelled(turn);
          return;
        }
        this.failTurn(turn, this.ctx.redact(messageOf(error)));
      });
    return Promise.resolve();
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
      case OpencodeEventType.permissionReplied:
        this.onPermissionReplied(event);
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
          if (this.staleBefore === null && this.turn?.sent === true) {
            mapped.forEach((agentEvent) => {
              this.emit(agentEvent);
            });
          }
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
      this.mapper?.beginTurn();
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
    const live = !this.stopping && this.turn !== null && !this.turn.terminal;
    const sessionId = event.properties.sessionID ?? this.sessionId;
    if (this.permissions.admit(request, sessionId, live)) {
      this.emit(request);
    }
  }

  private onPermissionReplied(
    event: EventOf<typeof OpencodeEventType.permissionReplied>,
  ): void {
    const { requestID, reply } = event.properties;
    if (this.permissions.settle(requestID)) {
      this.emit({
        type: "permission_settled",
        requestId: requestID,
        optionId: reply,
      });
    }
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
      this.emit(turnEnd(turn.cancelled));
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
      cancelled ? [turnEnd(true)] : this.errorEvents(classified),
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

  private abortQuietly(): Promise<void> {
    return withTimeout(
      this.ctx.client.abort(this.sessionId),
      this.ctx.stopGraceMs,
    ).catch((error: unknown) => {
      console.warn(`opencode abort failed: ${this.runId}`, error);
    });
  }
}
