import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../domain/events";
import { PermissionProfile, type Account } from "../../domain/types";
import type {
  AgentAdapter,
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
} from "../agentAdapter";
import { StopFailureReason, type StopResult } from "../process/container";

import {
  createClaudeUsageProbe,
  parseUsageMarkdown,
  type ClaudeProbeResult,
} from "./usageProbe";

const NOW_MS = Date.UTC(2026, 10, 19, 12, 0);
const JANUARY_NOW_MS = Date.UTC(2026, 0, 1, 0, 30);
const DECEMBER_NOW_MS = Date.UTC(2025, 11, 31, 23, 30);
const GRACE_MS = 25;
const SHORT_TIMEOUT_MS = 30;
const LONG_TIMEOUT_MS = 5000;
const AUTH_RPC_CODE = -32000;
const EXECUTABLE = "/usr/bin/claude";
const RUN_ID = "probe-run-1";
const ACCOUNT: Account = {
  id: "claude-1",
  provider: "claude",
  label: "Claude",
  configDir: "/home/jane/.claude-1",
  order: 0,
};
const SURVIVORS: StopResult = {
  ok: false,
  reason: StopFailureReason.notEmptyAfterTimeout,
  survivors: [77],
};

const USAGE_TEXT = [
  "## Usage",
  "",
  "> Claude max subscription usage",
  "",
  "### Limits",
  "",
  "**5-hour limit** — **30%** · Resets Nov 19, 3:00 PM UTC",
  "",
  "`██████░░░░░░░░░░░░░░`",
  "",
  "**Weekly · all models** — **60%** · Resets Nov 21, 8:00 PM UTC",
  "",
  "**Weekly · Opus** — **100%** · Resets Nov 21, 9:00 PM UTC",
].join("\n");

function limitsOf(text: string, nowMs = NOW_MS): readonly unknown[] {
  const parsed = parseUsageMarkdown(text, nowMs);
  if (parsed.kind !== "limits") {
    throw new Error(`expected limits, got ${parsed.kind}`);
  }
  return parsed.windows;
}

