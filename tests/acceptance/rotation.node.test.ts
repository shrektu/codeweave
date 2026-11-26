import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/domain/events";
import type { Account } from "../../src/domain/types";
import {
  createRateLimitDetector,
  type RateLimitDetector,
} from "../../src/domain/rateLimit";
import {
  createRotationController,
  type RotationController,
} from "../../src/domain/rotation";
import type { TurnLogEntry } from "../../src/domain/sessionReducer";
import { buildContextPackage } from "../../src/domain/contextPackage";
import {
  ACCOUNTS,
  DEFAULT_PACKAGE,
  RATE_LIMIT_ERROR,
  TURN_END,
  createHarness,
  driveTurn,
  flushUnhandled,
  rateLimitEvent,
  trackUnhandledRejections,
} from "../fakes/rotationHarness";
import type {
  Harness,
  HarnessOptions,
  RejectablePort,
} from "../fakes/rotationHarness";

const NOW_MS = 1_700_000_000_000;
const NOW_S = 1_700_000_000;
const SESSION = "session-1";

interface Setup {
  readonly harness: Harness;
  readonly detector: RateLimitDetector;
  readonly controller: RotationController;
}

function setup(
  overrides: Partial<HarnessOptions> = {},
  accounts: readonly Account[] = ACCOUNTS,
): Setup {
  const harness = createHarness({ now: NOW_MS, ...overrides });
  const detector = createRateLimitDetector(() => NOW_MS);
  const controller = createRotationController(
    harness.ports,
    accounts,
    "A",
    SESSION,
  );
  return { harness, detector, controller };
}

describe("rotation acceptance", () => {
  it("rotation_switches_on_rate_limit_turn_error", async () => {
    const { harness, detector, controller } = setup();

    await driveTurn(detector, controller, [
      rateLimitEvent("allowed_warning", NOW_S + 100),
      rateLimitEvent("rejected", NOW_S + 3600),
      RATE_LIMIT_ERROR,
    ]);

    expect(harness.calls).toEqual([
      "stop:A",
      "start:B",
      "package",
      "log",
      "prompt:B",
    ]);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
    expect(controller.runtime().get("A")).toEqual({
      status: "exhausted",
      resetsAt: NOW_S + 3600,
    });
  });

  it("rotation_ignores_api_retry_and_allowed_warning", async () => {
    const { harness, detector, controller } = setup();

    await driveTurn(detector, controller, [
      { type: "api_retry" },
      rateLimitEvent("allowed_warning", NOW_S + 100),
      TURN_END,
    ]);

    expect(harness.calls).toEqual([]);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "A" });
  });

  it("rotation_switches_only_after_turn_settles", async () => {
    const { harness, detector, controller } = setup();

    detector.observe(rateLimitEvent("rejected", NOW_S + 3600));
    expect(harness.calls).toEqual([]);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "A" });

    detector.observe(RATE_LIMIT_ERROR);
    await controller.onTurnSettled("A", detector.settle());

    expect(harness.calls.filter((call) => call.startsWith("stop:"))).toEqual([
      "stop:A",
    ]);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });
});

describe("rotation acceptance: waiting and failures", () => {
  it("rotation_resumes_at_earliest_reset_with_context_package", async () => {
    const earliest = NOW_S + 1800;
    const { harness, detector, controller } = setup(
      {
        promptOutcomes: {
          B: [{ kind: "exhausted", resetsAt: earliest, rateLimitType: null }],
        },
      },
      ACCOUNTS.slice(0, 2),
    );

    await driveTurn(detector, controller, [
      rateLimitEvent("rejected", NOW_S + 3600),
      RATE_LIMIT_ERROR,
    ]);

    expect(controller.phase()).toEqual({
      phase: "waiting",
      accountId: "B",
      until: earliest,
    });
    expect(harness.scheduled.map((task) => task.at)).toEqual([earliest * 1000]);

    harness.advanceTo(earliest * 1000);
    await vi.waitFor(() => {
      expect(harness.prompts).toHaveLength(2);
    });

    expect(harness.prompts[1]).toEqual({
      accountId: "B",
      text: DEFAULT_PACKAGE,
    });
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
    expect(harness.switchLog.at(-1)?.reason).toBe("reset_reached");
  });
});

