import { setTimeout as sleep } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import type { ScheduledTask } from "../../tests/fakes/rotationHarness";
import type { Account } from "../domain/types";

import type { AgyLimits, AgyProbeResult } from "./agy/usage";
import type { RateLimitState } from "./codex/events";
import type { ProbeResult } from "./codex/probe";
import { createLimitProbeService, type LimitProbeService } from "./limitProbe";

const NOW_MS = 1_700_000_000_000;
const RESET_AT = 1_700_003_600;
const INTERVAL_MS = 300_000;
const TICK_MS = 5;

const CODEX_A: Account = account("codex-a", "codex", 0);
const CODEX_B: Account = account("codex-b", "codex", 1);
const CLAUDE_C: Account = account("claude-c", "claude", 2);
const GEMINI_G: Account = account("gemini-g", "gemini", 3);

const AGY_FIVE_HOUR_RESET = 1_700_007_200;
const AGY_ALLOWED: AgyLimits = {
  buckets: [
    {
      id: "gemini-5h",
      name: null,
      group: "Gemini Models",
      window: "5h",
      remainingFraction: 0.25,
      resetsAt: AGY_FIVE_HOUR_RESET,
    },
  ],
  others: [],
};
const AGY_EXHAUSTED: AgyLimits = {
  buckets: [
    {
      id: "gemini-5h",
      name: null,
      group: "Gemini Models",
      window: "5h",
      remainingFraction: 0,
      resetsAt: AGY_FIVE_HOUR_RESET,
    },
  ],
  others: [],
};
const AGY_EXHAUSTED_WITHOUT_RESET: AgyLimits = {
  buckets: [
    {
      id: "gemini-5h",
      name: null,
      group: "Gemini Models",
      window: "5h",
      remainingFraction: 0,
      resetsAt: null,
    },
  ],
  others: [],
};

const ALLOWED: RateLimitState = {
  primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: RESET_AT },
  secondary: null,
  rateLimitReachedType: null,
  ordinaryUsageAllowed: true,
  extra: [],
};
const EXHAUSTED: RateLimitState = {
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_AT },
  secondary: null,
  rateLimitReachedType: "rate_limit_reached",
  ordinaryUsageAllowed: false,
  extra: [],
};
const EXHAUSTED_WITHOUT_RESET: RateLimitState = {
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
  secondary: null,
  rateLimitReachedType: "rate_limit_reached",
  ordinaryUsageAllowed: false,
  extra: [],
};

function account(
  id: string,
  provider: Account["provider"],
  order: number,
): Account {
  return { id, provider, label: id, configDir: `/cfg/${id}`, order };
}

function limits(state: RateLimitState): ProbeResult {
  return { kind: "limits", limits: state };
}

interface Rig extends RigState {
  readonly service: LimitProbeService;
}

interface RigState {
  readonly accounts: Account[];
  readonly results: Map<string, ProbeResult[]>;
  readonly probed: string[];
  readonly tasks: ScheduledTask[];
  readonly inUse: Set<string>;
  readonly changes: { count: number };
  readonly aborted: string[];
  readonly agyProbed: string[];
  readonly agySignals: AbortSignal[];
  agyHold: boolean;
  readonly agyResults: Map<string, AgyProbeResult[]>;
  hold: PromiseWithResolvers<undefined> | null;
  stopHold: PromiseWithResolvers<undefined> | null;
  abortResult: ProbeResult;
}

