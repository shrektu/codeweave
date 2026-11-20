import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScriptedAgyContainer,
  usageBucket,
  usageGroup,
  type Json,
} from "../../../tests/fakes/fakeAgy";
import { settlesWithin } from "../../../tests/fakes/fakeCodexAppServer";
import { StopFailureReason } from "../process/container";

import { UsageOutputSchema, type UsageOutput } from "./protocol";
import {
  exhaustedResetsAt,
  isExhausted,
  probeAgyUsage,
  probeResultOf,
  toAgyRateLimitEvent,
  type AgyLimits,
  type AgyProbeDeps,
} from "./usage";

const FIVE_HOUR_RESET = 1_793_364_876;
const WEEKLY_RESET = 1_793_614_882;
const TIMEOUT_MS = 60;
const GRACE_MS = 5;
const CONFIG_DIR = "/home/jane/accounts/gemini-1";

afterEach(() => {
  vi.restoreAllMocks();
});

function outputWith(groups: readonly Json[]): UsageOutput {
  return UsageOutputSchema.parse({
    status: "SUCCESS",
    command: { data: { groups } },
  });
}

function errorOutput(error: string): UsageOutput {
  return UsageOutputSchema.parse({ status: "ERROR", error });
}

function geminiBuckets(...buckets: Json[]): UsageOutput {
  return outputWith([usageGroup("Gemini Models", buckets)]);
}

function limitsOf(output: UsageOutput): AgyLimits {
  const result = probeResultOf(output);
  if (result.kind !== "limits") {
    throw new Error(`expected limits, got ${result.kind}`);
  }
  return result.limits;
}

describe("agy usage parsing", () => {
  it("usage_with_every_group_empty_has_no_limits", () => {
    expect(probeResultOf(outputWith([]))).toEqual({ kind: "no_limits" });
    expect(probeResultOf(geminiBuckets())).toEqual({ kind: "no_limits" });
    expect(
      probeResultOf(outputWith([usageGroup("Claude and GPT models", [])])),
    ).toEqual({ kind: "no_limits" });
  });

  it("other_groups_alone_report_windows_without_binding", () => {
    const limits = limitsOf(
      outputWith([
        usageGroup("Claude and GPT models", [
          usageBucket("3p-5h", "5h", 0.4, "2026-10-30T15:41:01Z"),
        ]),
      ]),
    );

    expect(limits.buckets).toEqual([]);
    expect(limits.others).toHaveLength(1);
    expect(toAgyRateLimitEvent(limits)).toEqual({
      type: "rate_limit",
      status: "allowed",
      resetsAt: null,
      rateLimitType: null,
      utilization: null,
      windows: [
        {
          id: "Claude and GPT models/3p-5h/5h",
          scope: "5h limit",
          period: "five_hour",
          utilization: 0.6,
          resetsAt: 1_793_374_861,
          exhausted: false,
        },
      ],
    });
  });

  it("other_group_exhaustion_does_not_exhaust_the_account", () => {
    const limits = limitsOf(
      outputWith([
        usageGroup("Gemini Models", [
          usageBucket("g-5h", "5h", 0.5, "2026-10-30T12:54:36Z"),
        ]),
        usageGroup("Gemini 4 Argon", [
          usageBucket("a-weekly", "weekly", 0, "2026-11-02T10:21:22Z"),
        ]),
      ]),
    );

    expect(isExhausted(limits)).toBe(false);
    expect(exhaustedResetsAt(limits)).toBeNull();
    expect(toAgyRateLimitEvent(limits)).toMatchObject({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
    });
  });

  it("bucket_without_window_reset_or_name_still_maps", () => {
    const limits = limitsOf(
      outputWith([
        usageGroup("Gemini Models", [{ id: "bare", remaining_fraction: 0.5 }]),
      ]),
    );

    expect(toAgyRateLimitEvent(limits)?.windows).toEqual([
      {
        id: "Gemini Models/bare/-",
        scope: "Gemini Models",
        period: null,
        utilization: 0.5,
        resetsAt: null,
        exhausted: false,
      },
    ]);
  });

  it("duplicate_bucket_ids_get_unique_window_ids", () => {
    const limits = limitsOf(
      geminiBuckets(
        usageBucket("dup", "5h", 0.5, "2026-10-30T12:54:36Z"),
        usageBucket("dup", "5h", 0.4, "2026-10-30T12:54:36Z"),
        usageBucket("dup", "5h", 0.3, "2026-10-30T12:54:36Z"),
      ),
    );

    expect(
      toAgyRateLimitEvent(limits)?.windows?.map((item) => item.id),
    ).toEqual([
      "Gemini Models/dup/5h",
      "Gemini Models/dup/5h#1",
      "Gemini Models/dup/5h#2",
    ]);
  });

  it.each([
    ["without others", []],
    [
      "with others",
      [
        usageGroup("Gemini 4 Argon", [
          usageBucket("a-weekly", "weekly", 0.01, "2026-11-02T10:21:22Z"),
        ]),
      ],
    ],
  ])("binding_fields_are_identical_%s", (_name, others) => {
    const base = [
      usageGroup("Gemini Models", [
        usageBucket("g-weekly", "weekly", 0.75, "2026-11-02T10:21:22Z"),
        usageBucket("g-5h", "5h", 0.5, "2026-10-30T12:54:36Z"),
      ]),
    ];

    const event = toAgyRateLimitEvent(
      limitsOf(outputWith([...base, ...others])),
    );

    expect(event).toMatchObject({
      status: "allowed",
      resetsAt: FIVE_HOUR_RESET,
      rateLimitType: "five_hour",
      utilization: 0.5,
    });
  });

  it("error_status_is_needs_login_only_for_the_auth_message", () => {
    const auth = errorOutput("authentication failed or timed out");
    const other = errorOutput("agent executor error");

    expect(probeResultOf(auth)).toEqual({ kind: "needs_login" });
    expect(probeResultOf(other)).toEqual({ kind: "failed" });
    expect(
      probeResultOf(UsageOutputSchema.parse({ status: "SUCCESS" })),
    ).toEqual({ kind: "failed" });
  });

  it("buckets_become_epoch_seconds_and_bad_reset_time_becomes_null", () => {
    const limits = limitsOf(
      geminiBuckets(
        usageBucket("gemini-5h", "5h", 0.5, "2026-10-30T12:54:36Z"),
        usageBucket("gemini-weekly", "weekly", 0.25, "not a date"),
      ),
    );

    expect(limits.buckets).toEqual([
      {
        id: "gemini-5h",
        name: "5h limit",
        group: "Gemini Models",
        window: "5h",
        remainingFraction: 0.5,
        resetsAt: FIVE_HOUR_RESET,
      },
      {
        id: "gemini-weekly",
        name: "weekly limit",
        group: "Gemini Models",
        window: "weekly",
        remainingFraction: 0.25,
        resetsAt: null,
      },
    ]);
  });

  it("exhausted_reset_is_the_latest_among_exhausted_buckets_only", () => {
    const limits = limitsOf(
      geminiBuckets(
        usageBucket("gemini-5h", "5h", 0, "2026-10-30T12:54:36Z"),
        usageBucket("gemini-weekly", "weekly", 0, "2026-11-02T10:21:22Z"),
        usageBucket("gemini-flash", "weekly", 0.9, "2026-12-01T00:00:00Z"),
      ),
    );

    expect(isExhausted(limits)).toBe(true);
    expect(exhaustedResetsAt(limits)).toBe(WEEKLY_RESET);
  });
});

