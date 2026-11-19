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

import { OpencodeV2ErrorType, RATE_LIMIT_ERROR_TYPES } from "./constants";
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

export function classifyExecutionError(
  error: ExecutionError | undefined,
  nowMs: EpochMillis,
): SessionErrorClass {
  const errorKind = kindOf(error);
  return {
    errorKind,
    aborted: error?.type === OpencodeV2ErrorType.aborted,
    message:
      error === undefined || error.message === ""
        ? TURN_FAILED_MESSAGE
        : error.message,
    resetsAt:
      errorKind === ERROR_KIND_RATE_LIMIT ? resetsAtOf(error, nowMs) : null,
  };
}