function setup(accounts: Account[]): Rig {
  const rig: RigState = {
    accounts,
    results: new Map(),
    probed: [],
    tasks: [],
    inUse: new Set(),
    changes: { count: 0 },
    aborted: [],
    agyProbed: [],
    agySignals: [],
    agyHold: false,
    agyResults: new Map(),
    hold: null,
    stopHold: null,
    abortResult: { kind: "failed" },
  };
  const service = createLimitProbeService({
    consoleProbe: () => Promise.resolve({ kind: "failed" }),
    readAccounts: () => Promise.resolve([...rig.accounts]),
    probe: async (target, signal) => {
      rig.probed.push(target.id);
      const gate = rig.hold;
      if (gate !== null) {
        signal.addEventListener("abort", () => {
          rig.aborted.push(target.id);
          gate.resolve(undefined);
        });
        await gate.promise;
        if (signal.aborted) {
          await rig.stopHold?.promise;
          return rig.abortResult;
        }
      }
      return rig.results.get(target.id)?.shift() ?? { kind: "failed" };
    },
    agyProbe: async (target, signal) => {
      rig.agyProbed.push(target.id);
      rig.agySignals.push(signal);
      if (rig.agyHold) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
        return { kind: "failed" };
      }
      return Promise.resolve(
        rig.agyResults.get(target.id)?.shift() ?? { kind: "failed" },
      );
    },
    isInUse: (id) => rig.inUse.has(id),
    now: () => NOW_MS,
    schedule: (at, run) => {
      const task: ScheduledTask = { at, run, cancelled: false };
      rig.tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  });
  service.onChanged(() => {
    rig.changes.count += 1;
  });
  return Object.assign(rig, { service });
}

async function passes(rig: Rig, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(rig.tasks).toHaveLength(count);
  });
}

it("start_probes_codex_accounts_in_order_and_skips_others", async () => {
  const rig = setup([CLAUDE_C, CODEX_B, CODEX_A]);
  rig.inUse.add(CODEX_B.id);
  rig.results.set(CODEX_A.id, [limits(ALLOWED)]);

  rig.service.start();
  await passes(rig, 1);

  expect(rig.probed).toEqual([CODEX_A.id]);
  expect(rig.service.limitOf(CODEX_A.id)).toEqual({
    accountId: CODEX_A.id,
    status: "allowed",
    resetsAt: RESET_AT,
    rateLimitType: "five_hour",
    utilization: 0.5,
    windows: [
      {
        id: "five_hour",
        scope: null,
        period: "five_hour",
        utilization: 0.5,
        resetsAt: RESET_AT,
        exhausted: false,
      },
    ],
    observedAt: NOW_MS,
  });
  expect(rig.service.limitOf(CODEX_B.id)).toBeNull();
  expect(rig.tasks[0]?.at).toBe(NOW_MS + INTERVAL_MS);
  expect(rig.changes.count).toBe(1);
});

it("exhausted_probe_with_reset_sets_runtime", async () => {
  const rig = setup([CODEX_A, CODEX_B]);
  rig.results.set(CODEX_A.id, [limits(EXHAUSTED)]);
  rig.results.set(CODEX_B.id, [limits(EXHAUSTED_WITHOUT_RESET)]);

  rig.service.start();
  await passes(rig, 1);

  expect(rig.service.runtimeOf(CODEX_A.id)).toEqual({
    status: "exhausted",
    resetsAt: RESET_AT,
  });
  expect(rig.service.limitOf(CODEX_A.id)).toMatchObject({ status: "rejected" });
  expect(rig.service.runtimeOf(CODEX_B.id)).toBeNull();
});

it("needs_login_probe_sets_runtime_without_limit", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [{ kind: "needs_login" }]);

  rig.service.start();
  await passes(rig, 1);

  expect(rig.service.runtimeOf(CODEX_A.id)).toEqual({ status: "needs_login" });
  expect(rig.service.limitOf(CODEX_A.id)).toBeNull();
});

it("no_limits_clears_the_previous_entry", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [limits(EXHAUSTED), { kind: "no_limits" }]);
  rig.service.start();
  await passes(rig, 1);

  rig.tasks[0]?.run();
  await passes(rig, 2);

  expect(rig.service.limitOf(CODEX_A.id)).toBeNull();
  expect(rig.service.runtimeOf(CODEX_A.id)).toBeNull();
  expect(rig.changes.count).toBe(2);
});

it("failed_probe_keeps_the_previous_entry", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [limits(ALLOWED), { kind: "failed" }]);
  rig.service.start();
  await passes(rig, 1);

  rig.tasks[0]?.run();
  await passes(rig, 2);

  expect(rig.service.limitOf(CODEX_A.id)).toMatchObject({ utilization: 0.5 });
  expect(rig.changes.count).toBe(1);
});

