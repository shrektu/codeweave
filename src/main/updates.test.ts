import { EventEmitter } from "node:events";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { UpdateChannel } from "../domain/types";

import {
  createUpdateNotifier,
  openAvailableRelease,
  type GenericFeed,
  type UpdateCheckerLike,
  type UpdateInfoLike,
  type UpdateNotifier,
} from "./updates";

const NEWER_VERSION = "99.0.0";
const TEST_FEED = "http://127.0.0.1:4010/feed";

class FakeUpdater extends EventEmitter implements UpdateCheckerLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  forceDevUpdateConfig = false;
  feeds: GenericFeed[] = [];
  checks = 0;
  prereleaseFlags: boolean[] = [];
  failWith: Error | null = null;
  holding = false;
  private inFlight: Promise<null> | null = null;
  private finish: (() => void) | null = null;

  setFeedURL(options: GenericFeed): void {
    this.feeds.push(options);
  }

  checkForUpdates(): Promise<null> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.checks += 1;
    this.prereleaseFlags.push(this.allowPrerelease);
    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }
    if (!this.holding) {
      return Promise.resolve(null);
    }
    const { promise, resolve } = Promise.withResolvers<null>();
    this.inFlight = promise;
    this.finish = () => {
      this.inFlight = null;
      resolve(null);
    };
    return promise;
  }

  settleCheck(): void {
    this.finish?.();
  }

  announce(info: UpdateInfoLike): void {
    this.emit("update-available", info);
  }
}

interface Rig {
  readonly updater: FakeUpdater;
  readonly notifier: UpdateNotifier;
  readonly available: (string | null)[];
  readonly logged: { message: string; error?: unknown }[];
}

function rig(
  options: { isPackaged?: boolean; testFeedUrl?: string } = {},
): Rig {
  const updater = new FakeUpdater();
  const available: (string | null)[] = [];
  const logged: Rig["logged"] = [];
  const notifier = createUpdateNotifier({
    updater,
    isPackaged: options.isPackaged ?? true,
    testFeedUrl: options.testFeedUrl,
    setInterval: (run, ms) => setInterval(run, ms),
    clearInterval: (handle) => {
      clearInterval(handle);
    },
    onChanged: (version) => {
      available.push(version);
    },
    log: (message, error) => {
      logged.push({ message, error });
    },
  });
  return { updater, notifier, available, logged };
}

const STABLE = { enabled: true, channel: UpdateChannel.stable } as const;
const SIX_HOURS_MS = 21_600_000;
const TWELVE_HOURS_MS = 43_200_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("enabled_checks_immediately_and_never_downloads", () => {
  const { updater, notifier } = rig();

  notifier.configure({ enabled: true, channel: UpdateChannel.stable });

  expect(updater.checks).toBe(1);
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(false);
  expect(updater.allowPrerelease).toBe(false);
});

it("beta_channel_allows_prereleases", () => {
  const { updater, notifier } = rig();

  notifier.configure({ enabled: true, channel: UpdateChannel.beta });

  expect(updater.allowPrerelease).toBe(true);
});

it("update_available_reports_the_version", () => {
  const { updater, notifier, available } = rig();
  notifier.configure({ enabled: true, channel: UpdateChannel.stable });

  updater.announce({ version: NEWER_VERSION });

  expect(available).toEqual([NEWER_VERSION]);
  expect(notifier.available()).toBe(NEWER_VERSION);
});

it("dev_build_with_test_feed_checks_against_that_feed", () => {
  const { updater, notifier } = rig({
    isPackaged: false,
    testFeedUrl: TEST_FEED,
  });

  notifier.configure({ enabled: true, channel: UpdateChannel.stable });

  expect(updater.forceDevUpdateConfig).toBe(true);
  expect(updater.feeds).toEqual([{ provider: "generic", url: TEST_FEED }]);
  expect(updater.checks).toBe(1);
});

