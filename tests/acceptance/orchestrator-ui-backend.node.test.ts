import { afterEach, beforeEach, expect, it } from "vitest";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import {
  BASE_FILE,
  TASK,
  connectTools,
  createFlowRepo,
  isolateGitEnv,
  removeFlowRepo,
  restoreEnv,
  toolEndpointOf,
  untilRunStatus,
  writeFlowFiles,
  type FlowRepo,
  type ToolClient,
} from "../fakes/orchestratorHarness";

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const NOTE = "The diff matches the task";

const repos: FlowRepo[] = [];
const clients: ToolClient[] = [];

beforeEach(() => {
  isolateGitEnv();
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await closeRigs();
  await Promise.all(repos.splice(0).map(removeFlowRepo));
  restoreEnv();
});

function say(text: string): readonly ScriptStep[] {
  return [{ type: "text", text }, END_TURN];
}

async function orchestrate(
  rig: BackendRig,
  cwd: string,
): Promise<{ readonly tools: ToolClient; readonly sessionId: string }> {
  const view = await rig.call("session/start", { cwd, orchestrate: true });
  const tools = await connectTools(toolEndpointOf(agentOf(rig)));
  clients.push(tools);
  return { tools, sessionId: view.id };
}

async function openOrchestratedRig(): Promise<BackendRig> {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  await writeFlowFiles(rig.cwd);
  return rig;
}

async function pausedGatedRun(
  rig: BackendRig,
  tools: ToolClient,
): Promise<string> {
  rig.container.scriptNext(say("built"));
  const started = (await tools.json("start_flow", {
    flowId: "gated",
    task: TASK,
  })) as { runId: string };
  await untilRunStatus(rig, started.runId, "awaiting_decision");
  return started.runId;
}

it("a_worktree_flow_runs_when_flows_and_agents_are_gitignored_in_the_project", async () => {
  const flowRepo = await createFlowRepo({ ignoreFlowFiles: true });
  repos.push(flowRepo);
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const { tools } = await orchestrate(rig, flowRepo.repo);
  rig.container.scriptNext([
    { type: "write_file", path: BASE_FILE, content: "changed\n" },
    END_TURN,
  ]);

  const reply = await tools.call("start_flow", {
    flowId: "solo",
    task: TASK,
    placement: "worktree",
  });

  expect(reply.isError).toBe(false);
  const started = JSON.parse(reply.text) as { runId: string; cwd: string };
  expect(started.cwd).not.toBe(flowRepo.repo);
  const done = await untilRunStatus(rig, started.runId, "done");
  expect(done.placement).toBe("worktree");
});

it("a_decide_tool_call_with_a_note_logs_it_and_a_ui_decision_logs_a_null_note", async () => {
  const rig = await openOrchestratedRig();
  const { tools } = await orchestrate(rig, rig.cwd);
  const firstRun = await pausedGatedRun(rig, tools);
  rig.container.scriptNext(say("reviewed"));

  const decided = await tools.json("decide", {
    runId: firstRun,
    decision: "approve",
    note: NOTE,
  });

  expect(decided).toMatchObject({
    decisions: [
      { nodeId: "review", reason: "gate", decision: "approve", note: NOTE },
    ],
  });
  await untilRunStatus(rig, firstRun, "done");
  const secondRun = await pausedGatedRun(rig, tools);
  rig.container.scriptNext(say("reviewed"));
  const viaUi = await rig.call("flow/decide", {
    runId: secondRun,
    decision: "approve",
  });
  expect(viaUi.decisions).toEqual([
    { nodeId: "review", reason: "gate", decision: "approve", note: null },
  ]);
});

it("a_rejected_decision_leaves_the_decision_log_empty", async () => {
  const rig = await openOrchestratedRig();
  const { tools } = await orchestrate(rig, rig.cwd);
  const runId = await pausedGatedRun(rig, tools);

  const reply = await tools.call("decide", {
    runId,
    decision: "another_round",
  });

  expect(reply.isError).toBe(true);
  const view = await tools.json("flow_status", { runId });
  expect(view).toMatchObject({ decisions: [] });
});

it("orchestrator_runs_carry_the_session_id_and_user_runs_carry_null", async () => {
  const orchestrated = await openOrchestratedRig();
  const { tools, sessionId } = await orchestrate(
    orchestrated,
    orchestrated.cwd,
  );
  orchestrated.container.scriptNext(say("done"));

  const owned = await tools.json("start_flow", { flowId: "solo", task: TASK });

  expect(owned).toMatchObject({ ownerSessionId: sessionId });

  const plain = await openOrchestratedRig();
  plain.container.scriptNext(say("done"));
  const own = await plain.call("flow/start", {
    cwd: plain.cwd,
    flowId: "solo",
    task: TASK,
  });
  expect(own).toMatchObject({ ownerSessionId: null });
});
