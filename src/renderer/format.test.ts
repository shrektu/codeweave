import { expect, it } from "vitest";

import {
  makeFlowRun,
  makeSession,
  makeSnapshot,
} from "../../tests/fakes/fakeIpcClient";

import {
  accountLabel,
  activeSessionOf,
  anySessionLive,
  compactPath,
  contextUsageText,
  focusedRunOf,
  formatCountdown,
  formatLocalTime,
  isSessionLive,
  isStale,
  orchestratedRunsOf,
  shownSessionOf,
  limitPercent,
  limitWindowLabel,
  nodeModelOf,
} from "./format";

const STOPPED_MAIN = makeSession({ id: "main", phase: { phase: "stopped" } });
const NODE_SESSION = makeSession({ id: "node" });

it("flow_graph_ignores_foreign_session_model_unit", () => {
  const run = makeFlowRun({
    runId: "run-1",
    flowId: "ship",
    nodes: [
      {
        id: "build",
        status: "done",
        visits: 1,
        result: "x",
        model: "recorded",
      },
    ],
  });
  const flowRef = { flowId: "ship", nodeId: "build" };
  const foreign = [
    {
      runId: "run-2",
      view: makeSession({ flowRef, currentModel: "stranger" }),
    },
  ];
  const own = [
    { runId: "run-1", view: makeSession({ flowRef, currentModel: "live" }) },
  ];

  expect(nodeModelOf(run, "build", foreign)).toBe("recorded");
  expect(nodeModelOf(run, "build", own)).toBe("live");
});

it("shown_session_prefers_the_open_run_node_session_over_a_stopped_main", () => {
  const snapshot = makeSnapshot({
    sessions: [STOPPED_MAIN],
    flowRuns: [makeFlowRun({ runId: "run-1", status: "running" })],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot, STOPPED_MAIN.id)).toEqual({
    session: NODE_SESSION,
    runId: "run-1",
  });
});

it("shown_session_keeps_a_live_main_over_the_open_run_node_session", () => {
  const live = makeSession({ id: "live-main" });
  const snapshot = makeSnapshot({
    sessions: [live],
    flowRuns: [
      makeFlowRun({
        runId: "run-1",
        status: "running",
        ownerSessionId: "live-main",
      }),
    ],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot, live.id)).toEqual({
    session: live,
    runId: null,
  });
});

it("shown_session_falls_back_to_a_stopped_main_when_no_run_is_open", () => {
  const snapshot = makeSnapshot({
    sessions: [STOPPED_MAIN],
    flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot, STOPPED_MAIN.id)).toEqual({
    session: STOPPED_MAIN,
    runId: null,
  });
});

it("shown_session_prefers_the_focused_run_node_session_over_a_live_main", () => {
  const live = makeSession({ id: "live-main", orchestrate: true });
  const snapshot = makeSnapshot({
    sessions: [live],
    flowRuns: [
      makeFlowRun({
        runId: "run-1",
        status: "running",
        ownerSessionId: "live-main",
      }),
    ],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot, live.id, "run-1")).toEqual({
    session: NODE_SESSION,
    runId: "run-1",
  });
});

it("shown_session_falls_back_when_the_focused_run_has_no_session", () => {
  const live = makeSession({ id: "live-main", orchestrate: true });
  const snapshot = makeSnapshot({
    sessions: [live],
    flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
    flowSessions: [],
  });

  expect(shownSessionOf(snapshot, live.id, "run-1")).toEqual({
    session: live,
    runId: null,
  });
  expect(shownSessionOf(snapshot, live.id, "run-gone")).toEqual({
    session: live,
    runId: null,
  });
});

it("orchestrated_runs_keep_only_runs_of_the_current_orchestrate_session_newest_first", () => {
  const orchestrator = makeSession({ id: "orch", orchestrate: true });
  const runs = [
    makeFlowRun({ runId: "old", ownerSessionId: "orch" }),
    makeFlowRun({ runId: "foreign", ownerSessionId: "other" }),
    makeFlowRun({ runId: "user-run", ownerSessionId: null }),
    makeFlowRun({ runId: "new", ownerSessionId: "orch" }),
  ];

  expect(
    orchestratedRunsOf(
      makeSnapshot({ sessions: [orchestrator], flowRuns: runs }),
      "orch",
    ).map((run) => run.runId),
  ).toEqual(["new", "old"]);
  expect(
    orchestratedRunsOf(
      makeSnapshot({
        sessions: [makeSession({ id: "orch", orchestrate: false })],
        flowRuns: runs,
      }),
      "orch",
    ),
  ).toEqual([]);
  expect(orchestratedRunsOf(makeSnapshot({ flowRuns: runs }), "orch")).toEqual(
    [],
  );
  expect(orchestratedRunsOf(null, "orch")).toEqual([]);
});