it("first_failed_probe_notifies_listeners", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [{ kind: "failed" }]);

  rig.service.start();
  await passes(rig, 1);

  expect(rig.service.availabilityOf(CODEX_A)).toBe("failed");
  expect(rig.service.limitOf(CODEX_A.id)).toBeNull();
  expect(rig.service.runtimeOf(CODEX_A.id)).toBeNull();
  expect(rig.changes.count).toBe(1);
});

it("needs_login_entry_survives_a_failed_probe", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [{ kind: "needs_login" }, { kind: "failed" }]);
  rig.service.start();
  await passes(rig, 1);

  rig.tasks[0]?.run();
  await passes(rig, 2);

  expect(rig.service.runtimeOf(CODEX_A.id)).toEqual({ status: "needs_login" });
  expect(rig.service.availabilityOf(CODEX_A)).toBe("pending");
});

it("unreadable_probe_clears_limit_and_runtime_and_reports_failed", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [limits(EXHAUSTED), { kind: "unreadable" }]);
  rig.service.start();
  await passes(rig, 1);

  rig.tasks[0]?.run();
  await passes(rig, 2);

  expect(rig.service.limitOf(CODEX_A.id)).toBeNull();
  expect(rig.service.runtimeOf(CODEX_A.id)).toBeNull();
  expect(rig.service.availabilityOf(CODEX_A)).toBe("failed");
});

it("availability_follows_probe_state_and_account_kind", async () => {
  const rig = setup([CODEX_A, CODEX_B, CLAUDE_C]);
  rig.results.set(CODEX_A.id, [limits(ALLOWED)]);
  rig.results.set(CODEX_B.id, [{ kind: "no_limits" }]);

  expect(rig.service.availabilityOf(CODEX_A)).toBe("pending");
  rig.service.start();
  await passes(rig, 1);

  expect(rig.service.availabilityOf(CODEX_A)).toBe("reported");
  expect(rig.service.availabilityOf(CODEX_B)).toBe("unsupported");
  expect(rig.service.availabilityOf(CLAUDE_C)).toBe("unsupported");
});

it("removed_accounts_lose_their_entries", async () => {
  const rig = setup([CODEX_A, CODEX_B]);
  rig.results.set(CODEX_A.id, [limits(ALLOWED)]);
  rig.results.set(CODEX_B.id, [limits(EXHAUSTED)]);
  rig.service.start();
  await passes(rig, 1);
  rig.accounts.splice(1, 1);
  rig.results.set(CODEX_A.id, [limits(ALLOWED)]);

  rig.service.trigger();
  await passes(rig, 2);

  expect(rig.service.limitOf(CODEX_B.id)).toBeNull();
  expect(rig.service.runtimeOf(CODEX_B.id)).toBeNull();
  expect(rig.service.limitOf(CODEX_A.id)).not.toBeNull();
});

it("trigger_during_a_pass_runs_exactly_one_more_pass", async () => {
  const rig = setup([CODEX_A]);
  rig.hold = Promise.withResolvers<undefined>();
  rig.service.start();
  await vi.waitFor(() => {
    expect(rig.probed).toHaveLength(1);
  });

  rig.service.trigger();
  rig.service.trigger();
  rig.hold.resolve(undefined);
  await passes(rig, 1);

  expect(rig.probed).toEqual([CODEX_A.id, CODEX_A.id]);
});

it("release_without_an_inflight_probe_resolves_at_once", async () => {
  const rig = setup([CODEX_A]);

  await expect(rig.service.release(CODEX_A.id)).resolves.toBeUndefined();
  expect(rig.aborted).toEqual([]);
});

it("release_aborts_and_awaits_the_inflight_probe_of_that_account", async () => {
  const rig = setup([CODEX_A, CODEX_B]);
  rig.hold = Promise.withResolvers<undefined>();
  rig.service.start();
  await vi.waitFor(() => {
    expect(rig.probed).toEqual([CODEX_A.id]);
  });

  await rig.service.release(CODEX_B.id);
  expect(rig.aborted).toEqual([]);
  await rig.service.release(CODEX_A.id);

  expect(rig.aborted).toEqual([CODEX_A.id]);
});