describe("rotation acceptance: login and failures", () => {
  it.each<[string, AgentEvent]>([
    [
      "rpc -32000 without errorKind",
      { type: "turn_error", errorKind: null, rpcCode: -32000, message: "auth" },
    ],
    [
      "errorKind auth_required",
      {
        type: "turn_error",
        errorKind: "auth_required",
        rpcCode: null,
        message: "login",
      },
    ],
  ])("rotation_marks_needs_login_on %s", async (_name, error) => {
    const { harness, detector, controller } = setup();

    await driveTurn(detector, controller, [error]);

    expect(controller.runtime().get("A")).toEqual({ status: "needs_login" });
    expect(harness.switchLog[0]?.reason).toBe("needs_login");
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });

  it("rotation_aborts_when_old_container_not_empty", async () => {
    const { harness, detector, controller } = setup({ stopOk: false });

    await driveTurn(detector, controller, [
      rateLimitEvent("rejected", NOW_S + 3600),
      RATE_LIMIT_ERROR,
    ]);

    expect(harness.calls).toEqual(["stop:A"]);
    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "old process still running",
      runningAccountId: "A",
    });
  });
});

const REJECTED_TURN: readonly AgentEvent[] = [
  rateLimitEvent("rejected", NOW_S + 3600),
  RATE_LIMIT_ERROR,
];

