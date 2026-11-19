import {
  ERROR_KIND_RATE_LIMIT,
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
import { PROCESS_EXITED_MESSAGE } from "../constants";
import type { StopResult } from "../process/container";

import {
  OpencodeAgent,
  OpencodePermissionResponse,
  STREAM_CLOSED_MESSAGE,
} from "./constants";
import { removeRunFiles, type RunFiles } from "./config";
import type { Redactor } from "./redact";
import type { ProcessWatch } from "./watch";

export type Listener = (event: AgentEvent) => void;

interface PendingPermission {
  readonly sessionId: string;
  readonly optionIds: ReadonlySet<string>;
}

export function agentFor(profile: PermissionProfile): OpencodeAgent {
  return profile === PermissionProfile.plan
    ? OpencodeAgent.plan
    : OpencodeAgent.build;
}

const PERMISSION_RESPONSES: readonly string[] = Object.values(
  OpencodePermissionResponse,
);

export function isPermissionResponse(
  value: string,
): value is OpencodePermissionResponse {
  return PERMISSION_RESPONSES.includes(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function rateLimitEvents(
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

export class ListenerHub {
  private readonly listeners = new Set<Listener>();
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    [...this.listeners].forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`opencode event listener failed: ${this.runId}`, error);
      }
    });
  }
}

export type PermissionReplier = (
  sessionId: string,
  requestId: string,
  response: OpencodePermissionResponse,
) => Promise<void>;

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly runId: string;
  private readonly replier: PermissionReplier;

  constructor(runId: string, replier: PermissionReplier) {
    this.runId = runId;
    this.replier = replier;
  }

  admit(
    request: Extract<AgentEvent, { type: "permission_request" }>,
    sessionId: string,
    live: boolean,
  ): boolean {
    if (!live) {
      void this.reply(
        sessionId,
        request.requestId,
        OpencodePermissionResponse.reject,
      );
      return false;
    }
    this.pending.set(request.requestId, {
      sessionId,
      optionIds: new Set(request.options.map((option) => option.optionId)),
    });
    return true;
  }

  answer(requestId: string, optionId: string): void {
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

  forget(): void {
    this.pending.clear();
  }

  async rejectAll(): Promise<void> {
    const requests = [...this.pending];
    this.pending.clear();
    await Promise.all(
      requests.map(([id, request]) =>
        this.reply(request.sessionId, id, OpencodePermissionResponse.reject),
      ),
    );
  }

  private reply(
    sessionId: string,
    requestId: string,
    response: OpencodePermissionResponse,
  ): Promise<void> {
    return this.replier(sessionId, requestId, response).catch(
      (error: unknown) => {
        console.warn(`opencode permission reply failed: ${this.runId}`, error);
      },
    );
  }
}

export interface EventConsumer<T> {
  readonly runId: string;
  readonly signal: AbortSignal;
  onEvent(event: T): void;
  onLost(): void;
}

export async function consumeEvents<T>(
  stream: AsyncIterable<T>,
  consumer: EventConsumer<T>,
): Promise<void> {
  try {
    for await (const event of stream) {
      consumer.onEvent(event);
    }
    consumer.onLost();
  } catch (error) {
    if (!consumer.signal.aborted) {
      console.error(`opencode event stream failed: ${consumer.runId}`, error);
      consumer.onLost();
    }
  }
}

export function finalizeRun(
  files: RunFiles,
  hub: ListenerHub,
  runId: string,
): Promise<void> {
  return removeRunFiles(files)
    .catch((error: unknown) => {
      console.error(`opencode run files cleanup failed: ${runId}`, error);
    })
    .then(() => {
      hub.emit({ type: "process_exit" });
    });
}

export interface BaseTurn {
  readonly done: PromiseWithResolvers<undefined>;
  sent: boolean;
  cancelled: boolean;
  terminal: boolean;
  settled: boolean;
  fallback: NodeJS.Timeout | null;
}

export interface HandleBaseInit {
  readonly spec: AgentStartSpec;
  readonly agentProcess: AgentProcess;
  readonly watch: ProcessWatch;
  readonly files: RunFiles;
  readonly redact: Redactor;
  readonly now: () => EpochMillis;
  readonly stopGraceMs: number;
}

export function turnEnd(cancelled: boolean): AgentEvent {
  return {
    type: "turn_end",
    stopReason: cancelled ? STOP_REASON_CANCELLED : STOP_REASON_END_TURN,
  };
}

export abstract class OpencodeHandleBase<
  Turn extends BaseTurn,
  Event,
