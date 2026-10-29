import {
  EPOCH_MILLIS_THRESHOLD,
  ERROR_KIND_AUTH_REQUIRED,
  ERROR_KIND_RATE_LIMIT,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from "../../domain/constants";
import type { EpochMillis, EpochSeconds } from "../../domain/types";

import {
  HTTP_FORBIDDEN,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  OpencodeErrorName,
  TURN_FAILED_MESSAGE,
} from "./constants";
import type { SessionErrorInfo } from "./protocol";

export type SessionErrorKind =
  typeof ERROR_KIND_RATE_LIMIT | typeof ERROR_KIND_AUTH_REQUIRED;

export interface SessionErrorClass {
  readonly errorKind: SessionErrorKind | null;
  readonly aborted: boolean;
  readonly message: string;
  readonly resetsAt: EpochSeconds | null;
}

type Headers = Readonly<Record<string, string>>;

const RETRY_AFTER_HEADER = "retry-after";
const RESET_HEADER_PREFIX = "x-ratelimit-reset";
const NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;
const DURATION_PATTERN =
  /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * SECONDS_PER_MINUTE;

function lowerCased(headers: Headers): Headers {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function futureSeconds(
  targetMs: EpochMillis,
  nowMs: EpochMillis,
): EpochSeconds | null {
  return targetMs > nowMs ? Math.ceil(targetMs / MS_PER_SECOND) : null;
}

function parseRetryAfter(
  value: string,
  nowMs: EpochMillis,
): EpochSeconds | null {
  if (NUMBER_PATTERN.test(value)) {
    return futureSeconds(nowMs + Number(value) * MS_PER_SECOND, nowMs);
  }
  return futureSeconds(Date.parse(value), nowMs);
}

function durationSeconds(value: string): number | null {
  const match = DURATION_PATTERN.exec(value);
  if (value === "" || match === null) {
    return null;
  }
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    Number(hours) * SECONDS_PER_HOUR +
    Number(minutes) * SECONDS_PER_MINUTE +
    Number(seconds)
  );
}

function parseReset(value: string, nowMs: EpochMillis): EpochSeconds | null {
  if (NUMBER_PATTERN.test(value)) {
    const epoch = Number(value);
    return futureSeconds(
      epoch >= EPOCH_MILLIS_THRESHOLD ? epoch : epoch * MS_PER_SECOND,
      nowMs,
    );
  }
  const seconds = durationSeconds(value);
  return seconds === null
    ? null
    : futureSeconds(nowMs + seconds * MS_PER_SECOND, nowMs);
}

export function resetsAtFromHeaders(
  headers: Headers,
  nowMs: EpochMillis,
): EpochSeconds | null {
  const named = lowerCased(headers);
  const retryAfter = named[RETRY_AFTER_HEADER];
  const fromRetryAfter =
    retryAfter === undefined ? null : parseRetryAfter(retryAfter, nowMs);
  if (fromRetryAfter !== null) {
    return fromRetryAfter;
  }
  const resets = Object.entries(named)
    .filter(([name]) => name.startsWith(RESET_HEADER_PREFIX))
    .map(([, value]) => parseReset(value, nowMs))
    .filter((resetsAt) => resetsAt !== null);
  return resets.length === 0 ? null : Math.max(...resets);
}

function kindOf(statusCode: number | undefined): SessionErrorKind | null {
  switch (statusCode) {
    case HTTP_TOO_MANY_REQUESTS:
      return ERROR_KIND_RATE_LIMIT;
    case HTTP_UNAUTHORIZED:
    case HTTP_FORBIDDEN:
      return ERROR_KIND_AUTH_REQUIRED;
    default:
      return null;
  }
}

function messageOf(error: SessionErrorInfo | undefined): string {
  return error?.data?.message ?? error?.name ?? TURN_FAILED_MESSAGE;
}

export function classifySessionError(
  error: SessionErrorInfo | undefined,
  nowMs: EpochMillis,
): SessionErrorClass {
  const errorKind = kindOf(error?.data?.statusCode);
  return {
    errorKind,
    aborted: error?.name === OpencodeErrorName.aborted,
    message: messageOf(error),
    resetsAt:
      errorKind === ERROR_KIND_RATE_LIMIT
        ? resetsAtFromHeaders(error?.data?.responseHeaders ?? {}, nowMs)
        : null,
  };
}