describe("agy rate limit event", () => {
  it("allowed_event_describes_the_most_used_bucket", () => {
    const limits = limitsOf(
      geminiBuckets(
        usageBucket("gemini-weekly", "weekly", 0.75, "2026-11-02T10:21:22Z"),
        usageBucket("gemini-5h", "5h", 0.5, "2026-10-30T12:54:36Z"),
      ),
    );

    expect(toAgyRateLimitEvent(limits)).toEqual({
      type: "rate_limit",
      status: "allowed",
      resetsAt: FIVE_HOUR_RESET,
      rateLimitType: "five_hour",
      utilization: 0.5,
      windows: [
        {
          id: "Gemini Models/gemini-weekly/weekly",
          scope: "weekly limit",
          period: "seven_day",
          utilization: 0.25,
          resetsAt: WEEKLY_RESET,
          exhausted: false,
        },
        {
          id: "Gemini Models/gemini-5h/5h",
          scope: "5h limit",
          period: "five_hour",
          utilization: 0.5,
          resetsAt: FIVE_HOUR_RESET,
          exhausted: false,
        },
      ],
    });
  });

  it("forced_rejection_without_an_exhausted_bucket_has_null_reset", () => {
    const limits = limitsOf(
      geminiBuckets(
        usageBucket("gemini-5h", "5h", 0.4, "2026-10-30T12:54:36Z"),
      ),
    );

    expect(toAgyRateLimitEvent(limits, true)).toEqual({
      type: "rate_limit",
      status: "rejected",
      resetsAt: null,
      rateLimitType: null,
      utilization: null,
      windows: [
        {
          id: "Gemini Models/gemini-5h/5h",
          scope: "5h limit",
          period: "five_hour",
          utilization: 0.6,
          resetsAt: FIVE_HOUR_RESET,
          exhausted: false,
        },
      ],
    });
  });

  it("exhausted_bucket_with_a_bad_reset_time_is_rejected_with_null_reset", () => {
    const limits = limitsOf(
      geminiBuckets(usageBucket("gemini-weekly", "weekly", 0, "")),
    );

    expect(toAgyRateLimitEvent(limits)).toEqual({
      type: "rate_limit",
      status: "rejected",
      resetsAt: null,
      rateLimitType: "seven_day",
      utilization: 1,
      windows: [
        {
          id: "Gemini Models/gemini-weekly/weekly",
          scope: "weekly limit",
          period: "seven_day",
          utilization: 1,
          resetsAt: null,
          exhausted: true,
        },
      ],
    });
  });

  it("missing_limits_yield_an_event_only_when_rejection_is_forced", () => {
    expect(toAgyRateLimitEvent(null)).toBeNull();
    expect(toAgyRateLimitEvent(null, true)).toMatchObject({
      status: "rejected",
      resetsAt: null,
    });
  });

  it("unknown_windows_keep_their_own_name_as_the_limit_type", () => {
    const limits = limitsOf(
      geminiBuckets(
        usageBucket("gemini-30d", "30d", 0.9, "2026-11-30T00:00:00Z"),
      ),
    );

    expect(toAgyRateLimitEvent(limits)).toMatchObject({
      rateLimitType: "30d",
    });
  });
});

