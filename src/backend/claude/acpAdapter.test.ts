import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../domain/events";
import { PermissionProfile } from "../../domain/types";
import {
  applyUsageReport,
  emptyUsageLedger,
  usageTotalsOf,
} from "../../domain/usageLedger";
import {
  DEFAULT_PERMISSION_OPTIONS,
  agentOf,
  containedOf,
  createRig,
  permissionRequestOf,
  removeRigDirs,
  startHandle,
} from "../../../tests/fakes/fakeAcpAgent";
import { UnknownPermissionError } from "../agentAdapter";

const EXIT_CODE = 137;

afterEach(removeRigDirs);

describe("acp adapter process exit", () => {
  it("answer_after_process_exit_does_not_throw_write_error", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t1",
        title: "Run make",
        kind: "execute",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
    ]);
    const turn = handle.prompt("build", { model: null });
    const request = await permissionRequestOf(events);

    containedOf(rig).stdin.destroy();
    containedOf(rig).emitExit(EXIT_CODE);
    await turn;

    expect(() => {
      handle.answerPermission(request.requestId, "allow-once");
    }).toThrow(UnknownPermissionError);
  });

  it("acp_process_exit_mid_prompt_emits_turn_error_and_exit", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([{ type: "hang" }]);
    const turn = handle.prompt("never answered", { model: null });
    await vi.waitFor(() => {
      expect(agentOf(rig).prompts).toEqual(["never answered"]);
    });

    containedOf(rig).emitExit(EXIT_CODE);
    await turn;

    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "turn_error",
          errorKind: null,
          rpcCode: null,
          message: "Agent process exited",
        },
        { type: "process_exit" },
      ]);
    });
  });

  it("exit_after_exit_emits_process_exit_once", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);

    containedOf(rig).emitExit(EXIT_CODE);
    containedOf(rig).emitExit(EXIT_CODE);
    await handle.stop(0);

    await vi.waitFor(() => {
      expect(events).toEqual([{ type: "process_exit" }]);
    });
  });
});

describe("acp adapter permission bookkeeping", () => {
  it("acp_double_answer_throws_unknown_permission", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t2",
        title: "Edit",
        kind: "edit",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
    ]);
    const turn = handle.prompt("edit", { model: null });
    const request = await permissionRequestOf(events);

    handle.answerPermission(request.requestId, "reject-once");
    await turn;

    expect(() => {
      handle.answerPermission(request.requestId, "reject-once");
    }).toThrow(UnknownPermissionError);
    expect(agentOf(rig).permissionOutcomes).toEqual([
      { outcome: "selected", optionId: "reject-once" },
    ]);
  });
});

describe("acp adapter start failures", () => {
  it("acp_worktree_busy_returns_error_result", async () => {
    const rig = await createRig();
    await startHandle(rig);

    const second = await rig.start(PermissionProfile.ask, "run-2");

    expect(second).toEqual({
      ok: false,
      reason: "error",
      message: expect.stringContaining("already in use") as string,
    });
    expect(rig.container.specs).toHaveLength(1);
  });

  it("start_error_message_carries_the_stderr_tail", async () => {
    const rig = await createRig();
    rig.container.config.newSessionError = { code: -32603, message: "boom" };
    rig.container.config.stderrText = "fatal: missing claude binary\n";

    const result = await rig.start();

    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: "boom\nfatal: missing claude binary\n",
    });
  });
});

const NATIVE_ID = "native-session-1";

describe("acp adapter native resume", () => {
  it("resume_rejected_starts_fresh", async () => {
    const rig = await createRig();
    rig.container.config.resume = true;
    rig.container.config.resumeError = {
      code: -32603,
      message: "unknown session",
    };

    const result = await rig.start(undefined, "run-1", undefined, {
      nativeSessionId: NATIVE_ID,
    });

    expect(result.ok).toBe(true);
    expect(agentOf(rig).resumeCalls).toHaveLength(1);
    expect(agentOf(rig).newSessions).toHaveLength(1);
    if (result.ok) {
      expect(result.handle.resumed).toBe(false);
      expect(result.handle.nativeSessionId).toBe("fake-session-1");
    }
  });

  it("replay_notifications_dropped_during_load", async () => {
    const rig = await createRig();
    rig.container.config.loadSession = true;
    rig.container.config.replayed = [
      { type: "text", text: "replayed history" },
    ];

    const result = await rig.start(undefined, "run-1", undefined, {
      nativeSessionId: NATIVE_ID,
    });

    expect(result.ok).toBe(true);
    expect(agentOf(rig).loadCalls).toHaveLength(1);
    expect(agentOf(rig).newSessions).toHaveLength(0);
    if (!result.ok) {
      return;
    }
    expect(result.handle.resumed).toBe(true);
    expect(result.handle.nativeSessionId).toBe(NATIVE_ID);
    const texts: string[] = [];
    result.handle.subscribe((event) => {
      if (event.type === "text") {
        texts.push(event.text);
      }
    });
    agentOf(rig).enqueue([{ type: "text", text: "fresh reply" }]);
    await result.handle.prompt("go", { model: null });

    expect(texts).toEqual(["fresh reply"]);
  });
});

describe("acp adapter usage cost", () => {
  it("claude_cost_after_resume_is_added_not_replaced", async () => {
    const first = await createRig();
    const { handle: firstHandle, events: firstEvents } = await startHandle(
      first,
      PermissionProfile.ask,
      "run-1",
    );
    agentOf(first).enqueue([
      { type: "usage_update", cost: { amount: 0.05, currency: "USD" } },
      { type: "end", stopReason: "end_turn" },
    ]);
    await firstHandle.prompt("first", { model: null });

    const second = await createRig();
    const { handle: secondHandle, events: secondEvents } = await startHandle(
      second,
      PermissionProfile.ask,
      "run-2",
    );
    agentOf(second).enqueue([
      { type: "usage_update", cost: { amount: 0.08, currency: "USD" } },
      { type: "end", stopReason: "end_turn" },
    ]);
    await secondHandle.prompt("second", { model: null });

    const reports = [...firstEvents, ...secondEvents].filter(
      (event): event is Extract<AgentEvent, { type: "usage_report" }> =>
        event.type === "usage_report",
    );
    const totals = usageTotalsOf(
      reports.reduce(applyUsageReport, emptyUsageLedger()),
    );

    expect(reports).toHaveLength(2);
    expect(totals.costs).toEqual({ USD: 0.13 });
  });
});
