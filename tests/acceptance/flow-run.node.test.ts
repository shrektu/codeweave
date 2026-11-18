import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { IpcErrorCode, type ParamsMap } from "../../src/shared/protocol";
import type { FlowRunView } from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACCOUNT_CODEX_A,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  type BackendRig,
  type BackendRigOptions,
} from "../fakes/backendRig";
import {
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import { agentDelta } from "../fakes/fakeCodexAppServer";
import { settled } from "../fakes/settle";

const TASK = "Add a login form";
const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const HOLD_TURN: ScriptStep = {
  type: "permission",
  toolCallId: "t1",
  title: "Run pnpm test",
  kind: "execute",
  rawInput: { command: "pnpm test" },
  paths: [],
  options: DEFAULT_PERMISSION_OPTIONS,
};
const DIRTY_WORKTREE = {
  isRepo: true,
  root: "/work/app",
  porcelain: " M src/login.ts\n",
  diffStat: " src/login.ts | 4 ++--\n",
} as const;

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

const REVIEW_EDGES = `edges:
  - from: build
    to: review
    kind: hands_off_to
  - from: review
    to: build
    kind: reviews
`;

function flowFile(id: string, nodes: string, edges: string): string {
  return `---\nid: ${id}\ntitle: Flow ${id}\nnodes:\n${nodes}${edges}---\n`;
}

const BUILD_REVIEW_NODES = `  - id: build
    agent: coder
  - id: review
    agent: reviewer
`;

const FILES: Readonly<Record<string, string>> = {
  "agents/team.md": AGENTS,
  "flows/build-review.md": flowFile(
    "build-review",
    BUILD_REVIEW_NODES,
    REVIEW_EDGES,
  ),
  "flows/ask-review.md": flowFile(
    "ask-review",
    `  - id: build
    agent: asker
  - id: review
    agent: reviewer
`,
    REVIEW_EDGES,
  ),
  "flows/gated.md": flowFile(
    "gated",
    BUILD_REVIEW_NODES,
    `edges:
  - from: build
    to: review
    kind: hands_off_to
    gate: true
`,
  ),
  "flows/gated-review.md": flowFile(
    "gated-review",
    BUILD_REVIEW_NODES,
    `edges:
  - from: build
    to: review
    kind: hands_off_to
  - from: review
    to: build
    kind: reviews
    gate: true
`,
  ),
  "flows/foreign-gate.md": flowFile(
    "foreign-gate",
    `  - id: build
    agent: coder
  - id: r1
    agent: reviewer
  - id: r2
    agent: reviewer
`,
    `edges:
  - from: build
    to: r1
    kind: hands_off_to
  - from: r1
    to: r2
    kind: hands_off_to
  - from: r1
    to: build
    kind: reviews
    gate: true
  - from: r2
    to: build
    kind: reviews
`,
  ),
  "flows/parallel-gate.md": flowFile(
    "parallel-gate",
    `  - id: build
    agent: coder
  - id: r1
    agent: reviewer
  - id: r2
    agent: reviewer
`,
    `edges:
  - from: r1
    to: build
    kind: reviews
    gate: true
  - from: r2
    to: build
    kind: reviews
`,
  ),
  "flows/reorder.md": flowFile(
    "reorder",
    `  - id: review
    agent: reviewer
  - id: build
    agent: coder
`,
    `edges:
  - from: review
    to: build
    kind: reviews
`,
  ),
  "flows/prototype-ids.md": flowFile(
    "prototype-ids",
    `  - id: constructor
    agent: coder
  - id: __proto__
    agent: reviewer
`,
    `edges:
  - from: constructor
    to: __proto__
    kind: hands_off_to
  - from: __proto__
    to: constructor
    kind: reviews
`,
  ),
  "flows/codex-build.md": flowFile(
    "codex-build",
    `  - id: build
    agent: coder
    provider: codex
  - id: review
    agent: reviewer
`,
    REVIEW_EDGES,
  ),
  "flows/solo-codex.md": flowFile(
    "solo-codex",
    `  - id: build
    agent: coder
    provider: codex
`,
    "edges: []\n",
  ),
  "flows/broken-flow.md": flowFile(
    "broken-flow",
    `  - id: build
    agent: nobody
`,
    "edges: []\n",
  ),
};

afterEach(closeRigs);

async function openFlowRig(
  options: BackendRigOptions = { accounts: [ACCOUNT_A, ACCOUNT_B] },
): Promise<BackendRig> {
  const rig = await openRig(options);
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(join(rig.cwd, file, ".."), { recursive: true });
    await writeFile(join(rig.cwd, file), text);
  }
  return rig;
}