it("enabled_checks_again_every_six_hours", async () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);

  await vi.advanceTimersByTimeAsync(SIX_HOURS_MS - 1);
  expect(updater.checks).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(updater.checks).toBe(2);
});

it("disabling_clears_the_interval_and_stops_checks", () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);

  notifier.configure({ enabled: false, channel: UpdateChannel.stable });
  vi.advanceTimersByTime(TWELVE_HOURS_MS);

  expect(updater.checks).toBe(1);
});

it("disabled_notifier_ignores_late_update_events_but_keeps_the_known_one", () => {
  const { updater, notifier, available } = rig();
  notifier.configure(STABLE);
  updater.announce({ version: NEWER_VERSION });

  notifier.configure({ enabled: false, channel: UpdateChannel.stable });
  updater.announce({ version: "99.1.0" });

  expect(available).toEqual([NEWER_VERSION]);
  expect(notifier.available()).toBe(NEWER_VERSION);
});

it("re_enabling_does_not_stack_intervals", async () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);
  await vi.advanceTimersByTimeAsync(0);
  notifier.configure({ enabled: false, channel: UpdateChannel.stable });
  notifier.configure(STABLE);
  expect(updater.checks).toBe(2);

  await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

  expect(updater.checks).toBe(3);
});

it("unchanged_config_does_not_trigger_another_check", () => {
  const { updater, notifier } = rig();

  notifier.configure(STABLE);
  notifier.configure(STABLE);

  expect(updater.checks).toBe(1);
});

it("beta_channel_switch_allows_prereleases_and_checks_again", async () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);
  await vi.advanceTimersByTimeAsync(0);

  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  await vi.advanceTimersByTimeAsync(0);

  expect(updater.allowPrerelease).toBe(true);
  expect(updater.checks).toBe(2);

  notifier.configure(STABLE);
  await vi.advanceTimersByTimeAsync(0);

  expect(updater.allowPrerelease).toBe(false);
  expect(updater.checks).toBe(3);
});

it("switching_to_stable_clears_an_announced_prerelease", async () => {
  const { updater, notifier, available } = rig();
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  updater.announce({ version: "99.0.0-beta.1" });

  notifier.configure(STABLE);

  expect(notifier.available()).toBeNull();
  expect(available).toEqual(["99.0.0-beta.1", null]);
  const opened: string[] = [];
  await openAvailableRelease(notifier, (url) => {
    opened.push(url);
    return Promise.resolve();
  });
  expect(opened).toEqual([]);
});

it("switching_to_stable_keeps_an_announced_stable_version", () => {
  const { updater, notifier, available } = rig();
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  updater.announce({ version: NEWER_VERSION });

  notifier.configure(STABLE);

  expect(notifier.available()).toBe(NEWER_VERSION);
  expect(available).toEqual([NEWER_VERSION]);
});

it("late_beta_result_after_switch_to_stable_is_ignored", async () => {
  const { updater, notifier, available } = rig();
  updater.holding = true;
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  notifier.configure(STABLE);

  updater.announce({ version: "99.0.0-beta.1" });
  updater.settleCheck();
  await vi.advanceTimersByTimeAsync(0);

  expect(notifier.available()).toBeNull();
  expect(available).toEqual([]);
});

it("late_stable_result_after_switch_to_stable_is_still_accepted", async () => {
  const { updater, notifier, available } = rig();
  updater.holding = true;
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  notifier.configure(STABLE);

  updater.announce({ version: NEWER_VERSION });
  updater.settleCheck();
  await vi.advanceTimersByTimeAsync(0);

  expect(notifier.available()).toBe(NEWER_VERSION);
  expect(available).toEqual([NEWER_VERSION]);
});

it("channel_change_during_running_check_runs_one_follow_up_check", async () => {
  const { updater, notifier } = rig();
  updater.holding = true;
  notifier.configure(STABLE);

  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  notifier.configure(STABLE);
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });
  expect(updater.checks).toBe(1);

  updater.settleCheck();
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.checks).toBe(2);
  expect(updater.prereleaseFlags).toEqual([false, true]);

  updater.settleCheck();
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.checks).toBe(2);
});

