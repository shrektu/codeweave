import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { IpcErrorCode } from "../../src/shared/protocol";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
} from "../fakes/backendRig";
import {
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import { writeFlowFiles } from "../fakes/orchestratorHarness";
import { settled } from "../fakes/settle";

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const tempDirs: string[] = [];

afterEach(async () => {
  await closeRigs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

it("second_start_keeps_first_session_live", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const secondCwd = await makeTempDir("cw-second-");

  const first = await rig.call("session/start", {
    cwd: rig.cwd,
    profile: "ask",
  });
  const second = await rig.call("session/start", { cwd: secondCwd });

  const snapshot = await rig.call("sessions/snapshot", {});
  const sessions = (snapshot as unknown as { sessions: (typeof first)[] })
    .sessions;
  expect(sessions).toHaveLength(2);
  expect(sessions.map((s) => s.id)).toEqual([first.id, second.id]);
  expect(sessions.every((s) => s.phase.phase === "running")).toBe(true);
});

it("prompt_reaches_only_named_session", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const secondCwd = await makeTempDir("cw-second-");

  await rig.call("session/start", startParams(rig));
  const second = await rig.call("session/start", { cwd: secondCwd });
  agentOf(rig, 1).enqueue([{ type: "text", text: "from second" }, END_TURN]);

  await rig.call("session/prompt", {
    sessionId: second.id,
    text: "only-two",
  });

  await settled(() => {
    expect(agentOf(rig, 1).prompts).toHaveLength(1);
  });
  expect(agentOf(rig, 0).prompts).toEqual([]);
});

it("stop_only_named_session", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const secondCwd = await makeTempDir("cw-second-");

  const first = await rig.call("session/start", {
    cwd: rig.cwd,
    profile: "ask",
  });
  const second = await rig.call("session/start", { cwd: secondCwd });

  const stopped = await rig.call("session/stop", { sessionId: first.id });

  expect(stopped).toEqual({ stopped: true });
  const snapshot = await rig.call("sessions/snapshot", {});
  const sessions = (snapshot as unknown as { sessions: (typeof first)[] })
    .sessions;
  expect(sessions.find((s) => s.id === first.id)?.phase.phase).toBe("stopped");
  expect(sessions.find((s) => s.id === second.id)?.phase.phase).toBe("running");
});

it("unknown_session_id_is_not_found", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });

  await expect(
    rig.call("session/prompt", {
      sessionId: "missing",
      text: "hi",
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });

  await expect(
    rig.call("session/stop", { sessionId: "missing" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });

  await expect(
    rig.call("permission/answer", {
      requestId: "req-1",
      optionId: "opt-1",
      sessionId: "missing",
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });

  await expect(
    rig.call("session/close", { sessionId: "missing" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
});

it("failed_start_leaves_no_session", async () => {
  const rig = await openRig({ accounts: [] });

  await expect(
    rig.call("session/start", startParams(rig)),
  ).rejects.toBeInstanceOf(Error);

  const snapshot = await rig.call("sessions/snapshot", {});
  const sessions = (snapshot as unknown as { sessions: unknown[] }).sessions;
  expect(sessions).toEqual([]);
});

it("close_ended_session_removes_it", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const started = await rig.call("session/start", startParams(rig));
  agentOf(rig, 0).enqueue([
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Edit",
      kind: "edit",
    },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [
        { type: "diff", path: join(rig.cwd, "a.txt"), newText: "hi\n" },
      ],
    },
    END_TURN,
  ]);
  await rig.call("session/prompt", {
    sessionId: started.id,
    text: "edit",
  });
  await settled(async () => {
    const snap = await rig.call("sessions/snapshot", {});
    expect(snap.editedFiles).toHaveLength(1);
  });
  await rig.call("session/stop", { sessionId: started.id });

  const closed = await rig.call("session/close", { sessionId: started.id });

  expect(closed).toEqual({ closed: true });
  expect(rig.broadcastsOf("session/removed")).toContainEqual({
    sessionId: started.id,
  });
  const after = await rig.call("sessions/snapshot", {});
  const sessions = (after as unknown as { sessions: unknown[] }).sessions;
  expect(sessions).toEqual([]);
  expect(after.editedFiles).toEqual([]);
});

it("close_live_session_conflicts", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const started = await rig.call("session/start", startParams(rig));

  await expect(
    rig.call("session/close", { sessionId: started.id }),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });

  await rig.call("session/stop", { sessionId: started.id });
});

it("user_flow_run_blocked_while_any_session_live", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const flowRepo = await makeTempDir("cw-flow-");
  await mkdir(flowRepo, { recursive: true });
  await writeFlowFiles(flowRepo);

  const first = await rig.call("session/start", {
    cwd: rig.cwd,
    profile: "ask",
  });
  const secondCwd = await makeTempDir("cw-second-");
  await rig.call("session/start", { cwd: secondCwd });
  await rig.call("session/stop", { sessionId: first.id });

  await expect(
    rig.call("flow/start", {
      cwd: flowRepo,
      flowId: "solo",
      task: "Run solo",
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
});

it("permission_for_session_a_not_answered_in_b", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const secondCwd = await makeTempDir("cw-second-");
  const first = await rig.call("session/start", {
    cwd: rig.cwd,
    profile: "ask",
  });
  const second = await rig.call("session/start", { cwd: secondCwd });

  agentOf(rig, 0).enqueue([
    {
      type: "permission",
      toolCallId: "t-perm",
      title: "Run check",
      kind: "execute",
      paths: [join(rig.cwd, "a.txt")],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    END_TURN,
  ]);
  await rig.call("session/prompt", { sessionId: first.id, text: "check" });
  await settled(async () => {
    const snap = await rig.call("sessions/snapshot", {});
    const s = snap.sessions.find((entry) => entry.id === first.id);
    expect(s?.permissions).toHaveLength(1);
  });
  const snap = await rig.call("sessions/snapshot", {});
  const perm = snap.sessions.find((entry) => entry.id === first.id)
    ?.permissions[0];
  expect(perm).toBeDefined();

  await expect(
    rig.call("permission/answer", {
      requestId: perm?.requestId ?? "",
      optionId: perm?.options[0]?.optionId ?? "",
      sessionId: second.id,
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
});
