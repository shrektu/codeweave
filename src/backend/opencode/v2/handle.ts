import {
  ERROR_KIND_RATE_LIMIT,
  MS_PER_SECOND,
} from "../../../domain/constants";
import type { AgentEvent } from "../../../domain/events";
import type { EpochSeconds } from "../../../domain/types";
import { withTimeout } from "../../codex/handshake";
import { removeKeyFile } from "../config";
import {
  IDLE_POLL_MS,
  LONG_RETRY_THRESHOLD_MS,
  READY_TIMEOUT_MESSAGE,
  SESSION_BUSY_MESSAGE,
  type OpencodeAgent,
} from "../constants";
import type { SessionErrorClass } from "../errors";
import { SessionScope } from "../events";
import {
  OpencodeHandleBase,
  agentFor,
  messageOf,
  rateLimitEvents,
  turnEnd,
  type BaseTurn,
  type HandleBaseInit,
} from "../handleBase";

import type { OpencodeV2Client, V2ModelRef } from "./client";
import { OpencodeV2EventType } from "./constants";
import { classifyExecutionError } from "./errors";
import { createV2EventMapper, type OpencodeV2EventMapper } from "./events";
import type { OpencodeV2Event } from "./protocol";

type EventOf<T extends OpencodeV2Event["type"]> = Extract<
  OpencodeV2Event,
  { type: T }
>;
type TerminalEvent = EventOf<
  | typeof OpencodeV2EventType.executionSucceeded
  | typeof OpencodeV2EventType.executionFailed
  | typeof OpencodeV2EventType.executionInterrupted
>;

interface ActiveTurn extends BaseTurn {
  started: boolean;
}

export interface OpencodeV2HandleInit extends HandleBaseInit {
  readonly client: OpencodeV2Client;
  readonly readyTimeoutMs: number;
  readonly consoleLogin: boolean;
  readonly defaultModel: V2ModelRef;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class OpencodeV2Handle extends OpencodeHandleBase<
  ActiveTurn,
  OpencodeV2Event
> {
  private readonly ctx: OpencodeV2HandleInit;
  private readonly connected = Promise.withResolvers<undefined>();
  private mapper: OpencodeV2EventMapper | null = null;
  private lastAgent: OpencodeAgent;
  private lastModelId: string;

  constructor(ctx: OpencodeV2HandleInit) {
    super(ctx, (...reply) => ctx.client.replyPermission(...reply));
    this.ctx = ctx;
    this.lastAgent = agentFor(ctx.spec.profile);
    this.lastModelId = ctx.defaultModel.id;
  }

  async open(): Promise<void> {
    const { client, watch, files, spec } = this.ctx;
    const stream = await watch.untilExit(
      client.events(this.streamAbort.signal),
    );
    this.consume(stream);
    await watch.untilExit(this.untilConnected());
    await watch.untilExit(client.warmUp());
    await removeKeyFile(files);
    this.lastAgent = agentFor(this.profile);
    this.sessionId = await watch.untilExit(
      client.createSession(this.lastAgent),
    );
    this.mapper = createV2EventMapper(this.sessionId, spec.cwd);
  }

  protected override createTurn(): ActiveTurn {
    return {
      done: Promise.withResolvers<undefined>(),
      sent: false,
      started: false,
      cancelled: false,
      terminal: false,
      settled: false,
      fallback: null,
    };
  }

  protected override needsCancelFallback(turn: ActiveTurn): boolean {
    return turn.sent;
  }

  protected override interruptQuietly(): Promise<void> {
    return withTimeout(
      this.ctx.client.interrupt(this.sessionId),
      this.ctx.stopGraceMs,
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn(`opencode interrupt failed: ${this.runId}`, error);
      });
  }

  private untilConnected(): Promise<undefined> {
    return withTimeout(this.connected.promise, this.ctx.readyTimeoutMs).catch(
      (error: unknown) => {
        throw new Error(READY_TIMEOUT_MESSAGE, { cause: error });
      },
    );
  }

  private mayProceed(turn: ActiveTurn): boolean {
    if (turn.cancelled || this.stopping) {
      this.endCancelled(turn);
      return false;
    }
    if (this.unavailable !== null) {
      this.failTurn(turn, this.unavailable);
      return false;
    }
    return true;
  }

  protected override async ensureIdle(turn: ActiveTurn): Promise<boolean> {
    if (!this.mayProceed(turn)) {
      return false;
    }
    try {
      if (!(await this.ctx.client.isActive(this.sessionId))) {
        return true;
      }
      await this.interruptQuietly();
      if (await this.waitUntilIdle(turn)) {
        return true;
      }
    } catch (error) {
      this.failTurn(turn, this.ctx.redact(messageOf(error)));
      return false;
    }
    this.failTurn(turn, SESSION_BUSY_MESSAGE);
    return false;
  }

  private async waitUntilIdle(turn: ActiveTurn): Promise<boolean> {
    const deadline = Date.now() + this.ctx.stopGraceMs;
    while (this.mayProceed(turn)) {
      if (!(await this.ctx.client.isActive(this.sessionId))) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await pause(IDLE_POLL_MS);
    }
    return false;
  }

