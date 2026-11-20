import { expect, it } from "vitest";

import {
  makeFlowRun,
  makeSession,
  makeSnapshot,
} from "../../tests/fakes/fakeIpcClient";

import {
  accountLabel,
  compactPath,
  focusedRunOf,
  formatCountdown,
  formatLocalTime,
  isSessionLive,
  isStale,
  orchestratedRunsOf,
  shownSessionOf,
} from "./format";

const STOPPED_MAIN = makeSession({ id: "main", phase: { phase: "stopped" } });
const NODE_SESSION = makeSession({ id: "node" });

it("shown_session_prefers_the_open_run_node_session_over_a_stopped_main", () => {
  const snapshot = makeSnapshot({
    session: STOPPED_MAIN,
    flowRuns: [makeFlowRun({ runId: "run-1", status: "running" })],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot)).toEqual({
    session: NODE_SESSION,
    runId: "run-1",
  });
});

it("shown_session_keeps_a_live_main_over_the_open_run_node_session", () => {
  const live = makeSession({ id: "live-main" });
  const snapshot = makeSnapshot({
    session: live,
    flowRuns: [makeFlowRun({ runId: "run-1", status: "running" })],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot)).toEqual({ session: live, runId: null });
});

it("shown_session_falls_back_to_a_stopped_main_when_no_run_is_open", () => {
  const snapshot = makeSnapshot({
    session: STOPPED_MAIN,
    flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot)).toEqual({
    session: STOPPED_MAIN,
    runId: null,
  });
});

it("shown_session_prefers_the_focused_run_node_session_over_a_live_main", () => {
  const live = makeSession({ id: "live-main", orchestrate: true });
  const snapshot = makeSnapshot({
    session: live,
    flowRuns: [makeFlowRun({ runId: "run-1", status: "running" })],
    flowSessions: [{ runId: "run-1", view: NODE_SESSION }],
  });

  expect(shownSessionOf(snapshot, "run-1")).toEqual({
    session: NODE_SESSION,
    runId: "run-1",
  });
});

it("shown_session_falls_back_when_the_focused_run_has_no_session", () => {
  const live = makeSession({ id: "live-main", orchestrate: true });
  const snapshot = makeSnapshot({
    session: live,
    flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
    flowSessions: [],
  });

  expect(shownSessionOf(snapshot, "run-1")).toEqual({
    session: live,
    runId: null,
  });
  expect(shownSessionOf(snapshot, "run-gone")).toEqual({
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
      makeSnapshot({ session: orchestrator, flowRuns: runs }),
    ).map((run) => run.runId),
  ).toEqual(["new", "old"]);
  expect(
    orchestratedRunsOf(
      makeSnapshot({
        session: makeSession({ id: "orch", orchestrate: false }),
        flowRuns: runs,
      }),
    ),
  ).toEqual([]);
  expect(orchestratedRunsOf(makeSnapshot({ flowRuns: runs }))).toEqual([]);
  expect(orchestratedRunsOf(null)).toEqual([]);
});

it("focused_run_returns_null_for_an_evicted_run", () => {
  const run = makeFlowRun({ runId: "run-1" });
  const snapshot = makeSnapshot({
    session: makeSession({ orchestrate: true }),
    flowRuns: [run],
  });

  expect(focusedRunOf(snapshot, "run-1")).toEqual(run);
  expect(focusedRunOf(snapshot, "run-evicted")).toBeNull();
  expect(focusedRunOf(snapshot, null)).toBeNull();
  expect(focusedRunOf(null, "run-1")).toBeNull();
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
      session,
      flowRuns: [run],
      flowSessions: [nodeView],
    });
    expect(focusedRunOf(snapshot, "run-1")).toBeNull();
  }
  expect(
    shownSessionOf(
      makeSnapshot({
        session: makeSession({ id: "main", orchestrate: false }),
        flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
        flowSessions: [nodeView],
      }),
      "run-1",
    ).runId,
  ).toBeNull();
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
    },
  ] as const;

  expect(accountLabel(accounts, "acc-1")).toBe("Work");
  expect(accountLabel(accounts, "gone")).toBe("gone");
});