async function startFlow(
  rig: BackendRig,
  flowId: string,
): Promise<FlowRunView> {
  const started = rig.call("flow/start", {
    cwd: rig.cwd,
    flowId,
    task: TASK,
  });
  await expect(started).resolves.toMatchObject({
    flowId,
    task: TASK,
    status: "running",
  });
  return started;
}

async function flowRunOf(rig: BackendRig): Promise<FlowRunView> {
  const { flowRun } = await rig.call("sessions/snapshot", {});
  if (flowRun === null) {
    throw new Error("no flow run in snapshot");
  }
  return flowRun;
}

async function untilStatus(
  rig: BackendRig,
  status: FlowRunView["status"],
): Promise<FlowRunView> {
  return settled(async () => {
    const view = await flowRunOf(rig);
    expect(view.status).toBe(status);
    return view;
  });
}

async function answerHeldTurn(rig: BackendRig): Promise<void> {
  const requestId = await settled(async () => {
    const { permissions } = await rig.session();
    expect(permissions).toHaveLength(1);
    return permissions[0]?.requestId ?? "";
  });
  await rig.call("permission/answer", { requestId, optionId: "allow-once" });
}

async function untilTurnHeld(rig: BackendRig): Promise<void> {
  await settled(async () => {
    expect((await rig.session()).permissions).toHaveLength(1);
  });
}

function say(text: string): readonly ScriptStep[] {
  return [{ type: "text", text }, END_TURN];
}

function scriptTurns(
  rig: BackendRig,
  ...turns: readonly (readonly ScriptStep[])[]
): void {
  for (const turn of turns) {
    rig.container.scriptNext(turn);
  }
}

function nodeSummary(
  view: FlowRunView,
): readonly (readonly [string, string, number])[] {
  return view.nodes.map((node) => [node.id, node.status, node.visits]);
}

async function sessionPhase(rig: BackendRig): Promise<string | null> {
  const { session } = await rig.call("sessions/snapshot", {});
  return session?.phase.phase ?? null;
}

it("flow_run_two_nodes_hands_off_and_finishes_done", async () => {
  const rig = await openFlowRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    worktree: DIRTY_WORKTREE,
  });
  scriptTurns(
    rig,
    say("Implemented the login form"),
    say("Looks correct.\nVERDICT: APPROVED"),
  );

  await startFlow(rig, "build-review");
  const view = await untilStatus(rig, "done");

  expect(view.nodes).toEqual([
    {
      id: "build",
      status: "done",
      visits: 1,
      result: "Implemented the login form",
    },
    {
      id: "review",
      status: "done",
      visits: 1,
      result: "Looks correct.\nVERDICT: APPROVED",
    },
  ]);
  expect(view.round).toBe(1);
  expect(view.decision).toBeNull();
  expect(view.failure).toBeNull();
  expect(rig.container.agents).toHaveLength(2);
  const buildPrompt = agentOf(rig, 0).prompts[0] ?? "";
  expect(buildPrompt).toContain("Node: build");
  expect(buildPrompt).toContain("Write small, tested changes.");
  expect(buildPrompt).toContain(`## Task\n${TASK}`);
  expect(buildPrompt).not.toContain("VERDICT:");
  const reviewPrompt = agentOf(rig, 1).prompts[0] ?? "";
  expect(reviewPrompt).toContain("Node: review");
  expect(reviewPrompt).toContain(
    "## Hand-off from build\nImplemented the login form",
  );
  expect(reviewPrompt).toContain(
    "## Working tree\nRepository root: /work/app\ngit status --porcelain:\n M src/login.ts",
  );
  expect(reviewPrompt).toContain("VERDICT: APPROVED");
  expect(reviewPrompt).toContain("VERDICT: CHANGES_REQUESTED");
  expect(rig.broadcastsOf("flow/changed").at(-1)).toEqual(view);
  expect(await sessionPhase(rig)).toBe("stopped");
});

