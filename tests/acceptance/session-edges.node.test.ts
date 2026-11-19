import { afterEach, expect, it } from "vitest";

import { IpcErrorCode } from "../../src/shared/protocol";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import {
  AUTH_REQUIRED_CODE,
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import type { FakeContained } from "../fakes/fakeContainer";
import { settled } from "../fakes/settle";

const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const NEEDS_LOGIN_FAILURE: ScriptStep = {
  type: "fail",
  code: AUTH_REQUIRED_CODE,
  message: "Auth required",
};
const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const ASK_STEP: ScriptStep = {
  type: "permission",
  toolCallId: "t1",
  title: "Run ls",
  kind: "execute",
  rawInput: { command: "ls" },
  paths: [],
  options: DEFAULT_PERMISSION_OPTIONS,
};
const AGENT_STOP_GRACE_MS = 5000;

afterEach(closeRigs);

function containedOf(rig: BackendRig, index: number): FakeContained {
  const contained = rig.container.contained[index];
  if (contained === undefined) {
    throw new Error(`container ${String(index)} was not spawned`);
  }
  return contained;
}

async function pendingRequestId(rig: BackendRig): Promise<string> {
  return settled(async () => {
    const [pending] = (await rig.session()).permissions;
    if (pending === undefined) {
      throw new Error("no pending permission yet");
    }
    return pending.requestId;
  });
}

async function askForPermission(rig: BackendRig): Promise<string> {
  await rig.call("session/start", startParams(rig, "ask"));
  agentOf(rig).enqueue([ASK_STEP, END_TURN]);
  await rig.call("session/prompt", { text: "list files" });
  return pendingRequestId(rig);
}

it("session_prompt_rejected_while_switching", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    worktreeGate: gate.promise,
  });
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { text: "go" });
  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "switching",
      from: ACCOUNT_A.id,
      to: ACCOUNT_B.id,
    });
  });

  await expect(
    rig.call("session/prompt", { text: "again" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });

  gate.resolve(undefined);
  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_B.id,
    });
  });
});

it("session_prompt_rejected_while_turn_in_flight", async () => {
  const rig = await openRig();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([{ type: "hang" }]);
  await rig.call("session/prompt", { text: "first" });

  await expect(
    rig.call("session/prompt", { text: "second" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });

  expect((await rig.session()).turnInFlight).toBe(true);
  expect(agentOf(rig).prompts).toEqual(["first"]);
});

it("permission_answer_twice_rejected", async () => {
  const rig = await openRig();
  const requestId = await askForPermission(rig);
  await rig.call("permission/answer", { requestId, optionId: "allow-once" });
  await turnEnded(rig);

  await expect(
    rig.call("permission/answer", { requestId, optionId: "reject-once" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });

  expect(agentOf(rig).permissionOutcomes).toEqual([
    { outcome: "selected", optionId: "allow-once" },
  ]);
});

it("permission_answer_after_stop_rejected_as_expired", async () => {
  const rig = await openRig();
  const requestId = await askForPermission(rig);
  await rig.call("session/stop", {});

  await expect(
    rig.call("permission/answer", { requestId, optionId: "allow-once" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.EXPIRED });
});

it("permission_answer_rejects_unknown_request_and_option", async () => {
  const rig = await openRig();
  const requestId = await askForPermission(rig);

  await expect(
    rig.call("permission/answer", { requestId: "ghost", optionId: "x" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  await expect(
    rig.call("permission/answer", { requestId, optionId: "not-offered" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
});

it("agent_crash_mid_turn_marks_session_failed_and_releases_lock", async () => {
  const rig = await openRig();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([{ type: "hang" }]);
  await rig.call("session/prompt", { text: "work" });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(true);
  });

  rig.container.contained[0]?.emitExit(1);

  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toEqual({
      phase: "failed",
      reason: "Agent process exited",
      runningAccountId: ACCOUNT_A.id,
    });
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).toEqual({
      kind: "failed",
      message: "Agent process exited",
    });
  });
  await expect(
    rig.call("session/prompt", { text: "more" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });
  const restarted = await rig.call("session/start", startParams(rig));
  expect(restarted.phase).toEqual({
    phase: "running",
    accountId: ACCOUNT_A.id,
  });
  expect(rig.container.contained).toHaveLength(2);
});

it("session_start_rejected_while_a_session_is_live", async () => {
  const rig = await openRig();
  await rig.call("session/start", startParams(rig));

  await expect(
    rig.call("session/start", startParams(rig)),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  expect(rig.container.contained).toHaveLength(1);
});

it("start_after_halt_stops_old_agent_first", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([NEEDS_LOGIN_FAILURE]);
  await rig.call("session/prompt", { text: "go" });
  await settled(async () => {
    expect((await rig.session()).phase).toEqual({ phase: "halted" });
  });
  await rig.call("accounts/add", {
    label: "Late",
    configDir: `${rig.userData}/late`,
  });

  const restarted = await rig.call("session/start", startParams(rig));

  expect(rig.order).toEqual([
    "spawn:run-1",
    "stop-confirmed:run-1",
    "spawn:run-2",
  ]);
  expect(containedOf(rig, 0).stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
  expect(restarted.phase.phase).toBe("running");
});

it("prompt_rejected_while_rotation_chain_busy", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { text: "go" });
  await settled(async () => {
    expect((await rig.session()).phase.phase).toBe("waiting");
  });
  rig.container.holdStops();
  rig.container.scriptNext([RATE_LIMIT_FAILURE]);

  rig.scheduled[0]?.run();
  try {
    await settled(() => {
      expect(containedOf(rig, 1).stopCalls).toHaveLength(1);
    });
    const view = await rig.session();
    expect(view.phase).toEqual({ phase: "running", accountId: ACCOUNT_A.id });
    expect(view.turnInFlight).toBe(false);

    await expect(
      rig.call("session/prompt", { text: "again" }),
    ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });
    expect(agentOf(rig, 1).prompts).toHaveLength(1);
  } finally {
    containedOf(rig, 1).resolveHeldStops();
  }

  await settled(async () => {
    expect((await rig.session()).phase.phase).toBe("waiting");
  });
});

it("account_remove_rejected_while_switching", async () => {
  const rig = await openRig();
  await rig.call("session/start", startParams(rig));
  containedOf(rig, 0).holdStops();
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { text: "go" });
  await settled(() => {
    expect(containedOf(rig, 0).stopCalls).toHaveLength(1);
  });

  try {
    await expect(
      rig.call("accounts/remove", { id: ACCOUNT_B.id }),
    ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  } finally {
    containedOf(rig, 0).resolveHeldStops();
  }

  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_B.id,
    });
  });
  expect(rig.container.agents).toHaveLength(2);
});

