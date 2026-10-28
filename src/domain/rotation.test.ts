import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNTS,
  createHarness,
  flushUnhandled,
  trackUnhandledRejections,
  type Harness,
  type HarnessOptions,
  type RejectablePort,
} from "../../tests/fakes/rotationHarness";
import type { TurnOutcome } from "./rateLimit";
import {
  createRotationController,
  decideNext,
  type AccountRuntime,
  type RotationController,
} from "./rotation";
import type { Account } from "./types";

const NOW_MS = 1_700_000_000_000;
const NOW_S = 1_700_000_000;

function exhausted(resetsAt: number): TurnOutcome {
  return { kind: "exhausted", resetsAt, rateLimitType: null };
}

function account(id: string, order: number): Account {
  return { id, provider: "claude", label: id, configDir: `/cfg/${id}`, order };
}

function decide(
  accounts: readonly Account[],
  runtime: Record<string, AccountRuntime>,
  outcome: TurnOutcome,
  excluded?: ReadonlySet<string>,
): ReturnType<typeof decideNext> {
  return decideNext({
    accounts,
    runtime: new Map(Object.entries(runtime)),
    current: "A",
    outcome,
    now: NOW_MS,
    ...(excluded ? { excluded } : {}),
  });
}

describe("decideNext", () => {
  it("stays on ok and failed outcomes", () => {
    expect(decide(ACCOUNTS, {}, { kind: "ok" })).toEqual({ kind: "stay" });
    expect(decide(ACCOUNTS, {}, { kind: "failed", message: "x" })).toEqual({
      kind: "stay",
    });
  });

  it("switches to the ready account with the lowest order", () => {
    const accounts = [account("A", 1), account("Z", 2), account("M", 3)];

    expect(decide(accounts, {}, exhausted(NOW_S + 60))).toEqual({
      kind: "switch",
      to: "Z",
      reason: "rate_limit",
    });
  });

  it("breaks order ties by id", () => {
    const accounts = [account("A", 1), account("c", 2), account("b", 2)];

    expect(decide(accounts, {}, exhausted(NOW_S + 60))).toMatchObject({
      to: "b",
    });
  });

  it("treats an exhausted account whose reset has passed as ready", () => {
    const runtime = {
      B: { status: "exhausted", resetsAt: NOW_S - 1 },
    } as const;

    expect(
      decide(ACCOUNTS.slice(0, 2), runtime, exhausted(NOW_S + 60)),
    ).toMatchObject({
      kind: "switch",
      to: "B",
    });
  });

  it("never picks a needs_login account and labels the reason", () => {
    const runtime = { B: { status: "needs_login" } } as const;

    expect(decide(ACCOUNTS, runtime, { kind: "needs_login" })).toEqual({
      kind: "switch",
      to: "C",
      reason: "needs_login",
    });
  });

  it("skips excluded accounts", () => {
    expect(
      decide(ACCOUNTS, {}, exhausted(NOW_S + 60), new Set(["B"])),
    ).toMatchObject({
      to: "C",
    });
  });
});

describe("decideNext: waiting and halting", () => {
  it("waits for the exhausted account with the earliest reset", () => {
    const runtime = {
      B: { status: "exhausted", resetsAt: NOW_S + 900 },
      C: { status: "exhausted", resetsAt: NOW_S + 300 },
    } as const;

    expect(decide(ACCOUNTS, runtime, exhausted(NOW_S + 600))).toEqual({
      kind: "wait",
      accountId: "C",
      until: NOW_S + 300,
    });
  });

  it("may wait for the current account itself", () => {
    const runtime = { B: { status: "needs_login" } } as const;

    expect(
      decide(ACCOUNTS.slice(0, 2), runtime, exhausted(NOW_S + 600)),
    ).toEqual({
      kind: "wait",
      accountId: "A",
      until: NOW_S + 600,
    });
  });

  it("halts when every account needs login", () => {
    const runtime = { B: { status: "needs_login" } } as const;

    expect(
      decide(ACCOUNTS.slice(0, 2), runtime, { kind: "needs_login" }),
    ).toEqual({
      kind: "halt",
      reason: "no_usable_accounts",
    });
  });
});

interface Scenario {
  readonly harness: Harness;
  readonly controller: RotationController;
}

function scenario(
  options: Partial<HarnessOptions>,
  accounts: readonly Account[] = ACCOUNTS,
): Scenario {
  const harness = createHarness({ now: NOW_MS, ...options });
  const controller = createRotationController(
    harness.ports,
    accounts,
    "A",
    "s1",
  );
  return { harness, controller };
}