> implements AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  protected readonly streamAbort = new AbortController();
  protected readonly wakeHooks: (() => void)[] = [];
  protected readonly hub: ListenerHub;
  protected readonly permissions: PermissionBroker;
  protected profile: PermissionProfile;
  protected sessionId = "";
  protected unavailable: string | null = null;
  protected stopping = false;
  protected exited = false;
  protected turn: Turn | null = null;
  private readonly base: HandleBaseInit;
  private finalizing: Promise<void> | null = null;

  protected constructor(base: HandleBaseInit, replier: PermissionReplier) {
    this.base = base;
    this.accountId = base.spec.account.id;
    this.runId = base.spec.runId;
    this.profile = base.spec.profile;
    this.hub = new ListenerHub(this.runId);
    this.permissions = new PermissionBroker(this.runId, replier);
    void base.watch.exited.then(() => {
      this.handleExit();
    });
  }

  protected abstract createTurn(): Turn;
  protected abstract ensureIdle(turn: Turn): Promise<boolean>;
  protected abstract sendPrompt(
    turn: Turn,
    text: string,
    model: string | null,
  ): Promise<void>;
  protected abstract interruptQuietly(): Promise<void>;
  protected abstract needsCancelFallback(turn: Turn): boolean;
  protected abstract dispatch(event: Event): void;

  subscribe(listener: Listener): () => void {
    return this.hub.subscribe(listener);
  }

  async prompt(text: string, options: TurnOptions): Promise<void> {
    if (this.turn !== null) {
      throw new TurnInProgressError(this.runId);
    }
    const turn = this.createTurn();
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
    this.permissions.answer(requestId, optionId);
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
    this.wake();
    if (this.needsCancelFallback(turn) && turn.fallback === null) {
      turn.fallback = setTimeout(() => {
        this.endCancelled(turn);
      }, this.base.stopGraceMs);
    }
    await this.interruptQuietly();
  }

  async stop(graceMs: number): Promise<StopResult> {
    this.stopping = true;
    this.wake();
    await this.permissions.rejectAll();
    if (
      this.turn !== null &&
      !this.turn.terminal &&
      this.unavailable === null
    ) {
      this.turn.cancelled = true;
      await this.interruptQuietly();
    }
    this.streamAbort.abort();
    const result = await this.base.agentProcess.stop(graceMs);
    this.handleExit();
    await this.finalize();
    return result;
  }

  protected consume(stream: AsyncIterable<Event>): void {
    void consumeEvents(stream, {
      runId: this.runId,
      signal: this.streamAbort.signal,
      onEvent: (event) => {
        this.dispatch(event);
      },
      onLost: () => {
        this.streamLost();
      },
    });
  }

  protected wake(): void {
    this.wakeHooks.forEach((hook) => {
      hook();
    });
  }

  protected emit(event: AgentEvent): void {
    this.hub.emit(event);
  }

  protected conclude(turn: Turn, events: readonly AgentEvent[]): void {
    turn.terminal = true;
    events.forEach((event) => {
      this.emit(event);
    });
    turn.fallback = setTimeout(() => {
      this.settle(turn);
    }, this.base.stopGraceMs);
  }

  protected failTurn(turn: Turn, message: string): void {
    if (turn.settled) {
      return;
    }
    if (!turn.terminal) {
      turn.terminal = true;
      this.emit(
        this.stopping
          ? turnEnd(true)
          : { type: "turn_error", errorKind: null, rpcCode: null, message },
      );
    }
    this.settle(turn);
  }

  protected endCancelled(turn: Turn): void {
    if (turn.settled) {
      return;
    }
    if (!turn.terminal) {
      turn.terminal = true;
      this.emit(turnEnd(true));
    }
    this.settle(turn);
  }

  protected settle(turn: Turn): void {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    if (turn.fallback !== null) {
      clearTimeout(turn.fallback);
    }
    turn.done.resolve(undefined);
  }

  protected streamLost(): void {
    if (this.stopping || this.exited) {
      return;
    }
    this.unavailable = STREAM_CLOSED_MESSAGE;
    this.wake();
    if (this.turn !== null) {
      this.failTurn(this.turn, STREAM_CLOSED_MESSAGE);
    }
  }

  protected handleExit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.unavailable = PROCESS_EXITED_MESSAGE;
    this.wake();
    this.streamAbort.abort();
    this.permissions.forget();
    if (this.turn !== null) {
      this.failTurn(this.turn, PROCESS_EXITED_MESSAGE);
    }
    if (!this.stopping) {
      void this.finalize();
    }
  }

  private finalize(): Promise<void> {
    this.finalizing ??= finalizeRun(this.base.files, this.hub, this.runId);
    return this.finalizing;
  }
}