function resetOf(reset: string, nowMs = NOW_MS): number | null {
  const [window] = limitsOf(
    `**5-hour limit** — **1%** · Resets ${reset}`,
    nowMs,
  );
  return (window as { resetsAt: number | null }).resetsAt;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("usage_markdown_maps_known_labels_to_windows", () => {
  expect(limitsOf(USAGE_TEXT)).toEqual([
    {
      id: "five_hour",
      scope: null,
      period: "five_hour",
      utilization: 0.3,
      resetsAt: 1_795_100_400,
      exhausted: false,
    },
    {
      id: "seven_day",
      scope: null,
      period: "seven_day",
      utilization: 0.6,
      resetsAt: 1_795_291_200,
      exhausted: false,
    },
    {
      id: "seven_day:opus",
      scope: "Opus",
      period: "seven_day",
      utilization: 1,
      resetsAt: 1_795_294_800,
      exhausted: true,
    },
  ]);
});

it("escaped_markdown_labels_unescape", () => {
  expect(
    limitsOf("**Weekly · my\\_model\\*** — **10%**\n**Odd \\[x\\]** — **5%**"),
  ).toEqual([
    {
      id: "seven_day:my_model*",
      scope: "my_model*",
      period: "seven_day",
      utilization: 0.1,
      resetsAt: null,
      exhausted: false,
    },
    {
      id: "limit:odd [x]",
      scope: "Odd [x]",
      period: null,
      utilization: 0.05,
      resetsAt: null,
      exhausted: false,
    },
  ]);
});

it("fractional_percent_is_kept", () => {
  expect(limitsOf("**5-hour limit** — **12.5%**")).toMatchObject([
    { utilization: 0.125 },
  ]);
});

it("missing_reset_keeps_window", () => {
  expect(limitsOf("**5-hour limit** — **42%**")).toEqual([
    {
      id: "five_hour",
      scope: null,
      period: "five_hour",
      utilization: 0.42,
      resetsAt: null,
      exhausted: false,
    },
  ]);
});

it("unknown_zone_reset_keeps_window_without_reset", () => {
  expect(resetOf("Nov 19, 3:00 PM PST")).toBeNull();
});

it("gmt_offset_reset_parses", () => {
  expect(resetOf("Nov 19, 5:30 PM GMT+2")).toBe(1_795_102_200);
  expect(resetOf("Nov 19, 9:00 AM GMT-8")).toBe(1_795_102_200 + 3600 * 1.5);
  expect(resetOf("Nov 19, 9:00 PM GMT+5:30")).toBe(1_795_102_200);
  expect(resetOf("Nov 19, 3:30 PM GMT")).toBe(1_795_102_200);
});

it("noon_and_midnight_use_twelve_hour_clock", () => {
  expect(resetOf("Nov 20, 12:00 AM UTC")).toBe(1_795_132_800);
  expect(resetOf("Nov 19, 12:00 PM UTC")).toBe(1_795_089_600);
});

it("narrow_no_break_space_before_meridiem_parses", () => {
  expect(resetOf("Nov 19, 3:30 PM UTC")).toBe(1_795_102_200);
});

it("december_reset_seen_in_january_picks_last_year", () => {
  expect(resetOf("Dec 31, 11:00 PM UTC", JANUARY_NOW_MS)).toBe(1_767_222_000);
});

it("january_reset_seen_in_december_picks_next_year", () => {
  expect(resetOf("Jan 1, 2:00 AM UTC", DECEMBER_NOW_MS)).toBe(1_767_232_800);
});

it("raw_usage_text_without_limits_fails", () => {
  expect(parseUsageMarkdown("You have used 5 hours today.", NOW_MS)).toEqual({
    kind: "failed",
  });
});

it("usage_without_limits_section_is_no_limits", () => {
  const text =
    "## Usage\n\n> Claude pro subscription usage\n\n### This session";

  expect(parseUsageMarkdown(text, NOW_MS)).toEqual({ kind: "no_limits" });
});

interface FakeHandle extends AgentHandle {
  readonly prompts: string[];
  cancels: number;
  stops: number[];
}

type PromptScript = (
  emit: (event: AgentEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

function fakeHandle(
  script: PromptScript,
  stopResult: StopResult | Error = { ok: true },
): FakeHandle {
  const listeners = new Set<(event: AgentEvent) => void>();
  const stopped = new AbortController();
  const handle: FakeHandle = {
    accountId: ACCOUNT.id,
    runId: RUN_ID,
    prompts: [],
    cancels: 0,
    stops: [],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: async (text) => {
      handle.prompts.push(text);
      await script((event) => {
        listeners.forEach((listener) => {
          listener(event);
        });
      }, stopped.signal);
    },
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => {
      handle.cancels += 1;
      return Promise.resolve();
    },
    stop: (graceMs) => {
      handle.stops.push(graceMs);
      stopped.abort();
      return stopResult instanceof Error
        ? Promise.reject(stopResult)
        : Promise.resolve(stopResult);
    },
  };
  return handle;
}

function textScript(text: string): PromptScript {
  return (emit) => {
    emit({ type: "text", text });
    emit({ type: "turn_end", stopReason: "end_turn" });
    return Promise.resolve();
  };
}

const HANGING: PromptScript = (_emit, signal) =>
  new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });

interface Probed {
  readonly result: ClaudeProbeResult;
  readonly specs: AgentStartSpec[];
}

async function runProbe(
  start: AgentStartResult,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Probed> {
  const specs: AgentStartSpec[] = [];
  const adapter: AgentAdapter = {
    start: (spec) => {
      specs.push(spec);
      return Promise.resolve(start);
    },
  };
  const probe = createClaudeUsageProbe({
    adapter,
    executable: () => Promise.resolve(EXECUTABLE),
    timeoutMs: options.timeoutMs ?? LONG_TIMEOUT_MS,
    stopGraceMs: GRACE_MS,
    newRunId: () => RUN_ID,
    now: () => NOW_MS,
  });
  const result = await probe(
    ACCOUNT,
    options.signal ?? new AbortController().signal,
  );
  return { result, specs };
}

it("probe_prompts_exactly_usage", async () => {
  const handle = fakeHandle(textScript(USAGE_TEXT));

  const { result, specs } = await runProbe({ ok: true, handle });

  expect(handle.prompts).toEqual(["/usage"]);
  expect(specs).toEqual([
    {
      account: ACCOUNT,
      cwd: ACCOUNT.configDir,
      profile: PermissionProfile.plan,
      runId: RUN_ID,
      executable: EXECUTABLE,
    },
  ]);
  expect(result).toMatchObject({ kind: "limits" });
  expect(handle.stops).toEqual([GRACE_MS]);
});

it("text_chunks_are_joined_in_order", async () => {
  const handle = fakeHandle((emit) => {
    emit({ type: "text", text: "## Usage\n\n### Limits\n\n**5-hour limit" });
    emit({ type: "text", text: "** — **30%**" });
    return Promise.resolve();
  });

  const { result } = await runProbe({ ok: true, handle });

  expect(result).toMatchObject({
    kind: "limits",
    limits: [{ id: "five_hour", utilization: 0.3 }],
  });
});

it("probe_stops_agent_after_auth_error", async () => {
  const handle = fakeHandle((emit) => {
    emit({
      type: "turn_error",
      errorKind: null,
      rpcCode: AUTH_RPC_CODE,
      message: "Auth required",
    });
    return Promise.resolve();
  });

  const { result } = await runProbe({ ok: true, handle });

  expect(result).toEqual({ kind: "needs_login" });
  expect(handle.stops).toEqual([GRACE_MS]);
});

it("start_failure_needs_login_is_needs_login", async () => {
  const { result } = await runProbe({
    ok: false,
    reason: "needs_login",
    message: "sign in",
  });

  expect(result).toEqual({ kind: "needs_login" });
});

it("other_start_failure_is_failed", async () => {
  const { result } = await runProbe({
    ok: false,
    reason: "error",
    message: "spawn failed",
  });

  expect(result).toEqual({ kind: "failed" });
});

it("usage_without_limits_section_reports_no_limits", async () => {
  const handle = fakeHandle(textScript("## Usage\n\n### This session"));

  const { result } = await runProbe({ ok: true, handle });

  expect(result).toEqual({ kind: "no_limits" });
});

it("aborted_probe_cancels_and_stops", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const controller = new AbortController();
  const handle = fakeHandle(HANGING);
  const running = runProbe({ ok: true, handle }, { signal: controller.signal });
  await vi.waitFor(() => {
    expect(handle.prompts).toEqual(["/usage"]);
  });

  controller.abort();

  expect((await running).result).toEqual({ kind: "failed" });
  expect(handle.cancels).toBe(1);
  expect(handle.stops).toEqual([GRACE_MS]);
});

it("already_aborted_probe_never_starts", async () => {
  const controller = new AbortController();
  controller.abort();

  const { result, specs } = await runProbe(
    { ok: true, handle: fakeHandle(textScript(USAGE_TEXT)) },
    { signal: controller.signal },
  );

  expect(result).toEqual({ kind: "failed" });
  expect(specs).toEqual([]);
});

it("hanging_prompt_times_out_as_failed_and_stops", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const handle = fakeHandle(HANGING);

  const { result } = await runProbe(
    { ok: true, handle },
    { timeoutMs: SHORT_TIMEOUT_MS },
  );

  expect(result).toEqual({ kind: "failed" });
  expect(handle.cancels).toBe(1);
  expect(handle.stops).toEqual([GRACE_MS]);
});

it("stop_with_survivors_overrides_the_result", async () => {
  const handle = fakeHandle(textScript(USAGE_TEXT), SURVIVORS);

  const { result } = await runProbe({ ok: true, handle });

  expect(result).toEqual({ kind: "unstopped" });
});

it("stop_that_throws_is_unstopped", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const handle = fakeHandle(textScript(USAGE_TEXT), new Error("kill failed"));

  const { result } = await runProbe({ ok: true, handle });

  expect(result).toEqual({ kind: "unstopped" });
});