it("shutdown_stops_all_containers", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    worktreeGate: gate.promise,
  });
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { text: "go" });
  await settled(async () => {
    expect((await rig.session()).phase.phase).toBe("switching");
  });

  const shuttingDown = rig.backend.shutdown();
  gate.resolve(undefined);
  await shuttingDown;

  await settled(() => {
    expect(rig.container.contained.map((item) => item.stopCalls)).toEqual([
      [AGENT_STOP_GRACE_MS],
      [AGENT_STOP_GRACE_MS],
    ]);
  });
  expect((await rig.session()).phase).toEqual({ phase: "stopped" });
});

it("shutdown_stops_the_live_agent_and_marks_the_session_stopped", async () => {
  const rig = await openRig();
  await rig.call("session/start", startParams(rig));

  await rig.backend.shutdown();

  expect(rig.container.contained.map((item) => item.stopCalls)).toEqual([
    [AGENT_STOP_GRACE_MS],
  ]);
  expect((await rig.session()).phase).toEqual({ phase: "stopped" });
});

it("account_remove_active_rejected", async () => {
  const rig = await openRig();
  await rig.call("session/start", startParams(rig));

  await expect(
    rig.call("accounts/remove", { id: ACCOUNT_A.id }),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  const afterIdle = await rig.call("accounts/remove", { id: ACCOUNT_B.id });
  expect(afterIdle.accounts.map((account) => account.id)).toEqual([
    ACCOUNT_A.id,
  ]);

  await rig.call("session/stop", {});
  const afterStop = await rig.call("accounts/remove", { id: ACCOUNT_A.id });
  expect(afterStop.accounts).toEqual([]);
});

it("accounts_added_during_a_session_are_used_for_the_next_switch", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  await rig.call("session/start", startParams(rig));
  const { account } = await rig.call("accounts/add", {
    label: "Late",
    configDir: `${rig.userData}/late`,
  });
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/prompt", { text: "go" });

  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: account.id,
    });
  });
});

it("first_run_has_no_accounts", async () => {
  const rig = await openRig({});

  const snapshot = await rig.call("sessions/snapshot", {});

  expect(snapshot.accounts).toEqual([]);
  expect(snapshot.session).toBeNull();
  await expect(
    rig.call("session/start", startParams(rig)),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No usable account",
  });
});
