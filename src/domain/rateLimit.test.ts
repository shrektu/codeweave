import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./events";
import { createRateLimitDetector, type TurnOutcome } from "./rateLimit";

const NOW_MS = 1_700_000_000_000;
const NOW_S = 1_700_000_000;
const COOLDOWN_RESET = 1_700_003_600;

const RATE_LIMIT_ERROR: AgentEvent = {
  type: "turn_error",
  errorKind: "rate_limit",
  rpcCode: null,
  message: "limit",
};

function limitEvent(
  status: string,
  resetsAt: unknown,
  rateLimitType: unknown = "five_hour",
): AgentEvent {
  return {
    type: "rate_limit",
    status,
    resetsAt,
    rateLimitType,
    utilization: 0.5,
  };
}

function settleTurn(events: readonly AgentEvent[]): TurnOutcome {
  const detector = createRateLimitDetector(() => NOW_MS);
  events.forEach((event) => {
    detector.observe(event);
  });
  return detector.settle();
}

describe("rate limit detector: resetsAt normalisation", () => {
  it("detector_normalizes_resets_at_seconds", () => {
    const outcome = settleTurn([
      limitEvent("rejected", (NOW_S + 500) * 1000),
      RATE_LIMIT_ERROR,
    ]);

    expect(outcome).toEqual({
      kind: "exhausted",
      resetsAt: 1_700_000_500,
      rateLimitType: "five_hour",
    });
  });

  it("keeps a resetsAt that is already in seconds", () => {
    const outcome = settleTurn([
      limitEvent("rejected", 1_700_000_500),
      RATE_LIMIT_ERROR,
    ]);

    expect(outcome).toMatchObject({ resetsAt: 1_700_000_500 });
  });

  it.each<[string, unknown]>([
    ["missing", undefined],
    ["a string", "soon"],
    ["null", null],
    ["in the past", NOW_S - 10],
    ["in the past in milliseconds", (NOW_S - 10) * 1000],
  ])("falls back to the cooldown when resetsAt is %s", (_name, resetsAt) => {
    const outcome = settleTurn([
      limitEvent("rejected", resetsAt),
      RATE_LIMIT_ERROR,
    ]);

    expect(outcome).toMatchObject({
      kind: "exhausted",
      resetsAt: COOLDOWN_RESET,
    });
  });

  it("uses the cooldown when the turn failed without any limit event", () => {
    expect(settleTurn([RATE_LIMIT_ERROR])).toEqual({
      kind: "exhausted",
      resetsAt: COOLDOWN_RESET,
      rateLimitType: null,
    });
  });

  it("uses the resetsAt of the last limit event of the turn", () => {
    const outcome = settleTurn([
      limitEvent("allowed_warning", NOW_S + 100),
      limitEvent("rejected", NOW_S + 900),
      RATE_LIMIT_ERROR,
    ]);

    expect(outcome).toMatchObject({ resetsAt: NOW_S + 900 });
  });
});

describe("rate limit detector: types and outcomes", () => {
  it("keeps an unknown rateLimitType string", () => {
    const outcome = settleTurn([
      limitEvent("rejected", NOW_S + 60, "seven_day_opus"),
      RATE_LIMIT_ERROR,
    ]);

    expect(outcome).toMatchObject({ rateLimitType: "seven_day_opus" });
  });

  it("ignores a rateLimitType of the wrong type", () => {
    const outcome = settleTurn([
      limitEvent("rejected", NOW_S + 60, 42),
      RATE_LIMIT_ERROR,
    ]);

    expect(outcome).toMatchObject({ rateLimitType: null });
  });

  it("treats a rejected event as exhausted when the turn ends normally", () => {
    const outcome = settleTurn([
      limitEvent("rejected", NOW_S + 60),
      { type: "turn_end", stopReason: "end_turn" },
    ]);

    expect(outcome).toMatchObject({ kind: "exhausted", resetsAt: NOW_S + 60 });
  });

  it("stays ok for api_retry and allowed_warning", () => {
    const outcome = settleTurn([
      { type: "api_retry" },
      limitEvent("allowed_warning", NOW_S + 60),
      { type: "turn_end", stopReason: "end_turn" },
    ]);

    expect(outcome).toEqual({ kind: "ok" });
  });

  it("reports a generic turn error as failed", () => {
    const outcome = settleTurn([
      {
        type: "turn_error",
        errorKind: "server",
        rpcCode: null,
        message: "boom",
      },
    ]);

    expect(outcome).toEqual({ kind: "failed", message: "boom" });
  });

  it("reports a process exit without a turn end as failed", () => {
    expect(settleTurn([{ type: "process_exit" }])).toEqual({
      kind: "failed",
      message: "agent process exited",
    });
  });
});

describe("rate limit detector: login and state", () => {
  it.each<[string, string | null, number | null]>([
    ["errorKind auth_required", "auth_required", null],
    ["rpc -32000 without errorKind", null, -32000],
  ])("maps %s to needs_login", (_name, errorKind, rpcCode) => {
    const outcome = settleTurn([
      { type: "turn_error", errorKind, rpcCode, message: "auth" },
    ]);

    expect(outcome).toEqual({ kind: "needs_login" });
  });

  it("does not treat rpc -32000 with an errorKind as needs_login", () => {
    const outcome = settleTurn([
      { type: "turn_error", errorKind: "other", rpcCode: -32000, message: "x" },
    ]);

    expect(outcome).toEqual({ kind: "failed", message: "x" });
  });

  it("settle resets the per-turn state", () => {
    const detector = createRateLimitDetector(() => NOW_MS);
    detector.observe(limitEvent("rejected", NOW_S + 60));
    detector.observe(RATE_LIMIT_ERROR);
    detector.settle();
    detector.observe({ type: "turn_end", stopReason: "end_turn" });

    expect(detector.settle()).toEqual({ kind: "ok" });
  });

  it("exposes the latest normalised snapshot across turns", () => {
    const detector = createRateLimitDetector(() => NOW_MS);
    detector.observe(limitEvent("allowed_warning", (NOW_S + 60) * 1000));
    detector.settle();

    expect(detector.snapshot()).toEqual({
      status: "allowed_warning",
      resetsAt: NOW_S + 60,
      rateLimitType: "five_hour",
      utilization: 0.5,
      windows: [
        {
          id: "five_hour",
          scope: null,
          period: "five_hour",
          utilization: 0.5,
          resetsAt: NOW_S + 60,
          exhausted: false,
        },
      ],
    });
  });

  it("snapshot_keeps_event_windows", () => {
    const detector = createRateLimitDetector(() => NOW_MS);
    const windows = [
      {
        id: "extra:five_hour",
        scope: "Extra",
        period: "five_hour",
        utilization: 0.2,
        resetsAt: null,
        exhausted: false,
      },
    ];

    detector.observe({
      type: "rate_limit",
      status: "allowed",
      resetsAt: null,
      rateLimitType: "five_hour",
      utilization: 0.5,
      windows,
    });

    expect(detector.snapshot()?.windows).toEqual(windows);
  });

  it("rejected_event_without_windows_derives_an_exhausted_window", () => {
    const detector = createRateLimitDetector(() => NOW_MS);

    detector.observe(limitEvent("rejected", null, "seven_day_opus"));

    expect(detector.snapshot()?.windows).toEqual([
      {
        id: "seven_day:opus",
        scope: "Opus",
        period: "seven_day",
        utilization: 0.5,
        resetsAt: null,
        exhausted: true,
      },
    ]);
  });
});