it("dispose_cancels_the_schedule_and_aborts_the_inflight_probe", async () => {
  const rig = setup([CODEX_A]);
  rig.results.set(CODEX_A.id, [limits(ALLOWED)]);
  rig.service.start();
  await passes(rig, 1);
  rig.hold = Promise.withResolvers<undefined>();
  rig.service.trigger();
  await vi.waitFor(() => {
    expect(rig.probed).toHaveLength(2);
  });

  await rig.service.dispose();

  expect(rig.aborted).toEqual([CODEX_A.id]);
  expect(rig.tasks.every((task) => task.cancelled)).toBe(true);
  expect(rig.tasks).toHaveLength(1);
});

it("dispose_awaits_in_flight_probe", async () => {
  const rig = setup([CODEX_A]);
  rig.hold = Promise.withResolvers<undefined>();
  rig.stopHold = Promise.withResolvers<undefined>();
  rig.service.start();
  await vi.waitFor(() => {
    expect(rig.probed).toEqual([CODEX_A.id]);
  });
  let disposed = false;

  const disposing = rig.service.dispose();
  void (async () => {
    await disposing;
    disposed = true;
  })();
  await vi.waitFor(() => {
    expect(rig.aborted).toEqual([CODEX_A.id]);
  });
  await sleep(TICK_MS);

  expect(disposed).toBe(false);
  rig.stopHold.resolve(undefined);
  await disposing;
  expect(disposed).toBe(true);
});

it("stop_with_survivors_is_not_released", async () => {
  const rig = setup([CODEX_A, CODEX_B]);
  rig.results.set(CODEX_A.id, [{ kind: "unstopped" }, limits(ALLOWED)]);
  rig.results.set(CODEX_B.id, [limits(ALLOWED), limits(ALLOWED)]);
  rig.service.start();
  await passes(rig, 1);

  await expect(rig.service.release(CODEX_A.id)).rejects.toThrow(
    "The limit probe for this account is still running",
  );
  await expect(rig.service.release(CODEX_B.id)).resolves.toBeUndefined();
  rig.tasks[0]?.run();
  await passes(rig, 2);

  expect(rig.probed).toEqual([CODEX_A.id, CODEX_B.id, CODEX_B.id]);
  expect(rig.service.limitOf(CODEX_A.id)).toBeNull();
});

it("release_rejects_when_the_aborted_probe_did_not_stop", async () => {
  const rig = setup([CODEX_A]);
  rig.hold = Promise.withResolvers<undefined>();
  rig.abortResult = { kind: "unstopped" };
  rig.service.start();
  await vi.waitFor(() => {
    expect(rig.probed).toEqual([CODEX_A.id]);
  });

  await expect(rig.service.release(CODEX_A.id)).rejects.toThrow(
    "The limit probe for this account is still running",
  );
});

it("is_blocked_reports_unstopped_account", async () => {
  const rig = setup([CODEX_A, CODEX_B]);
  rig.results.set(CODEX_A.id, [{ kind: "unstopped" }]);
  rig.results.set(CODEX_B.id, [limits(ALLOWED)]);
  rig.service.start();
  await passes(rig, 1);

  expect(rig.service.isBlocked(CODEX_A.id)).toBe(true);
  expect(rig.service.isBlocked(CODEX_B.id)).toBe(false);
  expect(rig.service.isBlocked("unknown")).toBe(false);
});