function depsFor(
  container: ScriptedAgyContainer,
  overrides: Partial<AgyProbeDeps> = {},
): AgyProbeDeps {
  return {
    container,
    executable: "/opt/agy",
    configDir: CONFIG_DIR,
    cwd: "/work/repo",
    env: { PATH: "/usr/bin" },
    runId: "probe-1",
    timeoutMs: TIMEOUT_MS,
    stopGraceMs: GRACE_MS,
    ...overrides,
  };
}

describe("agy usage probe", () => {
  it("healthy_output_yields_limits_and_stops_the_probe", async () => {
    const container = new ScriptedAgyContainer();

    const result = await probeAgyUsage(depsFor(container));

    expect(result.kind).toBe("limits");
    expect(container.spawns[0]?.spec).toMatchObject({
      command: "/opt/agy",
      args: [
        "-p",
        "/usage",
        "--output-format",
        "json",
        `--gemini_dir=${resolve(CONFIG_DIR)}`,
      ],
      cwd: "/work/repo",
      runId: "probe-1",
      env: { PATH: "/usr/bin" },
    });
    expect(container.runningCount()).toBe(0);
  });

  it("logged_out_start_does_not_hang", async () => {
    const container = new ScriptedAgyContainer();
    container.scriptUsage({ kind: "logged_out" });

    const probing = probeAgyUsage(depsFor(container, { timeoutMs: 2000 }));

    expect(await settlesWithin(probing, 500)).toBe(true);
    expect(await probing).toEqual({ kind: "needs_login" });
    expect(container.runningCount()).toBe(0);
    expect(container.spawns[0]?.contained.stopCalls).toEqual([GRACE_MS]);
  });

  it("auth_error_json_is_needs_login", async () => {
    const container = new ScriptedAgyContainer();
    container.scriptUsage({ kind: "auth_error_json" });

    expect(await probeAgyUsage(depsFor(container))).toEqual({
      kind: "needs_login",
    });
    expect(container.runningCount()).toBe(0);
  });
});

describe("agy usage probe failures", () => {
  it("non_json_output_is_failed", async () => {
    const container = new ScriptedAgyContainer();
    container.scriptUsage({ kind: "garbage" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await probeAgyUsage(depsFor(container))).toEqual({ kind: "failed" });
    expect(container.runningCount()).toBe(0);
  });

  it("a_hanging_probe_is_failed_after_the_timeout_and_killed", async () => {
    const container = new ScriptedAgyContainer();
    container.scriptUsage({ kind: "hang" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await probeAgyUsage(depsFor(container))).toEqual({ kind: "failed" });
    expect(container.runningCount()).toBe(0);
  });

  it("a_probe_that_cannot_be_stopped_is_unstopped", async () => {
    const container = new ScriptedAgyContainer();
    container.scriptProbeProcess({
      stopResults: [
        {
          ok: false,
          reason: StopFailureReason.notEmptyAfterTimeout,
          survivors: [4242],
        },
      ],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await probeAgyUsage(depsFor(container))).toEqual({
      kind: "unstopped",
    });
  });

  it("probe_aborts_on_signal", async () => {
    const container = new ScriptedAgyContainer();
    container.scriptUsage({ kind: "hang" });
    const controller = new AbortController();
    const probing = probeAgyUsage(
      depsFor(container, { timeoutMs: 10_000, signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(container.spawns).toHaveLength(1);
    });

    controller.abort();

    expect(await settlesWithin(probing, 2000)).toBe(true);
    expect(await probing).toEqual({ kind: "failed" });
    expect(container.runningCount()).toBe(0);
    expect(container.spawns[0]?.contained.stopCalls).toEqual([GRACE_MS]);
  });

  it("probe_skips_spawn_when_aborted", async () => {
    const container = new ScriptedAgyContainer();

    const result = await probeAgyUsage(
      depsFor(container, { signal: AbortSignal.abort() }),
    );

    expect(result).toEqual({ kind: "failed" });
    expect(container.spawns).toHaveLength(0);
  });

  it("a_spawn_failure_is_failed", async () => {
    const container = new ScriptedAgyContainer();
    container.spawnFailure = new Error("ENOENT");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await probeAgyUsage(depsFor(container))).toEqual({ kind: "failed" });
  });
});