it("flow_run_node_provider_overrides_agent_provider", async () => {
  const rig = await openFlowRig({
    accounts: [ACCOUNT_A, ACCOUNT_CODEX_A],
  });
  rig.codexContainer.scriptNext([
    agentDelta("m1", "Built on codex"),
    { type: "complete", status: "completed" },
  ]);
  scriptTurns(rig, say("Fine.\nVERDICT: APPROVED"));

  await startFlow(rig, "codex-build");
  const view = await untilStatus(rig, "done");

  expect(rig.codexContainer.servers).toHaveLength(1);
  expect(rig.container.agents).toHaveLength(1);
  expect(view.nodes[0]?.result).toBe("Built on codex");
  expect(agentOf(rig, 0).prompts[0]).toContain(
    "## Hand-off from build\nBuilt on codex",
  );
});

it("flow_run_review_changes_requested_reruns_target_with_findings", async () => {
  const rig = await openFlowRig();
  scriptTurns(
    rig,
    say("first draft"),
    say("Missing tests.\nVERDICT: CHANGES_REQUESTED"),
    say("added tests"),
    say("Good now.\nVERDICT: APPROVED"),
  );

  await startFlow(rig, "build-review");
  const view = await untilStatus(rig, "done");

  expect(nodeSummary(view)).toEqual([
    ["build", "done", 2],
    ["review", "done", 2],
  ]);
  expect(view.round).toBe(2);
  expect(rig.container.agents).toHaveLength(4);
  const rework = agentOf(rig, 2).prompts[0] ?? "";
  expect(rework).toContain(
    "## Review findings from review\nMissing tests.\nVERDICT: CHANGES_REQUESTED",
  );
  expect(agentOf(rig, 0).prompts[0]).not.toContain("## Review findings");
  expect(agentOf(rig, 3).prompts[0]).toContain(
    "## Hand-off from build\nadded tests",
  );
});

it("flow_run_rounds_exhausted_pauses_then_another_round_and_stop", async () => {
  const rig = await openFlowRig();
  const changes = say("Still wrong.\nVERDICT: CHANGES_REQUESTED");
  scriptTurns(rig, say("draft 1"), changes, say("draft 2"), changes);

  const { runId } = await startFlow(rig, "build-review");
  const paused = await untilStatus(rig, "awaiting_decision");

  expect(paused.decision).toEqual({
    reason: "rounds_exhausted",
    nodeId: "review",
  });
  expect(paused.round).toBe(2);
  expect(paused.maxRounds).toBe(2);
  expect(rig.container.agents).toHaveLength(4);
  expect(await sessionPhase(rig)).toBe("stopped");

  scriptTurns(rig, say("draft 3"), changes);
  const resumed = rig.call("flow/decide", {
    runId,
    decision: "another_round",
  });
  await expect(resumed).resolves.toMatchObject({ status: "running" });
  const pausedAgain = await settled(async () => {
    const view = await flowRunOf(rig);
    expect(view.status).toBe("awaiting_decision");
    expect(view.round).toBe(3);
    return view;
  });
  expect(pausedAgain.decision?.reason).toBe("rounds_exhausted");
  expect(rig.container.agents).toHaveLength(6);

  await rig.call("flow/decide", { runId, decision: "stop" });
  const stopped = await untilStatus(rig, "stopped");

  expect(stopped.decision).toBeNull();
  expect(rig.container.agents).toHaveLength(6);
  expect(await sessionPhase(rig)).toBe("stopped");
});

it("flow_run_missing_verdict_pauses_for_approval", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, say("built"), say("Seems fine to me"));

  const { runId } = await startFlow(rig, "build-review");
  const paused = await untilStatus(rig, "awaiting_decision");

  expect(paused.decision).toEqual({
    reason: "missing_verdict",
    nodeId: "review",
  });

  await rig.call("flow/decide", { runId, decision: "approve" });
  const done = await untilStatus(rig, "done");

  expect(done.decision).toBeNull();
  expect(rig.container.agents).toHaveLength(2);
});

it("flow_run_gate_pauses_before_target", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, say("built"), say("reviewed"));

  const { runId } = await startFlow(rig, "gated");
  const paused = await untilStatus(rig, "awaiting_decision");

  expect(paused.decision).toEqual({ reason: "gate", nodeId: "review" });
  expect(nodeSummary(paused)).toEqual([
    ["build", "done", 1],
    ["review", "idle", 0],
  ]);
  expect(rig.container.agents).toHaveLength(1);
  await expect(
    rig.call("flow/decide", { runId, decision: "another_round" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });

  await rig.call("flow/decide", { runId, decision: "approve" });
  const done = await untilStatus(rig, "done");

  expect(nodeSummary(done)).toEqual([
    ["build", "done", 1],
    ["review", "done", 1],
  ]);
  expect(agentOf(rig, 1).prompts[0]).toContain("## Hand-off from build\nbuilt");
});

