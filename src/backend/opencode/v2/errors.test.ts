import { describe, expect, it } from "vitest";

import { classifyExecutionError } from "./errors";
import type { ExecutionError } from "./protocol";

const NOW_MS = 1_700_000_000_000;
const NOW_S = 1_700_000_000;

const RATE_LIMIT_TYPES = [
  "provider.rate-limit",
  "provider.go-limit",
  "provider.quota",
  "provider.free-limit",
  "provider.budget-limit",
  "provider.model-budget-limit",
  "provider.chatgpt-limit",
];

function failure(overrides: Partial<ExecutionError>): ExecutionError {
  return { type: "provider.unknown", message: "boom", ...overrides };
}

describe("classifyExecutionError", () => {
  it.each(RATE_LIMIT_TYPES)("%s_is_a_rate_limit", (type) => {
    expect(classifyExecutionError(failure({ type }), NOW_MS)).toEqual({
      errorKind: "rate_limit",
      aborted: false,
      message: "boom",
      resetsAt: null,
    });
  });

  it("go_limit_resets_after_retry_after_ms", () => {
    expect(
      classifyExecutionError(
        failure({
          type: "provider.go-limit",
          message: "OpenCode Go 5 hour usage limit reached.",
          status: 429,
          retryAfterMs: 120_000,
        }),
        NOW_MS,
      ),
    ).toEqual({
      errorKind: "rate_limit",
      aborted: false,
      message: "OpenCode Go 5 hour usage limit reached.",
      resetsAt: NOW_S + 120,
    });
  });

  it("reset_rounds_up_to_whole_seconds", () => {
    expect(
      classifyExecutionError(
        failure({ type: "provider.rate-limit", retryAfterMs: 1500 }),
        NOW_MS,
      ).resetsAt,
    ).toBe(NOW_S + 2);
  });

  it("rate_limit_without_retry_after_has_no_reset", () => {
    expect(
      classifyExecutionError(failure({ type: "provider.quota" }), NOW_MS)
        .resetsAt,
    ).toBeNull();
  });

  it("zero_retry_after_has_no_reset", () => {
    expect(
      classifyExecutionError(
        failure({ type: "provider.rate-limit", retryAfterMs: 0 }),
        NOW_MS,
      ).resetsAt,
    ).toBeNull();
  });
});

describe("classifyExecutionError kinds", () => {
  it("status_429_alone_is_a_rate_limit", () => {
    expect(
      classifyExecutionError(
        failure({ type: "provider.unknown", status: 429, retryAfterMs: 1000 }),
        NOW_MS,
      ),
    ).toMatchObject({ errorKind: "rate_limit", resetsAt: NOW_S + 1 });
  });

  it("retry_after_is_ignored_for_other_kinds", () => {
    expect(
      classifyExecutionError(
        failure({ type: "provider.auth", retryAfterMs: 1000 }),
        NOW_MS,
      ).resetsAt,
    ).toBeNull();
  });

  it.each([
    ["provider.auth", undefined],
    ["provider.unknown", 401],
    ["provider.unknown", 403],
  ])("provider_auth_and_401_403_need_login_%s_%s", (type, status) => {
    expect(
      classifyExecutionError(failure({ type, status }), NOW_MS).errorKind,
    ).toBe("auth_required");
  });
});

describe("classifyExecutionError plain errors", () => {
  it("aborted_is_flagged", () => {
    expect(
      classifyExecutionError(
        failure({ type: "aborted", message: "Step interrupted" }),
        NOW_MS,
      ),
    ).toEqual({
      errorKind: null,
      aborted: true,
      message: "Step interrupted",
      resetsAt: null,
    });
  });

  it("unknown_type_is_a_plain_error", () => {
    expect(
      classifyExecutionError(failure({ type: "tool.execution" }), NOW_MS),
    ).toEqual({
      errorKind: null,
      aborted: false,
      message: "boom",
      resetsAt: null,
    });
  });

  it("missing_error_falls_back_to_the_generic_message", () => {
    expect(classifyExecutionError(undefined, NOW_MS)).toEqual({
      errorKind: null,
      aborted: false,
      message: "Turn failed",
      resetsAt: null,
    });
  });

  it("empty_message_falls_back_to_the_generic_message", () => {
    expect(
      classifyExecutionError(failure({ message: "" }), NOW_MS).message,
    ).toBe("Turn failed");
  });
});