it("disabling_during_running_check_cancels_the_follow_up", async () => {
  const { updater, notifier } = rig();
  updater.holding = true;
  notifier.configure(STABLE);
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });

  notifier.configure({ enabled: false, channel: UpdateChannel.beta });
  updater.settleCheck();
  await vi.advanceTimersByTimeAsync(0);

  expect(updater.checks).toBe(1);
});

it("check_rejection_is_logged_and_swallowed", async () => {
  const { updater, notifier, logged } = rig();
  const failure = new Error("offline");
  updater.failWith = failure;

  notifier.configure(STABLE);
  await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

  expect(updater.checks).toBe(2);
  expect(logged).toEqual([
    { message: "update check failed", error: failure },
    { message: "update check failed", error: failure },
  ]);
  expect(notifier.available()).toBeNull();
});

it("updater_error_events_do_not_throw", () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);

  expect(() => updater.emit("error", new Error("boom"))).not.toThrow();
});

it("invalid_version_from_feed_is_ignored", () => {
  const { updater, notifier, available, logged } = rig();
  notifier.configure(STABLE);

  updater.announce({ version: "99.0.0/../../evil" });
  updater.announce({ version: "" });
  updater.announce({ version: "v99" });

  expect(available).toEqual([]);
  expect(notifier.available()).toBeNull();
  expect(logged).toHaveLength(3);
});

it("prerelease_version_is_accepted_on_beta", () => {
  const { updater, notifier, available } = rig();
  notifier.configure({ enabled: true, channel: UpdateChannel.beta });

  updater.announce({ version: "99.0.0-beta.2" });

  expect(available).toEqual(["99.0.0-beta.2"]);
});

it("same_version_is_reported_once_and_a_newer_one_again", () => {
  const { updater, notifier, available } = rig();
  notifier.configure(STABLE);

  updater.announce({ version: NEWER_VERSION });
  updater.announce({ version: NEWER_VERSION });
  updater.announce({ version: "99.1.0" });

  expect(available).toEqual([NEWER_VERSION, "99.1.0"]);
  expect(notifier.available()).toBe("99.1.0");
});

it("packaged_app_ignores_the_test_feed", () => {
  const { updater, notifier } = rig({
    isPackaged: true,
    testFeedUrl: TEST_FEED,
  });

  notifier.configure(STABLE);

  expect(updater.feeds).toEqual([]);
  expect(updater.forceDevUpdateConfig).toBe(false);
  expect(updater.checks).toBe(1);
});

it("dev_build_without_test_feed_never_checks", () => {
  const { updater, notifier } = rig({ isPackaged: false });

  notifier.configure(STABLE);
  vi.advanceTimersByTime(TWELVE_HOURS_MS);

  expect(updater.checks).toBe(0);
  expect(updater.forceDevUpdateConfig).toBe(false);
});

it("dispose_stops_the_interval", () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);

  notifier.dispose();
  vi.advanceTimersByTime(TWELVE_HOURS_MS);

  expect(updater.checks).toBe(1);
});

it("open_release_before_any_update_is_a_no_op", async () => {
  const { notifier } = rig();
  const opened: string[] = [];

  await openAvailableRelease(notifier, (url) => {
    opened.push(url);
    return Promise.resolve();
  });

  expect(opened).toEqual([]);
});

it("open_release_opens_the_tag_of_the_announced_version", async () => {
  const { updater, notifier } = rig();
  notifier.configure(STABLE);
  updater.announce({ version: NEWER_VERSION });
  const opened: string[] = [];

  await openAvailableRelease(notifier, (url) => {
    opened.push(url);
    return Promise.resolve();
  });

  expect(opened).toEqual([
    "https://github.com/shrektu/codeweave/releases/tag/v99.0.0",
  ]);
});
