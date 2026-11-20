import {
  DEFAULT_COOLDOWN_SECONDS,
  EPOCH_MILLIS_THRESHOLD,
  ERROR_KIND_AUTH_REQUIRED,
  ERROR_KIND_RATE_LIMIT,
  MS_PER_SECOND,
  RATE_LIMIT_STATUS_REJECTED,
  RPC_CODE_AUTH_REJECTED,
} from "./constants";
import type { AgentEvent } from "./events";
import { windowOfRateLimitType, type LimitWindow } from "./limitWindows";
import type { EpochMillis, EpochSeconds } from "./types";

export type TurnOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "exhausted";
      readonly resetsAt: EpochSeconds;
      readonly rateLimitType: string | null;
    }
  | { readonly kind: "needs_login" }
  | { readonly kind: "failed"; readonly message: string };

export interface LimitSnapshot {
  readonly status: string;
  readonly resetsAt: EpochSeconds | null;
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly windows: readonly LimitWindow[];
}

export interface RateLimitDetector {
  readonly observe: (event: AgentEvent) => void;
  readonly settle: () => TurnOutcome;
  readonly snapshot: () => LimitSnapshot | null;
}

type TurnError = Extract<AgentEvent, { type: "turn_error" }>;

interface TurnState {
  rejected: boolean;
  limit: LimitSnapshot | null;
  error: TurnError | null;
  ended: boolean;
  exited: boolean;
}

function freshTurn(): TurnState {
  return {
    rejected: false,
    limit: null,
    error: null,
    ended: false,
    exited: false,
  };
}

function normalizeResetsAt(raw: unknown): EpochSeconds | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return raw > EPOCH_MILLIS_THRESHOLD ? Math.floor(raw / MS_PER_SECOND) : raw;
}

function stringOrNull(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

function numberOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function windowsOf(
  event: Extract<AgentEvent, { type: "rate_limit" }>,
  snapshot: Omit<LimitSnapshot, "windows">,
): readonly LimitWindow[] {
  if (event.windows !== undefined) {
    return event.windows;
  }
  const single = windowOfRateLimitType({
    rateLimitType: snapshot.rateLimitType,
    utilization: snapshot.utilization,
    resetsAt: snapshot.resetsAt,
    exhausted: event.status === RATE_LIMIT_STATUS_REJECTED,
  });
  return single === null ? [] : [single];
}

function toSnapshot(
  event: Extract<AgentEvent, { type: "rate_limit" }>,
): LimitSnapshot {
  const snapshot = {
    status: event.status,
    resetsAt: normalizeResetsAt(event.resetsAt),
    rateLimitType: stringOrNull(event.rateLimitType),
    utilization: numberOrNull(event.utilization),
  };
  return { ...snapshot, windows: windowsOf(event, snapshot) };
}

export function isNeedsLogin(error: TurnError | null): boolean {
  if (error === null) {
    return false;
  }
  return (
    error.errorKind === ERROR_KIND_AUTH_REQUIRED ||
    (error.errorKind === null && error.rpcCode === RPC_CODE_AUTH_REJECTED)
  );
}

export function createRateLimitDetector(
  now: () => EpochMillis,
): RateLimitDetector {
  let turn = freshTurn();
  let latest: LimitSnapshot | null = null;

  function exhaustedResetsAt(): EpochSeconds {
    const resetsAt = turn.limit?.resetsAt ?? null;
    if (resetsAt !== null && resetsAt * MS_PER_SECOND > now()) {
      return resetsAt;
    }
    return Math.floor(now() / MS_PER_SECOND) + DEFAULT_COOLDOWN_SECONDS;
  }

  function observe(event: AgentEvent): void {
    switch (event.type) {
      case "rate_limit":
        turn.limit = toSnapshot(event);
        latest = turn.limit;
        turn.rejected ||= event.status === RATE_LIMIT_STATUS_REJECTED;
        break;
      case "turn_error":
        turn.error = event;
        break;
      case "turn_end":
        turn.ended = true;
        break;
      case "process_exit":
        turn.exited = true;
        break;
      default:
        break;
    }
  }

  function outcome(): TurnOutcome {
    if (isNeedsLogin(turn.error)) {
      return { kind: "needs_login" };
    }
    if (turn.rejected || turn.error?.errorKind === ERROR_KIND_RATE_LIMIT) {
      return {
        kind: "exhausted",
        resetsAt: exhaustedResetsAt(),
        rateLimitType: turn.limit?.rateLimitType ?? null,
      };
    }
    if (turn.error !== null) {
      return { kind: "failed", message: turn.error.message };
    }
    if (turn.exited && !turn.ended) {
      return { kind: "failed", message: "agent process exited" };
    }
    return { kind: "ok" };
  }

  function settle(): TurnOutcome {
    const result = outcome();
    turn = freshTurn();
    return result;
  }

  return { observe, settle, snapshot: () => latest };
}
