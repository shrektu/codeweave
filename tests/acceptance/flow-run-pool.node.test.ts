import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { FlowRunOrigin } from "../../src/domain/types";
import { IpcErrorCode, type ParamsMap } from "../../src/shared/protocol";
import {
  SessionViewSchema,
  type FlowRunView,
  type SessionView,
} from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  type BackendRig,
} from "../fakes/backendRig";
import {
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import { settled } from "../fakes/settle";

const TASK = "Add a login form";
const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const HOLD_TURN: ScriptStep = {
  type: "permission",
  toolCallId: "t1",
  title: "Run pnpm test",
  kind: "execute",
  rawInput: { command: "pnpm test" },
  paths: [],
  options: DEFAULT_PERMISSION_OPTIONS,
};
const HOLD: readonly ScriptStep[] = [HOLD_TURN, END_TURN];
const HANDOFF_LIMIT = 16_000;

const AGENTS = `---
id: coder
role: Writes the change
provider: claude
permissionProfile: unattended
---

Write small, tested changes.

---
id: reviewer
role: Reviews the change
provider: claude
permissionProfile: unattended
---

Review the diff and report bugs only.

---
id: asker
role: Writes the change and asks first
provider: claude
permissionProfile: ask
---

Ask before running anything.
`;

const FILES: Readonly<Record<string, string>> = {
  "agents/team.md": AGENTS,
  "flows/solo.md": `---\nid: solo\ntitle: Flow solo\nnodes:\n  - id: build\n    agent: coder\nedges: []\n---\n`,
  "flows/hold.md": `---\nid: hold\ntitle: Flow hold\nnodes:\n  - id: build\n    agent: asker\nedges: []\n---\n`,
  "flows/build-review.md": `---
id: build-review
title: Flow build-review
nodes:
  - id: build
    agent: coder
  - id: review
    agent: reviewer
edges:
  - from: build
    to: review
    kind: hands_off_to
---
`,
};

const FlowSessionEventSchema = z.strictObject({
  runId: z.string(),
  view: SessionViewSchema.nullable(),
});
type FlowSessionEvent = z.infer<typeof FlowSessionEventSchema>;

type OrchestratorRunParams = ParamsMap["flow/start"] & {
  readonly origin: FlowRunOrigin;
};

const folders: string[] = [];

afterEach(async () => {
  await closeRigs();
  await Promise.all(
    folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeFlows(dir: string): Promise<void> {
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), text);
  }
}

async function folderWithFlows(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-pool-"));
  folders.push(dir);
  await writeFlows(dir);
  return dir;
}

async function openFlowRig(): Promise<BackendRig> {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  await writeFlows(rig.cwd);
  return rig;
}

function userRun(cwd: string, flowId: string): ParamsMap["flow/start"] {
  return { cwd, flowId, task: TASK };
}

function orchestratorRun(cwd: string, flowId: string): OrchestratorRunParams {
  return { cwd, flowId, task: TASK, origin: FlowRunOrigin.orchestrator };
}

function scriptTurns(
  rig: BackendRig,
  ...turns: readonly (readonly ScriptStep[])[]
): void {
  for (const turn of turns) {
    rig.container.scriptNext(turn);
  }
}

function say(text: string): readonly ScriptStep[] {
  return [{ type: "text", text }, END_TURN];
}

async function flowRunsOf(rig: BackendRig): Promise<FlowRunView[]> {
  const { flowRuns } = await rig.call("sessions/snapshot", {});
  expect(flowRuns).toBeInstanceOf(Array);
  return flowRuns;
}

async function statusOf(
  rig: BackendRig,
  runId: string,
): Promise<FlowRunView["status"] | undefined> {
  const runs = await flowRunsOf(rig);
  return runs.find((run) => run.runId === runId)?.status;
}

async function untilStatus(
  rig: BackendRig,
  runId: string,
  status: FlowRunView["status"],
): Promise<void> {
  await settled(async () => {
    expect(await statusOf(rig, runId)).toBe(status);
  });
}

async function nodeSession(
  rig: BackendRig,
  runId: string,
): Promise<SessionView | undefined> {
  const { flowSessions } = await rig.call("sessions/snapshot", {});
  expect(flowSessions).toBeInstanceOf(Array);
  return flowSessions.find((entry) => entry.runId === runId)?.view;
}

async function untilHeld(rig: BackendRig, runId: string): Promise<string> {
  return settled(async () => {
    const view = await nodeSession(rig, runId);
    expect(view?.permissions).toHaveLength(1);
    return view?.permissions[0]?.requestId ?? "";
  });
}

async function answerHeld(rig: BackendRig, runId: string): Promise<void> {
  const requestId = await untilHeld(rig, runId);
  await rig.call("permission/answer", {
    requestId,
    optionId: "allow-once",
    runId,
  });
}

function flowSessionEvents(rig: BackendRig, runId: string): FlowSessionEvent[] {
  return rig
    .broadcastsOf("flowSession/changed")
    .map((payload) => FlowSessionEventSchema.parse(payload))
    .filter((event) => event.runId === runId);
}

it("orchestrator_run_streams_its_node_session_beside_a_live_main_session", async () => {
  const rig = await openFlowRig();
  const folder = await folderWithFlows();
  const main = await rig.call("session/start", startParams(rig));
  scriptTurns(rig, say("Node output"));

  const run = await rig.call("flow/start", orchestratorRun(folder, "solo"));

  expect(run).toMatchObject({
    origin: "orchestrator",
    placement: "in_place",
    branch: null,
    status: "running",
  });
  await untilStatus(rig, run.runId, "done");
  const nodeViews = flowSessionEvents(rig, run.runId).flatMap((event) =>
    event.view === null ? [] : [event.view],
  );
  expect(nodeViews.length).toBeGreaterThan(0);
  expect(nodeViews.every((view) => view.flowRef?.nodeId === "build")).toBe(
    true,
  );
  expect(nodeViews.at(-1)?.messages.map((message) => message.text)).toEqual([
    "Node output",
  ]);
  const mainIds = rig
    .broadcastsOf("session/changed")
    .map((payload) => SessionViewSchema.nullable().parse(payload)?.id);
  expect([...new Set(mainIds)]).toEqual([main.id]);
  expect((await rig.session()).phase.phase).toBe("running");
});

it("two_runs_in_different_folders_run_their_node_agents_at_the_same_time", async () => {
  const rig = await openFlowRig();
  const second = await folderWithFlows();
  scriptTurns(rig, HOLD, HOLD);

  const first = await rig.call("flow/start", userRun(rig.cwd, "hold"));
  const other = await rig.call("flow/start", userRun(second, "hold"));
  await untilHeld(rig, first.runId);
  await untilHeld(rig, other.runId);

  expect(rig.container.agents).toHaveLength(2);
  expect(
    rig.container.contained.map((contained) => contained.stopCalls.length),
  ).toEqual([0, 0]);
  expect(await statusOf(rig, first.runId)).toBe("running");
  expect(await statusOf(rig, other.runId)).toBe("running");

  await answerHeld(rig, first.runId);
  await answerHeld(rig, other.runId);
  await untilStatus(rig, first.runId, "done");
  await untilStatus(rig, other.runId, "done");
});

it("a_fourth_open_run_is_refused_with_a_conflict_naming_the_cap_of_three", async () => {
  const rig = await openFlowRig();
  const [second, third, fourth] = await Promise.all([
    folderWithFlows(),
    folderWithFlows(),
    folderWithFlows(),
  ]);
  scriptTurns(rig, HOLD, HOLD, HOLD);
  await rig.call("flow/start", userRun(rig.cwd, "hold"));
  await rig.call("flow/start", userRun(second, "hold"));
  await rig.call("flow/start", userRun(third, "hold"));

  await expect(
    rig.call("flow/start", userRun(fourth, "hold")),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "At most 3 flows can run at once",
  });

  expect(await flowRunsOf(rig)).toHaveLength(3);
});