it("focused_run_returns_null_for_an_evicted_run", () => {
  const run = makeFlowRun({ runId: "run-1", ownerSessionId: "sess-1" });
  const snapshot = makeSnapshot({
    sessions: [makeSession({ id: "sess-1", orchestrate: true })],
    flowRuns: [run],
  });

  expect(focusedRunOf(snapshot, "sess-1", "run-1")).toEqual(run);
  expect(focusedRunOf(snapshot, "sess-1", "run-evicted")).toBeNull();
  expect(focusedRunOf(snapshot, "sess-1", null)).toBeNull();
  expect(focusedRunOf(null, "sess-1", "run-1")).toBeNull();
});

it("focused_run_is_ignored_when_the_main_session_is_not_a_live_orchestrator", () => {
  const run = makeFlowRun({ runId: "run-1", status: "running" });
  const nodeView = { runId: "run-1", view: NODE_SESSION };
  const mains = [
    makeSession({ id: "main", orchestrate: true, phase: { phase: "stopped" } }),
    makeSession({
      id: "main",
      orchestrate: true,
      phase: { phase: "failed", reason: "crashed", runningAccountId: null },
    }),
    makeSession({ id: "main", orchestrate: false }),
    null,
  ];

  for (const session of mains) {
    const snapshot = makeSnapshot({
      sessions: session === null ? [] : [session],
      flowRuns: [run],
      flowSessions: [nodeView],
    });
    expect(focusedRunOf(snapshot, "main", "run-1")).toBeNull();
  }
  expect(
    shownSessionOf(
      makeSnapshot({
        sessions: [makeSession({ id: "main", orchestrate: false })],
        flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
        flowSessions: [nodeView],
      }),
      "main",
      "run-1",
    ).runId,
  ).toBeNull();
});

it("active_session_of_picks_only_the_matching_id", () => {
  const s1 = makeSession({ id: "s-1" });
  const s2 = makeSession({ id: "s-2" });
  const snapshot = makeSnapshot({ sessions: [s1, s2] });

  expect(activeSessionOf(snapshot, "s-2")).toBe(s2);
  expect(activeSessionOf(snapshot, "missing")).toBeNull();
  expect(activeSessionOf(snapshot, null)).toBeNull();
});