describe("rotation acceptance: port rejections", () => {
  it.each<[RejectablePort, string | null]>([
    ["stopAgent", "A"],
    ["startAgent", null],
    ["buildContextPackage", null],
    ["sendPrompt", null],
    ["appendSwitchLog", null],
  ])(
    "rotation_fails_when_port_rejects_during_switch (%s)",
    async (port, runningAccountId) => {
      const { harness, detector, controller } = setup();
      harness.failNext(port, new Error(`${port} exploded`));

      await driveTurn(detector, controller, REJECTED_TURN);

      expect(controller.phase()).toEqual({
        phase: "failed",
        reason: `port call failed: ${port} exploded`,
        runningAccountId,
      });
    },
  );

  it("rotation_resume_rejection_sets_failed", async () => {
    const unhandled = trackUnhandledRejections();
    const earliest = NOW_S + 1800;
    const { harness, detector, controller } = setup(
      {
        promptOutcomes: {
          B: [{ kind: "exhausted", resetsAt: earliest, rateLimitType: null }],
        },
      },
      ACCOUNTS.slice(0, 2),
    );
    await driveTurn(detector, controller, REJECTED_TURN);
    harness.failNext("startAgent", new Error("spawn failed"));

    harness.advanceTo(earliest * 1000);
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

describe("rotation acceptance: switch log timing", () => {
  it("rotation_logs_switch_before_new_turn_finishes", async () => {
    const { harness, detector, controller } = setup({ holdPrompts: true });

    const turn = driveTurn(detector, controller, REJECTED_TURN);
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
    expect(harness.switchLog[0]).toMatchObject({
      from: "A",
      to: "B",
      reason: "rate_limit",
    });

    harness.releasePrompt();
    await turn;
  });
});

describe("rotation acceptance: null-target log entries", () => {
  it("rotation_logs_wait_with_null_target", async () => {
    const earliest = NOW_S + 1800;
    const { harness, detector, controller } = setup(
      {
        promptOutcomes: {
          B: [{ kind: "exhausted", resetsAt: earliest, rateLimitType: null }],
        },
      },
      ACCOUNTS.slice(0, 2),
    );

    await driveTurn(detector, controller, REJECTED_TURN);

    expect(harness.switchLog.map((entry) => [entry.from, entry.to])).toEqual([
      ["A", "B"],
      ["B", null],
    ]);
    expect(harness.switchLog[1]).toEqual({
      at: NOW_MS,
      sessionId: SESSION,
      from: "B",
      to: null,
      reason: "rate_limit",
      resetsAt: earliest,
      contextPackageChars: 0,
    });
  });

  it("rotation_logs_halt_with_null_target", async () => {
    const { harness, detector, controller } = setup(
      { startResults: { B: { ok: false, reason: "needs_login" } } },
      ACCOUNTS.slice(0, 2),
    );

    await driveTurn(detector, controller, [
      {
        type: "turn_error",
        errorKind: "auth_required",
        rpcCode: null,
        message: "login",
      },
    ]);

    expect(controller.phase()).toEqual({ phase: "halted" });
    expect(harness.switchLog).toEqual([
      {
        at: NOW_MS,
        sessionId: SESSION,
        from: "A",
        to: null,
        reason: "needs_login",
        resetsAt: null,
        contextPackageChars: 0,
      },
    ]);
  });
});

describe("rotation acceptance: dispose and stale settles", () => {
  it("rotation_dispose_cancels_pending_wait", async () => {
    const earliest = NOW_S + 1800;
    const { harness, detector, controller } = setup(
      {
        promptOutcomes: {
          B: [{ kind: "exhausted", resetsAt: earliest, rateLimitType: null }],
        },
      },
      ACCOUNTS.slice(0, 2),
    );
    await driveTurn(detector, controller, REJECTED_TURN);
    const callsBefore = [...harness.calls];

    controller.dispose();
    harness.scheduled[0]?.run();
    harness.advanceTo(earliest * 1000);
    await flushUnhandled();

    expect(harness.scheduled[0]?.cancelled).toBe(true);
    expect(controller.phase()).toEqual({ phase: "stopped" });
    expect(harness.calls).toEqual(callsBefore);
  });

  it("rotation_ignores_settle_from_non_current_account", async () => {
    const { harness, detector, controller } = setup();
    await driveTurn(detector, controller, REJECTED_TURN);
    const callsBefore = [...harness.calls];

    detector.observe(RATE_LIMIT_ERROR);
    await controller.onTurnSettled("A", detector.settle());

    expect(harness.calls).toEqual(callsBefore);
    expect(controller.phase()).toEqual({ phase: "running", accountId: "B" });
  });
});

describe("rotation acceptance: context handoff", () => {
  it("next_account_gets_context_package_with_completed_tool", async () => {
    const interrupted: readonly TurnLogEntry[] = [
      {
        toolCallId: "t1",
        title: "Edit src/app.ts",
        status: "completed",
        output: "edited 1 file",
      },
    ];
    const { harness, detector, controller } = setup({
      contextPackage: () =>
        buildContextPackage({
          reason: "rotation",
          userPrompts: ["Fix the login bug"],
          lastReply: null,
          interruptedTurn: interrupted,
          worktree: {
            isRepo: true,
            root: "/repo",
            porcelain: " M src/app.ts",
            diffStat: " src/app.ts | 2 +-",
          },
          maxResultChars: 2000,
        }),
    });

    await driveTurn(detector, controller, [
      rateLimitEvent("rejected", NOW_S + 3600),
      RATE_LIMIT_ERROR,
    ]);

    const first = harness.prompts[0];
    expect(first?.accountId).toBe("B");
    expect(first?.text).toContain("Fix the login bug");
    expect(first?.text).toContain("Edit src/app.ts");
    expect(first?.text).toContain("edited 1 file");
    expect(harness.switchLog).toEqual([
      {
        at: NOW_MS,
        sessionId: SESSION,
        from: "A",
        to: "B",
        reason: "rate_limit",
        resetsAt: NOW_S + 3600,
        contextPackageChars: first?.text.length,
      },
    ]);
  });
});

describe("rotation acceptance: dispose during a switch", () => {
  it("rotation_dispose_aborts_in_flight_switch", async () => {
    const { harness, detector, controller } = setup({ holdPrompts: true });
    const turn = driveTurn(detector, controller, REJECTED_TURN);
    await vi.waitFor(() => {
      expect(harness.calls).toContain("prompt:B");
    });

    controller.dispose();
    harness.releasePrompt({
      kind: "exhausted",
      resetsAt: NOW_S + 7200,
      rateLimitType: null,
    });
    await turn;

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

describe("rotation acceptance: started agent cleanup", () => {
  it.each<RejectablePort>([
    "buildContextPackage",
    "appendSwitchLog",
    "sendPrompt",
  ])(
    "rotation_stops_started_agent_when_later_port_fails (%s)",
    async (port) => {
      const { harness, detector, controller } = setup();
      harness.failNext(port, new Error(`${port} exploded`));

      await driveTurn(detector, controller, REJECTED_TURN);

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
    const { harness, detector, controller } = setup({
      stopOkByAccount: { B: false },
    });
    harness.failNext("buildContextPackage", new Error("package exploded"));

    await driveTurn(detector, controller, REJECTED_TURN);

    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "port call failed: package exploded",
      runningAccountId: "B",
    });
  });

  it("rotation_stops_started_agent_when_later_port_fails (stop rejects)", async () => {
    const { harness, detector, controller } = setup();
    harness.failNext("buildContextPackage", new Error("package exploded"));
    harness.failNext("stopAgent", new Error("stop exploded"), 1);

    await driveTurn(detector, controller, REJECTED_TURN);

    expect(controller.phase()).toEqual({
      phase: "failed",
      reason: "port call failed: package exploded",
      runningAccountId: "B",
    });
  });
});

describe("rotation acceptance: needs_login on resume", () => {
  it("rotation_retry_keeps_needs_login_without_wait_loop", async () => {
    const earliest = NOW_S + 1800;
    const { harness, detector, controller } = setup(
      {
        promptOutcomes: {
          B: [{ kind: "exhausted", resetsAt: earliest, rateLimitType: null }],
        },
      },
      ACCOUNTS.slice(0, 2),
    );
    await driveTurn(detector, controller, REJECTED_TURN);
    harness.setStartResult("B", { ok: false, reason: "needs_login" });
    const logged = harness.switchLog.length;

    for (let tick = 0; tick < 5; tick += 1) {
      harness.advanceTo(earliest * 1000);
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
