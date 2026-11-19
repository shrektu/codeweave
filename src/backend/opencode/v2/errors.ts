import {
  ERROR_KIND_AUTH_REQUIRED,
  ERROR_KIND_RATE_LIMIT,
  MS_PER_SECOND,
} from "../../../domain/constants";
import type { EpochMillis, EpochSeconds } from "../../../domain/types";
import {
  HTTP_FORBIDDEN,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  TURN_FAILED_MESSAGE,
} from "../constants";
import type { SessionErrorClass, SessionErrorKind } from "../errors";

import {
  NO_ROUTE_CONSOLE_LOGIN_HINT,
  OpencodeV2ErrorType,
  RATE_LIMIT_ERROR_TYPES,
} from "./constants";
import type { ExecutionError } from "./protocol";

function kindOf(error: ExecutionError | undefined): SessionErrorKind | null {
  if (error === undefined) {
    return null;
  }
  if (
    RATE_LIMIT_ERROR_TYPES.includes(error.type) ||
    error.status === HTTP_TOO_MANY_REQUESTS
  ) {
    return ERROR_KIND_RATE_LIMIT;
  }
  if (
    error.type === OpencodeV2ErrorType.auth ||
    error.status === HTTP_UNAUTHORIZED ||
    error.status === HTTP_FORBIDDEN
  ) {
    return ERROR_KIND_AUTH_REQUIRED;
  }
  return null;
}

function resetsAtOf(
  error: ExecutionError | undefined,
  nowMs: EpochMillis,
): EpochSeconds | null {
  const retryAfterMs = error?.retryAfterMs ?? 0;
  return retryAfterMs > 0
    ? Math.ceil((nowMs + retryAfterMs) / MS_PER_SECOND)
    : null;
}

function messageOf(
  error: ExecutionError | undefined,
  consoleLogin: boolean,
): string {
  if (error === undefined || error.message === "") {
    return TURN_FAILED_MESSAGE;
  }
  return consoleLogin && error.type === OpencodeV2ErrorType.noRoute
    ? `${error.message}${NO_ROUTE_CONSOLE_LOGIN_HINT}`
    : error.message;
}

export function classifyExecutionError(
  error: ExecutionError | undefined,
  nowMs: EpochMillis,
  consoleLogin = false,
): SessionErrorClass {
  const errorKind = kindOf(error);
  return {
    errorKind,
    aborted: error?.type === OpencodeV2ErrorType.aborted,
    message: messageOf(error, consoleLogin),
    resetsAt:
      errorKind === ERROR_KIND_RATE_LIMIT ? resetsAtOf(error, nowMs) : null,
  };
}