describe("rotation controller", () => {
  it("rotation_switches_once_per_turn", async () => {
    const { harness, controller } = scenario({});

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(harness.calls.filter((call) => call.startsWith("stop:"))).toEqual([
      "stop:A",
    ]);
    expect(harness.switchLog).toHaveLength(1);
  });

  it("rotation_skips_account_exhausted_on_first_request", async () => {
    const { harness, controller } = scenario({
      promptOutcomes: {
        B: [exhausted(NOW_S + 7200)],
        C: [exhausted(NOW_S + 1800)],
      },
    });

    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));

    expect(harness.calls.filter((call) => call.startsWith("start:"))).toEqual([
      "start:B",
      "start:C",
    ]);
    expect(controller.phase()).toEqual({
      phase: "waiting",
      accountId: "C",
      until: NOW_S + 1800,
    });
    expect(harness.switchLog.map((entry) => [entry.from, entry.to])).toEqual([
      ["A", "B"],
      ["B", "C"],
      ["C", null],
    ]);
  });
});

describe("rotation controller: login", () => {
  it("picks the next account when a start reports needs_login", async () => {
    const { harness, controller } = scenario({
      startResults: { B: { ok: false, reason: "needs_login" } },
    });

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(harness.calls).toEqual([
      "stop:A",
      "start:B",
      "start:C",
      "package",
      "log",
      "prompt:C",
    ]);
    expect(controller.runtime().get("B")).toEqual({ status: "needs_login" });
    expect(controller.phase()).toEqual({ phase: "running", accountId: "C" });
  });
});

describe("rotation controller: failures", () => {
  it("fails when the next agent cannot start", async () => {
    const { controller } = scenario({
      startResults: { B: { ok: false, reason: "error" } },
    });

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "failed to start B",
      runningAccountId: null,
    });
  });

  it("switches on needs_login with the needs_login reason", async () => {
    const { harness, controller } = scenario({}, ACCOUNTS.slice(0, 2));

    await controller.onTurnSettled("A", { kind: "needs_login" });

    expect(
      harness.switchLog.map((entry) => [entry.reason, entry.resetsAt]),
    ).toEqual([["needs_login", null]]);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });
});

describe("rotation controller: phases and idle outcomes", () => {
  it("ignores ok and failed outcomes", async () => {
    const { harness, controller } = scenario({});

    await controller.onTurnSettled("A", { kind: "ok" });
    await controller.onTurnSettled("A", { kind: "failed", message: "boom" });

    expect(harness.calls).toEqual([]);
  });

  it("halts when every account needs login", async () => {
    const { controller } = scenario(
      { startResults: { B: { ok: false, reason: "needs_login" } } },
      ACCOUNTS.slice(0, 2),
    );

    await controller.onTurnSettled("A", { kind: "needs_login" });

    expect(controller.phase()).toEqual({ phase: "halted" });
  });

  it("notifies subscribers of every phase change until unsubscribed", async () => {
    const { controller } = scenario({});
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((phase) => seen.push(phase.phase));

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));
    unsubscribe();
    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(seen).toEqual(["switching", "running"]);
  });
});

const TWO_ACCOUNTS = ACCOUNTS.slice(0, 2);

describe("rotation controller: port rejections", () => {
  it.each<[RejectablePort, string | null]>([
    ["stopAgent", "A"],
    ["startAgent", null],
    ["buildContextPackage", null],
    ["sendPrompt", null],
    ["appendSwitchLog", null],
  ])(
    "rotation_fails_when_port_rejects_during_switch (%s)",
    async (port, runningAccountId) => {
      const { harness, controller } = scenario({});
      harness.failNext(port, new Error(`${port} exploded`));

      await controller.onTurnSettled("A", exhausted(NOW_S + 60));

      expect(controller.phase()).toEqual({
        phase: "failed",
        reason: `port call failed: ${port} exploded`,
        runningAccountId,
      });
    },
  );

  it("rotation_resume_rejection_sets_failed", async () => {
    const unhandled = trackUnhandledRejections();
    const { harness, controller } = scenario(
      { promptOutcomes: { B: [exhausted(NOW_S + 1800)] } },
      TWO_ACCOUNTS,
    );
    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));
    harness.failNext("startAgent", new Error("spawn failed"));

    harness.advanceTo((NOW_S + 1800) * 1000);
    await vi.waitFor(() => {
      expect(controller.phase().phase).toBe("failed");
    });
    await flushUnhandled();
    unhandled.stop();

    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "port call failed: spawn failed",
      runningAccountId: null,
    });
    expect(unhandled.reasons).toEqual([]);
  });
});

