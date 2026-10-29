import { describe, expect, it } from "vitest";

import { classifySessionError, resetsAtFromHeaders } from "./errors";

const NOW_MS = 1_700_000_000_000;
const NOW_S = 1_700_000_000;

type Headers = Record<string, string>;
type ResolvedCase = readonly [string, Headers, number];

const RESOLVED_CASES: readonly ResolvedCase[] = [
  ["retry_after_seconds", { "retry-after": "120" }, NOW_S + 120],
  ["retry_after_fraction_rounds_up", { "retry-after": "1.5" }, NOW_S + 2],
  [
    "retry_after_http_date",
    { "Retry-After": "Tue, 14 Nov 2023 22:15:20 GMT" },
    NOW_S + 120,
  ],
  [
    "reset_epoch_seconds",
    { "x-ratelimit-reset": String(NOW_S + 90) },
    NOW_S + 90,
  ],
  [
    "reset_epoch_millis",
    { "x-ratelimit-reset-requests": String(NOW_MS + 90_000) },
    NOW_S + 90,
  ],
  [
    "reset_go_duration_full",
    { "x-ratelimit-reset-tokens": "1h2m3.5s" },
    NOW_S + 3724,
  ],
  [
    "reset_go_duration_seconds_only",
    { "x-ratelimit-reset-requests": "59.56s" },
    NOW_S + 60,
  ],
  [
    "reset_go_duration_minutes_only",
    { "x-ratelimit-reset": "2m" },
    NOW_S + 120,
  ],
  [
    "longest_reset_wins",
    {
      "x-ratelimit-reset-tokens": "6s",
      "x-ratelimit-reset-requests": "2m",
    },
    NOW_S + 120,
  ],
  [
    "retry_after_beats_reset_headers",
    { "retry-after": "10", "x-ratelimit-reset": "2m" },
    NOW_S + 10,
  ],
  [
    "invalid_retry_after_falls_back_to_reset",
    { "retry-after": "soon", "x-ratelimit-reset": "2m" },
    NOW_S + 120,
  ],
];

const NULL_CASES: readonly (readonly [string, Headers])[] = [
  ["no_headers", {}],
  ["unrelated_headers", { "content-type": "text/plain" }],
  ["garbage_retry_after", { "retry-after": "abc" }],
  ["zero_retry_after", { "retry-after": "0" }],
  ["past_http_date", { "retry-after": "Tue, 14 Nov 2023 22:00:00 GMT" }],
  ["past_epoch_seconds", { "x-ratelimit-reset": String(NOW_S - 5) }],
  ["unitless_garbage_reset", { "x-ratelimit-reset": "5 minutes" }],
  ["empty_reset", { "x-ratelimit-reset": "" }],
  ["millisecond_unit_is_not_a_go_duration", { "x-ratelimit-reset": "500ms" }],
];

describe("resetsAtFromHeaders", () => {
  it.each(RESOLVED_CASES)("%s", (_name, headers, expected) => {
    expect(resetsAtFromHeaders(headers, NOW_MS)).toBe(expected);
  });

  it.each(NULL_CASES)("%s_is_null", (_name, headers) => {
    expect(resetsAtFromHeaders(headers, NOW_MS)).toBeNull();
  });
});

describe("classifySessionError", () => {
  it("rate_limit_carries_resets_at_from_headers", () => {
    expect(
      classifySessionError(
        {
          name: "APIError",
          data: {
            message: "slow down",
            statusCode: 429,
            responseHeaders: { "retry-after": "30" },
          },
        },
        NOW_MS,
      ),
    ).toEqual({
      errorKind: "rate_limit",
      aborted: false,
      message: "slow down",
      resetsAt: NOW_S + 30,
    });
  });

  it.each([401, 403])("status_%i_is_auth_required", (statusCode) => {
    expect(
      classifySessionError({ name: "APIError", data: { statusCode } }, NOW_MS),
    ).toMatchObject({ errorKind: "auth_required", resetsAt: null });
  });

  it("aborted_error_is_flagged", () => {
    expect(
      classifySessionError({ name: "MessageAbortedError" }, NOW_MS),
    ).toEqual({
      errorKind: null,
      aborted: true,
      message: "MessageAbortedError",
      resetsAt: null,
    });
  });

  it("other_status_and_missing_error_are_unclassified", () => {
    expect(
      classifySessionError(
        { name: "APIError", data: { statusCode: 500, message: "boom" } },
        NOW_MS,
      ),
    ).toEqual({
      errorKind: null,
      aborted: false,
      message: "boom",
      resetsAt: null,
    });
    expect(classifySessionError(undefined, NOW_MS)).toEqual({
      errorKind: null,
      aborted: false,
      message: "Turn failed",
      resetsAt: null,
    });
  });
});
