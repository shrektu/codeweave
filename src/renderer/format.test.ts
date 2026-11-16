import { expect, it } from "vitest";

import { makeSession } from "../../tests/fakes/fakeIpcClient";

import {
  accountLabel,
  compactPath,
  formatCountdown,
  formatLocalTime,
  isSessionLive,
  isStale,
} from "./format";

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