describe("rotation controller: switch log timing", () => {
  it("rotation_logs_switch_before_new_turn_finishes", async () => {
    const { harness, controller } = scenario({ holdPrompts: true });

    const settled = controller.onTurnSettled("A", exhausted(NOW_S + 60));
    await vi.waitFor(() => {
      expect(harness.calls).toContain("prompt:B");
    });

    expect(harness.calls).toEqual([
      "stop:A",
      "start:B",
      "package",
      "log",
      "prompt:B",
    ]);
    expect(harness.switchLog).toHaveLength(1);

    harness.releasePrompt();
    await settled;
  });
});

describe("rotation controller: dispose", () => {
  it("rotation_dispose_cancels_pending_wait", async () => {
    const { harness, controller } = scenario(
      { promptOutcomes: { B: [exhausted(NOW_S + 1800)] } },
      TWO_ACCOUNTS,
    );
    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));
    const callsBefore = [...harness.calls];

    controller.dispose();
    harness.scheduled[0]?.run();
    await flushUnhandled();

    expect(harness.scheduled[0]?.cancelled).toBe(true);
    expect(controller.phase()).toEqual({ phase: "stopped" });
    expect(harness.calls).toEqual(callsBefore);
  });

  it("ignores settled turns after dispose", async () => {
    const { harness, controller } = scenario({});

    controller.dispose();
    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(harness.calls).toEqual([]);
    expect(controller.phase()).toEqual({ phase: "stopped" });
  });
});

describe("rotation controller: null-target log entries", () => {
  it("rotation_logs_wait_with_null_target", async () => {
    const { harness, controller } = scenario(
      { promptOutcomes: { B: [exhausted(NOW_S + 1800)] } },
      TWO_ACCOUNTS,
    );

    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));

    expect(controller.phase().phase).toBe("waiting");
    expect(harness.switchLog.slice(1)).toEqual([
      {
        at: NOW_MS,
        sessionId: "s1",
        from: "B",
        to: null,
        reason: "rate_limit",
        resetsAt: NOW_S + 1800,
        contextPackageChars: 0,
      },
    ]);
  });

  it("rotation_logs_halt_with_null_target", async () => {
    const { harness, controller } = scenario(
      { startResults: { B: { ok: false, reason: "needs_login" } } },
      TWO_ACCOUNTS,
    );

    await controller.onTurnSettled("A", { kind: "needs_login" });

    expect(controller.phase()).toEqual({ phase: "halted" });
    expect(harness.switchLog).toEqual([
      {
        at: NOW_MS,
        sessionId: "s1",
        from: "A",
        to: null,
        reason: "needs_login",
        resetsAt: null,
        contextPackageChars: 0,
      },
    ]);
  });
});

describe("rotation controller: stale settles", () => {
  it("rotation_ignores_settle_from_non_current_account", async () => {
    const { harness, controller } = scenario({});
    await controller.onTurnSettled("A", exhausted(NOW_S + 60));
    const callsBefore = [...harness.calls];

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(harness.calls).toEqual(callsBefore);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });
});

describe("decideNext: passed resets", () => {
  it("halts instead of waiting for a reset that has already passed", () => {
    const runtime = {
      B: { status: "exhausted", resetsAt: NOW_S - 1 },
    } as const;

    expect(
      decide(
        ACCOUNTS.slice(0, 2),
        runtime,
        { kind: "needs_login" },
        new Set(["B"]),
      ),
    ).toEqual({ kind: "halt", reason: "no_usable_accounts" });
  });
});

describe("rotation controller: dispose during a switch", () => {
  it("rotation_dispose_aborts_in_flight_switch", async () => {
    const { harness, controller } = scenario({ holdPrompts: true });
    const settled = controller.onTurnSettled("A", exhausted(NOW_S + 60));
    await vi.waitFor(() => {
      expect(harness.calls).toContain("prompt:B");
    });

    controller.dispose();
    harness.releasePrompt(exhausted(NOW_S + 120));
    await settled;

    expect(harness.calls).toEqual([
      "stop:A",
      "start:B",
      "package",
      "log",
      "prompt:B",
      "stop:B",
    ]);
    expect(controller.phase()).toEqual({ phase: "stopped" });
    expect(harness.scheduled).toEqual([]);
  });
});

