import { afterEach, expect, it } from "vitest";

import {
  startFlowToolServer,
  type ToolGrant,
} from "../../src/backend/flowTools/server";
import { IpcErrorCode } from "../../src/shared/protocol";
import {
  FlowRunViewSchema,
  FlowsListSchema,
  type FlowRunView,
} from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  type BackendRig,
  type BackendRigOptions,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import {
  TASK,
  TOOL_SERVER_NAME,
  connectTools,
  gatedStartToolServer,
  postWithToken,
  recordingToolServer,
  toolEndpointOf,
  untilRunStatus,
  writeFlowFiles,
  type ToolClient,
  type ToolEndpoint,
} from "../fakes/orchestratorHarness";
import { settled } from "../fakes/settle";

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const PREAMBLE_START = "You are the Codeweave orchestrator.";
const WAKEUP_PREFIX = "[Codeweave]";
const OPEN_STATUSES: readonly FlowRunView["status"][] = [
  "running",
  "awaiting_decision",
];

interface Orchestrated {
  readonly rig: BackendRig;
  readonly endpoint: ToolEndpoint;
  readonly tools: ToolClient;
}

const clients: ToolClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await closeRigs();
});

async function openOrchestrated(
  options: Partial<BackendRigOptions> = {},
): Promise<BackendRig> {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B], ...options });
  await writeFlowFiles(rig.cwd);
  return rig;
}

async function startOrchestrator(rig: BackendRig): Promise<Orchestrated> {
  await rig.call("session/start", { cwd: rig.cwd, orchestrate: true });
  const endpoint = toolEndpointOf(agentOf(rig));
  const tools = await connectTools(endpoint);
  clients.push(tools);
  return { rig, endpoint, tools };
}

async function orchestrated(): Promise<Orchestrated> {
  return startOrchestrator(await openOrchestrated());
}

function say(text: string): readonly ScriptStep[] {
  return [{ type: "text", text }, END_TURN];
}

async function startInPlace(tools: ToolClient): Promise<FlowRunView> {
  return FlowRunViewSchema.parse(
    await tools.json("start_flow", { flowId: "solo", task: TASK }),
  );
}

it("starts_an_orchestrate_session_with_plan_profile_and_the_flow_tools_without_leaking_the_token", async () => {
  const rig = await openOrchestrated();

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    orchestrate: true,
    profile: "bypass",
  });

  expect(view.profile).toBe("plan");
  expect(view.orchestrate).toBe(true);
  const [server] = agentOf(rig).newSessions[0]?.mcpServers ?? [];
  expect(server).toMatchObject({ type: "http", name: TOOL_SERVER_NAME });
  const { token } = toolEndpointOf(agentOf(rig));
  agentOf(rig).enqueue([
    { type: "text", text: `leaked ${token} in text` },
    {
      type: "fail",
      code: -32603,
      message: `failed with ${token}`,
    },
  ]);
  await rig.call("session/prompt", { text: "hello" });
  await settled(async () => {
    const current = await rig.session();
    expect(current.turnInFlight).toBe(false);
    expect(current.lastTurn).not.toBeNull();
  });
  const serialized = JSON.stringify([
    view,
    await rig.session(),
    rig.broadcasts,
  ]);
  expect(serialized).toContain("leaked");
  expect(serialized).not.toContain(token);
});

it("an_ordinary_session_start_carries_no_tools", async () => {
  const rig = await openOrchestrated();

  const view = await rig.call("session/start", startParams(rig));

  expect(view.orchestrate).toBe(false);
  expect(agentOf(rig).newSessions[0]?.mcpServers).toEqual([]);
});

it("rotation_launches_the_next_account_with_the_same_tools_and_the_preamble_again", async () => {
  const { rig, endpoint } = await orchestrated();
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/prompt", { text: "go" });
  await settled(() => {
    expect(agentOf(rig, 1).prompts).toHaveLength(1);
  });

  expect(toolEndpointOf(agentOf(rig, 1))).toEqual(endpoint);
  expect(agentOf(rig, 1).newSessions[0]?.mcpServers).toEqual(
    agentOf(rig).newSessions[0]?.mcpServers,
  );
  const first = agentOf(rig).prompts[0] ?? "";
  expect(first.startsWith(PREAMBLE_START)).toBe(true);
  expect(first.endsWith("\n\ngo")).toBe(true);
  expect((agentOf(rig, 1).prompts[0] ?? "").startsWith(PREAMBLE_START)).toBe(
    true,
  );
  const view = await rig.session();
  expect(JSON.stringify(view.messages)).not.toContain(PREAMBLE_START);
});

it("serves_list_flows_start_flow_and_flow_status_and_refuses_a_foreign_run", async () => {
  const { rig, tools } = await orchestrated();
  rig.container.scriptNext(say("built"));

  const list = FlowsListSchema.parse(await tools.json("list_flows", {}));
  const started = await startInPlace(tools);
  const status = FlowRunViewSchema.parse(
    await tools.json("flow_status", { runId: started.runId }),
  );
  const foreign = await tools.call("flow_status", { runId: "run-not-mine" });
  const unknownNode = await tools.call("node_result", {
    runId: started.runId,
    nodeId: "missing",
  });

  expect(list.flows.map((flow) => flow.id).toSorted()).toEqual([
    "gated",
    "solo",
  ]);
  expect(started).toMatchObject({
    flowId: "solo",
    placement: "in_place",
    origin: "orchestrator",
    branch: null,
    cwd: rig.cwd,
  });
  expect(status.runId).toBe(started.runId);
  expect(foreign).toEqual({ text: "Unknown flow run", isError: true });
  expect(unknownNode).toEqual({ text: "Unknown node", isError: true });
  await untilRunStatus(rig, started.runId, "done");
});

