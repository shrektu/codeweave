import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionProfile } from "../../domain/types";
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