describe("rotation controller: started agent cleanup", () => {
  it.each<RejectablePort>([
    "buildContextPackage",
    "appendSwitchLog",
    "sendPrompt",
  ])(
    "rotation_stops_started_agent_when_later_port_fails (%s)",
    async (port) => {
      const { harness, controller } = scenario({});
      harness.failNext(port, new Error(`${port} exploded`));

      await controller.onTurnSettled("A", exhausted(NOW_S + 60));

      expect(harness.calls.filter((call) => call.startsWith("stop:"))).toEqual([
        "stop:A",
        "stop:B",
      ]);
      expect(controller.phase()).toEqual({
        phase: "failed",
        reason: `port call failed: ${port} exploded`,
        runningAccountId: null,
      });
    },
  );

  it("rotation_stops_started_agent_when_later_port_fails (stop not ok)", async () => {
    const { harness, controller } = scenario({
      stopOkByAccount: { B: false },
    });
    harness.failNext("buildContextPackage", new Error("package exploded"));

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "port call failed: package exploded",
      runningAccountId: "B",
    });
  });

  it("rotation_stops_started_agent_when_later_port_fails (stop rejects)", async () => {
    const { harness, controller } = scenario({});
    harness.failNext("buildContextPackage", new Error("package exploded"));
    harness.failNext("stopAgent", new Error("stop exploded"), 1);

    await controller.onTurnSettled("A", exhausted(NOW_S + 60));

    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "port call failed: package exploded",
      runningAccountId: "B",
    });
  });
});

describe("rotation controller: account list updates", () => {
  it("rotation_set_accounts_used_for_next_switch", async () => {
    const { harness, controller } = scenario({}, ACCOUNTS.slice(0, 1));
    controller.setAccounts(TWO_ACCOUNTS);

    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));

    expect(harness.calls).toEqual([
      "stop:A",
      "start:B",
      "package",
      "log",
      "prompt:B",
    ]);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });

  it("rotation_without_set_accounts_waits_for_the_only_account", async () => {
    const { controller } = scenario({}, ACCOUNTS.slice(0, 1));

    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));

    expect(controller.phase()).toEqual({
      phase: "waiting",
      accountId: "A",
      until: NOW_S + 3600,
    });
  });
});

describe("rotation controller: needs_login on resume", () => {
  it("rotation_retry_keeps_needs_login_without_wait_loop", async () => {
    const { harness, controller } = scenario(
      { promptOutcomes: { B: [exhausted(NOW_S + 1800)] } },
      TWO_ACCOUNTS,
    );
    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));
    harness.setStartResult("B", { ok: false, reason: "needs_login" });
    const logged = harness.switchLog.length;

    for (let tick = 0; tick < 5; tick += 1) {
      harness.advanceTo((NOW_S + 1800) * 1000);
      await flushUnhandled();
    }

    expect(controller.runtime().get("B")).toEqual({ status: "needs_login" });
    expect(harness.calls.filter((call) => call === "start:B")).toHaveLength(2);
    expect(
      harness.switchLog.slice(logged).map((entry) => [entry.from, entry.to]),
    ).toEqual([["B", null]]);
    expect(controller.phase()).toEqual({
      phase: "waiting",
      accountId: "A",
      until: NOW_S + 3600,
    });
  });
});

describe("rotation controller: busy", () => {
  it("prompt_rejected_while_rotation_chain_busy: settle chain", async () => {
    const { harness, controller } = scenario(
      { holdPrompts: true },
      TWO_ACCOUNTS,
    );
    expect(controller.busy()).toBe(false);

    const settled = controller.onTurnSettled("A", exhausted(NOW_S + 3600));

    expect(controller.busy()).toBe(true);
    await vi.waitFor(() => {
      expect(harness.prompts).toHaveLength(1);
    });
    expect(controller.busy()).toBe(true);
    harness.releasePrompt();
    await settled;
    expect(controller.busy()).toBe(false);
  });

  it("prompt_rejected_while_rotation_chain_busy: resume chain", async () => {
    const { harness, controller } = scenario(
      { holdPrompts: true },
      TWO_ACCOUNTS,
    );
    const settled = controller.onTurnSettled("A", exhausted(NOW_S + 3600));
    await vi.waitFor(() => {
      expect(harness.prompts).toHaveLength(1);
    });
    harness.releasePrompt(exhausted(NOW_S + 1800));
    await settled;
    expect(controller.phase().phase).toBe("waiting");
    expect(controller.busy()).toBe(false);

    harness.advanceTo((NOW_S + 1800) * 1000);

    expect(controller.busy()).toBe(true);
    await vi.waitFor(() => {
      expect(harness.prompts).toHaveLength(2);
    });
    expect(controller.busy()).toBe(true);
    harness.releasePrompt();
    await vi.waitFor(() => {
      expect(controller.busy()).toBe(false);
    });
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });

  it("is false after a chain that failed", async () => {
    const { harness, controller } = scenario({}, TWO_ACCOUNTS);
    harness.failNext("stopAgent", new Error("stop blew up"));

    await controller.onTurnSettled("A", exhausted(NOW_S + 3600));

    expect(controller.phase().phase).toBe("failed");
    expect(controller.busy()).toBe(false);
  });

  it("is false for a settle that needs no rotation", async () => {
    const { controller } = scenario({}, TWO_ACCOUNTS);

    await controller.onTurnSettled("A", { kind: "ok" });

    expect(controller.busy()).toBe(false);
  });
});