it("flow_run_gated_review_asks_before_rework", async () => {
  const rig = await openFlowRig();
  scriptTurns(
    rig,
    say("first draft"),
    say("Missing tests.\nVERDICT: CHANGES_REQUESTED"),
    say("added tests"),
    say("Good now.\nVERDICT: APPROVED"),
  );

  const { runId } = await startFlow(rig, "gated-review");
  const paused = await untilStatus(rig, "awaiting_decision");

  expect(paused.decision).toEqual({ reason: "gate", nodeId: "build" });
  expect(nodeSummary(paused)).toEqual([
    ["build", "queued", 1],
    ["review", "queued", 1],
  ]);
  expect(rig.container.agents).toHaveLength(2);

  await rig.call("flow/decide", { runId, decision: "approve" });
  const done = await untilStatus(rig, "done");

  expect(nodeSummary(done)).toEqual([
    ["build", "done", 2],
    ["review", "done", 2],
  ]);
  expect(rig.container.agents).toHaveLength(4);
  expect(agentOf(rig, 2).prompts[0]).toContain(
    "## Review findings from review\nMissing tests.",
  );
});

it("flow_run_gated_review_another_round_runs_build", async () => {
  const rig = await openFlowRig();
  const changes = say("Still wrong.\nVERDICT: CHANGES_REQUESTED");
  scriptTurns(rig, say("draft 1"), changes, say("draft 2"), changes);

  const { runId } = await startFlow(rig, "gated-review");
  await untilStatus(rig, "awaiting_decision");
  await rig.call("flow/decide", { runId, decision: "approve" });
  const exhausted = await settled(async () => {
    const view = await flowRunOf(rig);
    expect(view.decision?.reason).toBe("rounds_exhausted");
    return view;
  });

  expect(exhausted.round).toBe(2);

  scriptTurns(rig, say("draft 3"), say("Good.\nVERDICT: APPROVED"));
  await rig.call("flow/decide", { runId, decision: "another_round" });
  const done = await untilStatus(rig, "done");

  expect(nodeSummary(done)).toEqual([
    ["build", "done", 3],
    ["review", "done", 3],
  ]);
});

it("flow_run_foreign_gate_not_asked_on_other_rework", async () => {
  const rig = await openFlowRig();
  scriptTurns(
    rig,
    say("draft 1"),
    say("Fine.\nVERDICT: APPROVED"),
    say("Fix it.\nVERDICT: CHANGES_REQUESTED"),
    say("draft 2"),
    say("Fine.\nVERDICT: APPROVED"),
    say("Good.\nVERDICT: APPROVED"),
  );

  await startFlow(rig, "foreign-gate");
  const done = await untilStatus(rig, "done");

  expect(nodeSummary(done)).toEqual([
    ["build", "done", 2],
    ["r1", "done", 2],
    ["r2", "done", 2],
  ]);
});

it("flow_run_parallel_foreign_gate_not_asked", async () => {
  const rig = await openFlowRig();
  scriptTurns(
    rig,
    say("draft 1"),
    say("Fine.\nVERDICT: APPROVED"),
    say("Fix it.\nVERDICT: CHANGES_REQUESTED"),
    say("draft 2"),
    say("Good.\nVERDICT: APPROVED"),
  );

  await startFlow(rig, "parallel-gate");
  const done = await untilStatus(rig, "done");

  expect(nodeSummary(done)).toEqual([
    ["build", "done", 2],
    ["r1", "done", 1],
    ["r2", "done", 2],
  ]);
  expect(rig.container.agents).toHaveLength(5);
});

it("flow_run_node_start_failure_fails_flow", async () => {
  const rig = await openFlowRig({ accounts: [] });

  await startFlow(rig, "solo-codex");
  const failed = await untilStatus(rig, "failed");

  expect(failed.failure).toContain("No usable account");
  expect(nodeSummary(failed)).toEqual([["build", "failed", 1]]);
  expect(rig.container.agents).toHaveLength(0);
  expect(rig.codexContainer.servers).toHaveLength(0);
  expect(await sessionPhase(rig)).not.toBe("running");
});