  protected override async sendPrompt(
    turn: ActiveTurn,
    text: string,
    model: string | null,
  ): Promise<void> {
    if (!this.mayProceed(turn)) {
      return;
    }
    turn.sent = true;
    this.mapper?.beginTurn();
    try {
      await this.applySelections(model);
      await this.ctx.client.prompt(this.sessionId, text);
      if (turn.cancelled) {
        await this.interruptQuietly();
      }
    } catch (error) {
      this.failTurn(turn, this.ctx.redact(messageOf(error)));
    }
  }

  private async applySelections(model: string | null): Promise<void> {
    const { client, defaultModel } = this.ctx;
    const agent = agentFor(this.profile);
    if (agent !== this.lastAgent) {
      await client.switchAgent(this.sessionId, agent);
      this.lastAgent = agent;
    }
    const wanted: V2ModelRef = {
      id: model ?? defaultModel.id,
      providerID: defaultModel.providerID,
    };
    if (wanted.id !== this.lastModelId) {
      await client.switchModel(this.sessionId, wanted);
      this.lastModelId = wanted.id;
    }
  }

  protected override dispatch(event: OpencodeV2Event): void {
    if (event.type === OpencodeV2EventType.serverConnected) {
      this.connected.resolve(undefined);
      return;
    }
    const mapper = this.mapper;
    if (mapper === null) {
      return;
    }
    const mapped = mapper.map(event);
    if (event.type === OpencodeV2EventType.permissionAsked) {
      this.onPermission(event, mapped);
    } else if (mapper.scopeOf(event) === SessionScope.own) {
      this.onOwnEvent(event, mapped);
    }
  }

  private onOwnEvent(
    event: OpencodeV2Event,
    mapped: readonly AgentEvent[],
  ): void {
    switch (event.type) {
      case OpencodeV2EventType.executionStarted:
        this.onStarted();
        return;
      case OpencodeV2EventType.retryScheduled:
        this.onRetry(event);
        return;
      case OpencodeV2EventType.executionSucceeded:
      case OpencodeV2EventType.executionFailed:
      case OpencodeV2EventType.executionInterrupted:
        this.onTerminal(event);
        return;
      default:
        this.emitWhileRunning(mapped);
    }
  }

  private emitWhileRunning(events: readonly AgentEvent[]): void {
    if (this.turn?.started === true && !this.turn.terminal) {
      events.forEach((event) => {
        this.emit(event);
      });
    }
  }

  private onStarted(): void {
    const turn = this.turn;
    if (turn?.sent === true && !turn.started) {
      turn.started = true;
    }
  }

  private onPermission(
    event: EventOf<typeof OpencodeV2EventType.permissionAsked>,
    mapped: readonly AgentEvent[],
  ): void {
    const [request] = mapped;
    if (request?.type !== "permission_request") {
      return;
    }
    const live = !this.stopping && this.turn !== null && !this.turn.terminal;
    if (this.permissions.admit(request, event.data.sessionID, live)) {
      this.emit(request);
    }
  }

  private onRetry(
    event: EventOf<typeof OpencodeV2EventType.retryScheduled>,
  ): void {
    const turn = this.turn;
    if (turn === null || !turn.started || turn.terminal) {
      return;
    }
    const { at, error } = event.data;
    const now = this.ctx.now();
    const delayMs = Math.max(at - now, error.retryAfterMs ?? 0);
    if (delayMs <= LONG_RETRY_THRESHOLD_MS) {
      this.emit({ type: "api_retry" });
      return;
    }
    this.conclude(
      turn,
      this.errorEvents(
        classifyExecutionError(error, now, this.ctx.consoleLogin),
        Math.ceil(at / MS_PER_SECOND),
      ),
    );
    void this.interruptQuietly();
  }

  private onTerminal(event: TerminalEvent): void {
    const turn = this.turn;
    if (!turn?.sent || !turn.started) {
      return;
    }
    if (!turn.terminal) {
      turn.terminal = true;
      this.terminalEvents(event, turn).forEach((agentEvent) => {
        this.emit(agentEvent);
      });
    }
    this.settle(turn);
  }

  private terminalEvents(event: TerminalEvent, turn: ActiveTurn): AgentEvent[] {
    switch (event.type) {
      case OpencodeV2EventType.executionSucceeded:
        return [turnEnd(false)];
      case OpencodeV2EventType.executionInterrupted:
        return [turnEnd(true)];
      case OpencodeV2EventType.executionFailed: {
        const classified = classifyExecutionError(
          event.data.error,
          this.ctx.now(),
          this.ctx.consoleLogin,
        );
        return classified.aborted && (turn.cancelled || this.stopping)
          ? [turnEnd(true)]
          : this.errorEvents(classified, null);
      }
    }
  }

  private errorEvents(
    classified: SessionErrorClass,
    fallbackResetsAt: EpochSeconds | null,
  ): AgentEvent[] {
    const message = this.ctx.redact(classified.message);
    if (classified.errorKind === ERROR_KIND_RATE_LIMIT) {
      return rateLimitEvents(classified.resetsAt ?? fallbackResetsAt, message);
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
}