it("one_waiting_flow_produces_exactly_one_codeweave_prompt_after_the_turn_ends", async () => {
  const { rig, tools } = await orchestrated();
  const release = Promise.withResolvers<undefined>();
  agentOf(rig).enqueue([
    { type: "gate", until: release.promise },
    { type: "text", text: "turn text" },
    END_TURN,
  ]);
  await rig.call("session/prompt", { text: "go" });
  rig.container.scriptNext(say("built"));

  const started = FlowRunViewSchema.parse(
    await tools.json("start_flow", { flowId: "gated", task: TASK }),
  );
  const paused = await untilRunStatus(rig, started.runId, "awaiting_decision");

  expect(paused.decision).toEqual({ reason: "gate", nodeId: "review" });
  expect(agentOf(rig).prompts).toHaveLength(1);
  release.resolve(undefined);
  await settled(() => {
    expect(agentOf(rig).prompts).toHaveLength(2);
  });
  const wakeup = agentOf(rig).prompts[1] ?? "";
  expect(wakeup.startsWith(WAKEUP_PREFIX)).toBe(true);
  expect(wakeup).toContain(started.runId);
  expect(wakeup).toContain("awaiting_decision");
  expect(wakeup).toContain("approve");
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(false);
  });
  expect(agentOf(rig).prompts).toHaveLength(2);
});

it("session_stop_ends_the_orchestration_stops_its_runs_and_revokes_the_token", async () => {
  const { rig, endpoint, tools } = await orchestrated();
  const never = Promise.withResolvers<undefined>();
  rig.container.scriptNext([{ type: "gate", until: never.promise }, END_TURN]);
  const started = await startInPlace(tools);
  await untilRunStatus(rig, started.runId, "running");
  expect(await postWithToken(endpoint, endpoint.token)).toBe(200);

  await rig.call("session/stop", {});

  await untilRunStatus(rig, started.runId, "stopped");
  expect(await postWithToken(endpoint, endpoint.token)).toBe(401);
  never.resolve(undefined);
});

it("a_start_flow_in_flight_when_the_session_stops_leaves_no_open_run", async () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const never = Promise.withResolvers<undefined>();
  const rig = await openOrchestrated({
    startToolServer: gatedStartToolServer({
      entered,
      release: release.promise,
    }),
  });
  const { tools } = await startOrchestrator(rig);
  rig.container.scriptNext([{ type: "gate", until: never.promise }, END_TURN]);

  const starting = tools.call("start_flow", { flowId: "solo", task: TASK });
  await entered.promise;
  await rig.call("session/stop", {});
  release.resolve(undefined);

  expect(await starting).toEqual({
    text: "The orchestration has ended",
    isError: true,
  });
  const { flowRuns } = await rig.call("sessions/snapshot", {});
  expect(flowRuns.filter((run) => OPEN_STATUSES.includes(run.status))).toEqual(
    [],
  );
  expect(rig.container.agents).toHaveLength(1);
  never.resolve(undefined);
});

it("a_session_that_stops_right_after_an_orchestrate_start_revokes_the_token", async () => {
  const grants: ToolGrant[] = [];
  const spawnGate = Promise.withResolvers<undefined>();
  const rig = await openOrchestrated({
    spawnGate: spawnGate.promise,
    startToolServer: recordingToolServer(grants),
  });

  const starting = rig.call("session/start", {
    cwd: rig.cwd,
    orchestrate: true,
  });
  await settled(() => {
    expect(rig.order.some((entry) => entry.startsWith("spawn:"))).toBe(true);
  });
  const stopping = rig.call("session/stop", {});
  spawnGate.resolve(undefined);
  await Promise.allSettled([starting, stopping]);

  const [grant] = grants;
  if (grant === undefined) {
    throw new Error("no grant was registered");
  }
  await settled(async () => {
    expect(
      await postWithToken({ url: grant.url, token: grant.token }, grant.token),
    ).toBe(401);
  });
});

it("an_unavailable_tool_server_fails_orchestrate_only_and_is_retried_later", async () => {
  let attempts = 0;
  const rig = await openOrchestrated({
    startToolServer: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("port in use"))
        : startFlowToolServer();
    },
  });

  await expect(
    rig.call("session/start", { cwd: rig.cwd, orchestrate: true }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: "Orchestrate is unavailable: port in use",
  });
  expect(rig.container.agents).toHaveLength(0);
  const ordinary = await rig.call("session/start", startParams(rig));
  expect(ordinary.orchestrate).toBe(false);
  await rig.call("session/stop", {});
  const retried = await rig.call("session/start", {
    cwd: rig.cwd,
    orchestrate: true,
  });

  expect(retried.orchestrate).toBe(true);
  expect(attempts).toBe(2);
});
