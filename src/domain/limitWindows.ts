import {
  RATE_LIMIT_TYPE_FIVE_HOUR,
  RATE_LIMIT_TYPE_SEVEN_DAY,
} from "./constants";
import type { EpochSeconds } from "./types";

export interface LimitWindow {
  readonly id: string;
  readonly scope: string | null;
  readonly period: string | null;
  readonly utilization: number | null;
  readonly resetsAt: EpochSeconds | null;
  readonly exhausted: boolean;
}

export const LimitPeriod = {
  fiveHour: RATE_LIMIT_TYPE_FIVE_HOUR,
  sevenDay: RATE_LIMIT_TYPE_SEVEN_DAY,
  monthly: "monthly",
} as const;

export interface RateLimitTypeInput {
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly resetsAt: EpochSeconds | null;
  readonly exhausted: boolean;
}

const SEVEN_DAY_OPUS_TYPE = "seven_day_opus";
const SEVEN_DAY_SONNET_TYPE = "seven_day_sonnet";
const SCOPE_OPUS = "Opus";
const SCOPE_SONNET = "Sonnet";
const SCOPE_SEPARATOR = ":";

export function scopedWindowId(period: string, scope: string | null): string {
  return scope === null
    ? period
    : `${period}${SCOPE_SEPARATOR}${scope.toLowerCase()}`;
}

export function mergeLimitWindows(
  previous: readonly LimitWindow[],
  next: readonly LimitWindow[],
): LimitWindow[] {
  const replacements = new Map(next.map((window) => [window.id, window]));
  const known = new Set(previous.map((window) => window.id));
  return [
    ...previous.map((window) => replacements.get(window.id) ?? window),
    ...next.filter((window) => !known.has(window.id)),
  ];
}

function scopeOfType(rateLimitType: string): string | null {
  switch (rateLimitType) {
    case SEVEN_DAY_OPUS_TYPE:
      return SCOPE_OPUS;
    case SEVEN_DAY_SONNET_TYPE:
      return SCOPE_SONNET;
    default:
      return null;
  }
}

export function windowOfRateLimitType(
  input: RateLimitTypeInput,
): LimitWindow | null {
  if (input.rateLimitType === null) {
    return null;
  }
  const scope = scopeOfType(input.rateLimitType);
  const period = scope === null ? input.rateLimitType : LimitPeriod.sevenDay;
  return {
    id: scopedWindowId(period, scope),
    scope,
    period,
    utilization: input.utilization,
    resetsAt: input.resetsAt,
    exhausted: input.exhausted,
  };
}
