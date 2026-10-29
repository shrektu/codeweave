import { setTimeout as sleep } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import type { ScheduledTask } from "../../tests/fakes/rotationHarness";
import type { Account } from "../domain/types";

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

const ALLOWED: RateLimitState = {
  primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: RESET_AT },
  secondary: null,
  rateLimitReachedType: null,
  ordinaryUsageAllowed: true,
};
const EXHAUSTED: RateLimitState = {
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_AT },
  secondary: null,
  rateLimitReachedType: "rate_limit_reached",
  ordinaryUsageAllowed: false,
};
const EXHAUSTED_WITHOUT_RESET: RateLimitState = {
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
  secondary: null,
  rateLimitReachedType: "rate_limit_reached",
  ordinaryUsageAllowed: false,
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
    hold: null,
    stopHold: null,
    abortResult: { kind: "failed" },
  };
  const service = createLimitProbeService({
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