it("a_second_open_run_in_the_same_folder_is_refused_with_a_conflict", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, HOLD);
  await rig.call("flow/start", userRun(rig.cwd, "hold"));

  await expect(
    rig.call("flow/start", userRun(rig.cwd, "hold")),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is already running in this folder",
  });

  expect(await flowRunsOf(rig)).toHaveLength(1);
});

it("flow_stop_with_a_run_id_stops_only_that_run", async () => {
  const rig = await openFlowRig();
  const folderA = await folderWithFlows();
  const folderB = await folderWithFlows();
  await rig.call("session/start", startParams(rig));
  scriptTurns(rig, HOLD, HOLD);
  const first = await rig.call("flow/start", orchestratorRun(folderA, "hold"));
  const other = await rig.call("flow/start", orchestratorRun(folderB, "hold"));
  await untilHeld(rig, first.runId);
  await untilHeld(rig, other.runId);

  await expect(rig.call("flow/stop", { runId: first.runId })).resolves.toEqual({
    stopped: true,
  });

  await untilStatus(rig, first.runId, "stopped");
  expect(await statusOf(rig, other.runId)).toBe("running");
  expect((await nodeSession(rig, other.runId))?.permissions).toHaveLength(1);
  expect(await nodeSession(rig, first.runId)).toBeUndefined();
  expect((await rig.session()).phase.phase).toBe("running");
});