it("new_session_ignores_other_orchestrators_runs", () => {
  const orchA = makeSession({ id: "orch-a", orchestrate: true });
  const endedB = makeSession({
    id: "ended-b",
    phase: { phase: "stopped" },
  });
  const childRun = makeFlowRun({
    runId: "run-a",
    ownerSessionId: "orch-a",
    status: "running",
  });
  const snapshot = makeSnapshot({
    sessions: [orchA, endedB],
    flowRuns: [childRun],
    flowSessions: [{ runId: "run-a", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot, null, null)).toEqual({
    session: null,
    runId: null,
  });
  expect(shownSessionOf(snapshot, "ended-b", null)).toEqual({
    session: endedB,
    runId: null,
  });
});

it("flow_run_blocked_while_background_session_live", () => {
  const live = makeSession({ id: "s-live" });
  const ended = makeSession({ id: "s-ended", phase: { phase: "stopped" } });

  expect(anySessionLive(makeSnapshot({ sessions: [live, ended] }))).toBe(true);
  expect(anySessionLive(makeSnapshot({ sessions: [ended] }))).toBe(false);
});

it("limit_window_label_per_period_and_scope", () => {
  expect(limitWindowLabel({ period: "five_hour", scope: null })).toBe("5-hour");
  expect(limitWindowLabel({ period: "seven_day", scope: null })).toBe("Weekly");
  expect(limitWindowLabel({ period: "monthly", scope: null })).toBe("Monthly");
  expect(limitWindowLabel({ period: "window_45m", scope: null })).toBe(
    "window_45m",
  );
  expect(limitWindowLabel({ period: null, scope: null })).toBe("Limit");
  expect(limitWindowLabel({ period: "seven_day", scope: "Opus" })).toBe(
    "Weekly · Opus",
  );
});

it("limit_percent_clamps_out_of_range", () => {
  expect(limitPercent(1.4, false)).toBe(100);
  expect(limitPercent(-0.2, false)).toBe(0);
  expect(limitPercent(null, false)).toBe(0);
  expect(limitPercent(0.426, false)).toBe(43);
  expect(limitPercent(0.1, true)).toBe(100);
});

it("session_live_excludes_stopped_failed_halted", () => {
  const live = [
    { phase: "running", accountId: "acc-1" },
    { phase: "switching", from: "acc-1", to: "acc-2" },
    { phase: "waiting", accountId: "acc-1", until: 1_900_000_000 },
  ] as const;
  const ended = [
    { phase: "stopped" },
    { phase: "failed", reason: "boom", runningAccountId: null },
    { phase: "halted" },
  ] as const;

  expect(live.map((phase) => isSessionLive(makeSession({ phase })))).toEqual([
    true,
    true,
    true,
  ]);
  expect(ended.map((phase) => isSessionLive(makeSession({ phase })))).toEqual([
    false,
    false,
    false,
  ]);
  expect(isSessionLive(null)).toBe(false);
});

it("compact_path_keeps_last_two_segments", () => {
  expect(compactPath("/home/user/.config/codeweave/work")).toBe(
    "…/codeweave/work",
  );
});

it("compact_path_short_path_unchanged", () => {
  expect(compactPath("/cfg/a")).toBe("/cfg/a");
  expect(compactPath("relative")).toBe("relative");
});

it("compact_path_windows_separator", () => {
  expect(compactPath("C:\\Users\\jane\\AppData\\Codeweave\\work")).toBe(
    "…\\Codeweave\\work",
  );
});

const RESET_SECONDS = 1_793_095_200;
const NOW_MS = RESET_SECONDS * 1000;
const MINUTE_SECONDS = 60;
const MINUTE_MS = 60_000;
const FIFTEEN_MINUTES_MS = 900_000;

it("format_local_time_uses_zone_and_seconds_input", () => {
  expect(
    formatLocalTime(RESET_SECONDS, { locale: "en-US", timeZone: "UTC" }),
  ).toBe("10:00");
  expect(
    formatLocalTime(RESET_SECONDS, {
      locale: "en-US",
      timeZone: "Europe/Warsaw",
    }),
  ).toBe("11:00");
  expect(
    formatLocalTime(RESET_SECONDS + 5 * MINUTE_SECONDS, {
      locale: "en-US",
      timeZone: "UTC",
    }),
  ).toBe("10:05");
});

it.each<[number, string]>([
  [72 * MINUTE_SECONDS, "in 1 h 12 min"],
  [4 * MINUTE_SECONDS, "in 4 min"],
  [59 * MINUTE_SECONDS, "in 59 min"],
  [60 * MINUTE_SECONDS, "in 1 h"],
  [61 * MINUTE_SECONDS, "in 1 h 1 min"],
  [1, "in 1 min"],
  [0, "now"],
  [-1, "now"],
  [-3600, "now"],
])("format_countdown_offset_%i_seconds", (offsetSeconds, expected) => {
  expect(formatCountdown(RESET_SECONDS + offsetSeconds, NOW_MS)).toBe(expected);
});

it("is_stale_boundary_at_fifteen_minutes", () => {
  const limit = { accountId: "acc-1", observedAt: NOW_MS - FIFTEEN_MINUTES_MS };

  expect(isStale(limit, NOW_MS, "acc-1")).toBe(false);
  expect(isStale(limit, NOW_MS + 1, "acc-1")).toBe(true);
  expect(
    isStale({ ...limit, observedAt: NOW_MS - MINUTE_MS }, NOW_MS, "acc-1"),
  ).toBe(false);
});

it("is_stale_for_inactive_or_missing_active_account", () => {
  const fresh = { accountId: "acc-1", observedAt: NOW_MS };

  expect(isStale(fresh, NOW_MS, "acc-2")).toBe(true);
  expect(isStale(fresh, NOW_MS, null)).toBe(true);
});

it("account_label_falls_back_to_id", () => {
  const accounts = [
    {
      id: "acc-1",
      provider: "claude",
      label: "Work",
      configDir: "/a",
      order: 0,
      api: null,
      hasKey: false,
      keyHint: null,
      runtime: { status: "ready" },
      limit: null,
      limitAvailability: "pending",
    },
  ] as const;

  expect(accountLabel(accounts, "acc-1")).toBe("Work");
  expect(accountLabel(accounts, "gone")).toBe("gone");
});

it("context_usage_text_formats_used_limit_and_percent", () => {
  expect(contextUsageText({ usedTokens: 45_000, limitTokens: 200_000 })).toBe(
    "45K / 200K · 23%",
  );
  expect(contextUsageText(null)).toBe("Context not reported");
});

it("context_usage_text_clamps_over_limit_to_100", () => {
  expect(contextUsageText({ usedTokens: 250_000, limitTokens: 200_000 })).toBe(
    "250K / 200K · 100%",
  );
});

it("context_usage_text_without_limit", () => {
  expect(contextUsageText({ usedTokens: 12_345, limitTokens: null })).toBe(
    "12.3K tokens in context",
  );
});