it("gemini_accounts_use_the_agy_probe_and_codex_the_codex_probe", async () => {
  const rig = setup([CODEX_A, GEMINI_G, CLAUDE_C]);
  rig.results.set(CODEX_A.id, [limits(ALLOWED)]);
  rig.agyResults.set(GEMINI_G.id, [{ kind: "limits", limits: AGY_ALLOWED }]);

  rig.service.start();
  await passes(rig, 1);

  expect(rig.probed).toEqual([CODEX_A.id]);
  expect(rig.agyProbed).toEqual([GEMINI_G.id]);
  expect(rig.service.limitOf(GEMINI_G.id)).toEqual({
    accountId: GEMINI_G.id,
    status: "allowed",
    resetsAt: AGY_FIVE_HOUR_RESET,
    rateLimitType: "five_hour",
    utilization: 0.75,
    windows: [
      {
        id: "Gemini Models/gemini-5h/5h",
        scope: "Gemini Models",
        period: "five_hour",
        utilization: 0.75,
        resetsAt: AGY_FIVE_HOUR_RESET,
        exhausted: false,
      },
    ],
    observedAt: NOW_MS,
  });
  expect(rig.service.runtimeOf(GEMINI_G.id)).toBeNull();
});

it("gemini_exhausted_probe_sets_runtime_only_with_a_reset", async () => {
  const withReset = setup([GEMINI_G]);
  withReset.agyResults.set(GEMINI_G.id, [
    { kind: "limits", limits: AGY_EXHAUSTED },
  ]);
  const withoutReset = setup([GEMINI_G]);
  withoutReset.agyResults.set(GEMINI_G.id, [
    { kind: "limits", limits: AGY_EXHAUSTED_WITHOUT_RESET },
  ]);

  withReset.service.start();
  withoutReset.service.start();
  await passes(withReset, 1);
  await passes(withoutReset, 1);

  expect(withReset.service.runtimeOf(GEMINI_G.id)).toEqual({
    status: "exhausted",
    resetsAt: AGY_FIVE_HOUR_RESET,
  });
  expect(withReset.service.limitOf(GEMINI_G.id)).toMatchObject({
    status: "rejected",
    utilization: 1,
  });
  expect(withoutReset.service.runtimeOf(GEMINI_G.id)).toBeNull();
  expect(withoutReset.service.limitOf(GEMINI_G.id)).toMatchObject({
    status: "rejected",
    resetsAt: null,
  });
});

it("gemini_needs_login_and_no_limits_and_failure_follow_codex_semantics", async () => {
  const rig = setup([GEMINI_G]);
  rig.agyResults.set(GEMINI_G.id, [
    { kind: "needs_login" },
    { kind: "failed" },
    { kind: "limits", limits: AGY_ALLOWED },
    { kind: "no_limits" },
  ]);
  rig.service.start();
  await passes(rig, 1);
  const loggedOut = rig.service.runtimeOf(GEMINI_G.id);

  rig.tasks[0]?.run();
  await passes(rig, 2);
  const afterFailure = rig.service.runtimeOf(GEMINI_G.id);
  rig.tasks[1]?.run();
  await passes(rig, 3);
  rig.tasks[2]?.run();
  await passes(rig, 4);

  expect(loggedOut).toEqual({ status: "needs_login" });
  expect(afterFailure).toEqual({ status: "needs_login" });
  expect(rig.service.limitOf(GEMINI_G.id)).toBeNull();
  expect(rig.service.runtimeOf(GEMINI_G.id)).toBeNull();
});

it("gemini_unstopped_probe_blocks_the_account", async () => {
  const rig = setup([GEMINI_G]);
  rig.agyResults.set(GEMINI_G.id, [{ kind: "unstopped" }]);

  rig.service.start();
  await passes(rig, 1);

  expect(rig.service.isBlocked(GEMINI_G.id)).toBe(true);
  await expect(rig.service.release(GEMINI_G.id)).rejects.toThrow(
    "The limit probe for this account is still running",
  );
});

it("gemini_probe_receives_abort_signal", async () => {
  const rig = setup([GEMINI_G]);
  rig.agyHold = true;
  rig.service.start();
  await vi.waitFor(() => {
    expect(rig.agyProbed).toEqual([GEMINI_G.id]);
  });

  await expect(rig.service.release(GEMINI_G.id)).resolves.toBeUndefined();

  expect(rig.agySignals[0]?.aborted).toBe(true);
});