it("flow_run_failed_turn_fails_flow_and_releases_slot", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, [{ type: "fail", code: -32603, message: "Agent crashed" }]);

  await startFlow(rig, "build-review");
  const failed = await untilStatus(rig, "failed");

  expect(failed.failure).toContain("Agent crashed");
  expect(nodeSummary(failed)).toEqual([
    ["build", "failed", 1],
    ["review", "idle", 0],
  ]);
  expect(rig.container.agents).toHaveLength(1);
  expect(await sessionPhase(rig)).toBe("stopped");
  await expect(
    rig.call("session/start", startParams(rig)),
  ).resolves.toMatchObject({ phase: { phase: "running" } });
});

it("flow_run_waits_through_rotation_before_handoff", async () => {
  const rig = await openFlowRig();
  scriptTurns(
    rig,
    [RATE_LIMIT_FAILURE],
    [HOLD_TURN, { type: "text", text: "Built after switching" }, END_TURN],
    say("Fine.\nVERDICT: APPROVED"),
  );

  await startFlow(rig, "ask-review");
  await untilTurnHeld(rig);

  const midway = await flowRunOf(rig);
  expect(midway.status).toBe("running");
  expect(midway.currentNodeId).toBe("build");
  expect(nodeSummary(midway)).toEqual([
    ["build", "running", 1],
    ["review", "idle", 0],
  ]);
  expect(rig.container.agents).toHaveLength(2);

  await answerHeldTurn(rig);
  const done = await untilStatus(rig, "done");

  expect(done.nodes[0]?.result).toBe("Built after switching");
  expect(rig.container.agents).toHaveLength(3);
  expect(agentOf(rig, 2).prompts[0]).toContain(
    "## Hand-off from build\nBuilt after switching",
  );
});

it("flow_run_waits_through_scheduled_resume_before_handoff", async () => {
  const rig = await openFlowRig({ accounts: [ACCOUNT_A] });
  scriptTurns(
    rig,
    [RATE_LIMIT_FAILURE],
    [HOLD_TURN, { type: "text", text: "Built after waiting" }, END_TURN],
    say("Fine.\nVERDICT: APPROVED"),
  );

  await startFlow(rig, "ask-review");
  await settled(async () => {
    expect((await rig.session()).phase.phase).toBe("waiting");
  });

  const waiting = await flowRunOf(rig);
  expect(waiting.status).toBe("running");
  expect(nodeSummary(waiting)).toEqual([
    ["build", "running", 1],
    ["review", "idle", 0],
  ]);
  expect(rig.container.agents).toHaveLength(1);

  rig.scheduled.at(-1)?.run();
  await untilTurnHeld(rig);

  expect(rig.container.agents).toHaveLength(2);
  expect((await flowRunOf(rig)).nodes[1]?.visits).toBe(0);

  await answerHeldTurn(rig);
  const done = await untilStatus(rig, "done");

  expect(done.nodes[0]?.result).toBe("Built after waiting");
  expect(rig.container.agents).toHaveLength(3);
});

it("flow_start_refused_while_session_live", async () => {
  const rig = await openFlowRig();
  await rig.call("session/start", startParams(rig));

  await expect(
    rig.call("flow/start", {
      cwd: rig.cwd,
      flowId: "build-review",
      task: TASK,
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });

  expect((await rig.call("sessions/snapshot", {})).flowRun).toBeNull();
});

it("session_start_refused_while_flow_runs", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, [HOLD_TURN, END_TURN]);
  await startFlow(rig, "ask-review");
  await untilTurnHeld(rig);

  await expect(
    rig.call("session/start", startParams(rig)),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is running",
  });
  await expect(
    rig.call("flow/start", { cwd: rig.cwd, flowId: "ask-review", task: TASK }),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
});

it("session_stop_stops_flow", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, [HOLD_TURN, END_TURN]);
  await startFlow(rig, "ask-review");
  await untilTurnHeld(rig);

  await expect(rig.call("session/stop", {})).resolves.toEqual({
    stopped: true,
  });

  const stopped = await untilStatus(rig, "stopped");
  expect(nodeSummary(stopped)).toEqual([
    ["build", "idle", 1],
    ["review", "idle", 0],
  ]);
  expect(await sessionPhase(rig)).toBe("stopped");
  expect(rig.container.agents).toHaveLength(1);
});

it("flow_run_shutdown_stops_active_node", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, [HOLD_TURN, END_TURN]);
  await startFlow(rig, "ask-review");
  await untilTurnHeld(rig);

  await rig.dispose();

  expect(rig.order).toContain("stop-confirmed:run-2");
  expect((rig.broadcastsOf("flow/changed").at(-1) as FlowRunView).status).toBe(
    "stopped",
  );
  expect(rig.container.agents).toHaveLength(1);
});