it("session_stop_with_open_runs_stops_only_the_main_session", async () => {
  const rig = await openFlowRig();
  const folder = await folderWithFlows();
  await rig.call("session/start", startParams(rig));
  scriptTurns(rig, HOLD);
  const run = await rig.call("flow/start", orchestratorRun(folder, "hold"));
  await untilHeld(rig, run.runId);

  await expect(rig.call("session/stop", {})).resolves.toEqual({
    stopped: true,
  });

  expect((await rig.session()).phase.phase).toBe("stopped");
  expect(await statusOf(rig, run.runId)).toBe("running");
  expect((await nodeSession(rig, run.runId))?.permissions).toHaveLength(1);
});

it("user_flow_start_while_the_main_session_is_live_is_still_refused", async () => {
  const rig = await openFlowRig();
  const folder = await folderWithFlows();
  await rig.call("session/start", startParams(rig));

  await expect(
    rig.call("flow/start", userRun(folder, "solo")),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A session is already running",
  });

  expect(await flowRunsOf(rig)).toEqual([]);
});

it("accounts_remove_of_an_account_used_only_by_a_run_node_session_is_refused", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, HOLD);
  const run = await rig.call("flow/start", userRun(rig.cwd, "hold"));
  await untilHeld(rig, run.runId);

  await expect(
    rig.call("accounts/remove", { id: ACCOUNT_A.id }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Account is used by the running session",
  });
});

it("a_16000_character_hand_off_passes_intact", async () => {
  const rig = await openFlowRig();
  const text = "x".repeat(HANDOFF_LIMIT);
  scriptTurns(rig, say(text), say("Fine."));

  const run = await rig.call("flow/start", userRun(rig.cwd, "build-review"));
  await untilStatus(rig, run.runId, "done");

  const prompt = agentOf(rig, 1).prompts[0] ?? "";
  expect(prompt).toContain(`## Hand-off from build\n${text}\n\n`);
  expect(prompt).not.toContain("[truncated");
});

it("a_16001_character_hand_off_is_truncated", async () => {
  const rig = await openFlowRig();
  const text = "x".repeat(HANDOFF_LIMIT + 1);
  scriptTurns(rig, say(text), say("Fine."));

  const run = await rig.call("flow/start", userRun(rig.cwd, "build-review"));
  await untilStatus(rig, run.runId, "done");

  const prompt = agentOf(rig, 1).prompts[0] ?? "";
  expect(prompt).toContain(
    `## Hand-off from build\n${"x".repeat(HANDOFF_LIMIT)}\n[truncated, 1 more characters]`,
  );
});

it("a_finished_run_releases_its_session_instance", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, say("Built"));

  const run = await rig.call("flow/start", userRun(rig.cwd, "solo"));
  await untilStatus(rig, run.runId, "done");

  await settled(async () => {
    expect(await nodeSession(rig, run.runId)).toBeUndefined();
  });
  const events = flowSessionEvents(rig, run.runId);
  expect(events.some((event) => event.view !== null)).toBe(true);
  expect(events.at(-1)).toEqual({ runId: run.runId, view: null });
  await expect(
    rig.call("accounts/remove", { id: ACCOUNT_A.id }),
  ).resolves.toMatchObject({
    accounts: [expect.objectContaining({ id: "acc-b" })],
  });
});