it("flow_start_rejects_empty_or_unknown_flow", async () => {
  const rig = await openFlowRig();

  await expect(
    rig.call("flow/start", { cwd: rig.cwd, flowId: "missing", task: TASK }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
  await expect(
    rig.call("flow/start", {
      cwd: rig.cwd,
      flowId: "broken-flow",
      task: TASK,
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: expect.stringContaining("nobody") as string,
  });
  await expect(
    rig.call("flow/start", {
      cwd: rig.cwd,
      flowId: "build-review",
      task: "   ",
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });

  expect((await rig.call("sessions/snapshot", {})).flowRun).toBeNull();
  expect(rig.container.agents).toHaveLength(0);
});

it("flow_run_review_reorders_reviewer_after_target", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, say("built first"), say("Fine.\nVERDICT: APPROVED"));

  await startFlow(rig, "reorder");
  const view = await untilStatus(rig, "done");

  expect(agentOf(rig, 0).prompts[0]).toContain("Node: build");
  expect(agentOf(rig, 1).prompts[0]).toContain("Node: review");
  expect(nodeSummary(view)).toEqual([
    ["review", "done", 1],
    ["build", "done", 1],
  ]);
});

function flowStartParams(
  rig: BackendRig,
  flowId: string,
): ParamsMap["flow/start"] {
  return { cwd: rig.cwd, flowId, task: TASK };
}

it("flow_stop_during_start_never_starts_a_node", async () => {
  const rig = await openFlowRig();

  const started = rig.call("flow/start", flowStartParams(rig, "build-review"));
  const refused = expect(started).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  await expect(rig.call("flow/stop", {})).resolves.toEqual({ stopped: true });
  await refused;

  expect(rig.container.agents).toHaveLength(0);
  expect((await rig.call("sessions/snapshot", {})).flowRun).toBeNull();
  expect(rig.broadcastsOf("flow/changed")).toHaveLength(0);
});

it("flow_shutdown_during_start_never_starts_a_node", async () => {
  const rig = await openFlowRig();

  const started = rig.call("flow/start", flowStartParams(rig, "build-review"));
  const refused = expect(started).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  await rig.dispose();
  await refused;

  expect(rig.container.agents).toHaveLength(0);
  expect(rig.broadcastsOf("flow/changed")).toHaveLength(0);
});

it("session_start_refused_until_stopped_flow_finishes", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await openFlowRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    worktreeGate: gate.promise,
  });
  await startFlow(rig, "build-review");
  await settled(async () => {
    expect(await sessionPhase(rig)).toBe("running");
  });

  const stopping = rig.call("flow/stop", {});
  await settled(async () => {
    expect(await sessionPhase(rig)).toBe("stopped");
  });
  await expect(
    rig.call("session/start", startParams(rig)),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  await expect(
    rig.call("flow/start", flowStartParams(rig, "build-review")),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  gate.resolve(undefined);
  await stopping;

  await rig.call("session/start", startParams(rig));
  expect((await rig.session()).phase.phase).toBe("running");
  expect((await flowRunOf(rig)).status).toBe("stopped");
});

it("flow_start_refused_while_session_starting", async () => {
  const rig = await openFlowRig();

  const manual = rig.call("session/start", startParams(rig));
  await expect(
    rig.call("flow/start", flowStartParams(rig, "build-review")),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  await manual;

  expect((await rig.call("sessions/snapshot", {})).flowRun).toBeNull();
});

it("flow_run_never_stops_manual_session", async () => {
  const rig = await openFlowRig();

  const manual = rig.call("session/start", startParams(rig));
  const refused = expect(
    rig.call("flow/start", flowStartParams(rig, "build-review")),
  ).rejects.toMatchObject({ code: IpcErrorCode.CONFLICT });
  await manual;
  await refused;

  expect((await rig.session()).phase.phase).toBe("running");
  expect(rig.container.agents).toHaveLength(1);
});

it("flow_run_with_prototype_named_node_ids", async () => {
  const rig = await openFlowRig();
  scriptTurns(rig, say("built"), say("Fine.\nVERDICT: APPROVED"));

  await startFlow(rig, "prototype-ids");
  const view = await untilStatus(rig, "done");

  expect(nodeSummary(view)).toEqual([
    ["constructor", "done", 1],
    ["__proto__", "done", 1],
  ]);
  expect(view.round).toBe(1);
  expect(view.failure).toBeNull();
});
