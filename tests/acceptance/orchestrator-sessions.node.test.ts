import {
  access,
  chmod,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { LockKeyResolver } from "../../src/backend/locks";
import { IpcErrorCode } from "../../src/shared/protocol";
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
  git,
  initFlowRepo,
  isolateGitEnv,
  postWithToken,
  removeFlowRepo,
  restoreEnv,
  toolEndpointOf,
  untilRunStatus,
  writeFlowFiles,
  type FlowRepo,
  type ToolClient,
  type ToolEndpoint,
  type ToolReply,
} from "../fakes/orchestratorHarness";
import { PROCESS_TEST_TIMEOUT_MS } from "../fakes/processHelpers";
import { resolvePathLockKey } from "../fakes/rigProcesses";
import { settled } from "../fakes/settle";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const HANGING_TURN: ScriptStep = { type: "hang" };
const HTTP_UNAUTHORIZED = 401;
const clients: ToolClient[] = [];
const tempDirs: string[] = [];
const flowRepos: FlowRepo[] = [];

beforeEach(() => {
  isolateGitEnv();
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await closeRigs();
  await Promise.all(flowRepos.splice(0).map(removeFlowRepo));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  restoreEnv();
});

async function openGitOrchestrated(): Promise<{
  rig: BackendRig;
  repo: string;
}> {
  const flowRepo = await createFlowRepo();
  flowRepos.push(flowRepo);
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
  });
  return { rig, repo: flowRepo.repo };
}

async function openOrchestrated(): Promise<BackendRig> {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  await writeFlowFiles(rig.cwd);
  return rig;
}

const BRANCH_CHANGE = "branch change\n";

async function doneWorktreeRun(
  rig: BackendRig,
  tools: ToolClient,
  repo: string,
): Promise<string> {
  rig.container.scriptNext([
    { type: "write_file", path: BASE_FILE, content: BRANCH_CHANGE },
    END_TURN,
  ]);
  const run = (await tools.json("start_flow", {
    cwd: repo,
    flowId: "solo",
    task: `${TASK} wt`,
    placement: "worktree",
  })) as { runId: string };
  await untilRunStatus(rig, run.runId, "done");
  return run.runId;
}

async function commitMainChange(repo: string): Promise<void> {
  await writeFile(join(repo, BASE_FILE), "main change\n");
  await git(repo, ["add", BASE_FILE]);
  await git(repo, ["commit", "--quiet", "-m", "Main conflict"]);
}

const MERGE_GATE_DRIVER = "codeweave-merge-gate";
const MERGE_GATE_WAIT_TICKS = 300;
const MERGE_GATE_WAIT_INTERVAL = "0.05";

interface MergeGate {
  entered(): Promise<void>;
  release(): Promise<void>;
}

function mergeGateScript(): string {
  return [
    "#!/bin/sh",
    'entered="$1"',
    'release="$2"',
    ': > "$entered"',
    "i=0",
    `while [ "$i" -lt ${String(MERGE_GATE_WAIT_TICKS)} ]; do`,
    '  if [ -f "$release" ]; then',
    "    exit 1",
    "  fi",
    `  sleep ${MERGE_GATE_WAIT_INTERVAL}`,
    "  i=$((i + 1))",
    "done",
    "exit 1",
    "",
  ].join("\n");
}

function shellPath(path: string): string {
  return `"${path.replaceAll("\\", "/")}"`;
}

async function holdMerge(repo: string, root: string): Promise<MergeGate> {
  const enteredFile = join(root, "merge-entered");
  const releaseFile = join(root, "merge-release");
  const script = join(root, "merge-gate.sh");
  await writeFile(script, mergeGateScript());
  await chmod(script, 0o755);
  await writeFile(
    join(repo, ".gitattributes"),
    `${BASE_FILE} merge=${MERGE_GATE_DRIVER}\n`,
  );
  await git(repo, ["add", ".gitattributes"]);
  await git(repo, ["commit", "--quiet", "-m", "Gate merges of the base file"]);
  await git(repo, [
    "config",
    `merge.${MERGE_GATE_DRIVER}.driver`,
    `${shellPath(script)} ${shellPath(enteredFile)} ${shellPath(releaseFile)}`,
  ]);
  return {
    entered: () =>
      settled(async () => {
        await access(enteredFile);
      }),
    release: () => writeFile(releaseFile, ""),
  };
}

async function startOrchestrator(
  rig: BackendRig,
  agentIndex: number,
  cwd: string = rig.cwd,
): Promise<{
  sessionId: string;
  endpoint: ToolEndpoint;
  tools: ToolClient;
}> {
  const view = await rig.call("session/start", {
    cwd,
    orchestrate: true,
  });
  const endpoint = toolEndpointOf(agentOf(rig, agentIndex));
  const tools = await connectTools(endpoint);
  clients.push(tools);
  return { sessionId: view.id, endpoint, tools };
}

it("two_orchestrations_run_concurrently", async () => {
  const rig = await openOrchestrated();

  const first = await startOrchestrator(rig, 0);
  const second = await startOrchestrator(rig, 1);

  const snapshot = await rig.call("sessions/snapshot", {});
  const sessions = (
    snapshot as unknown as {
      sessions: { id: string; phase: { phase: string } }[];
    }
  ).sessions;
  expect(sessions).toHaveLength(2);
  expect(sessions.map((s) => s.id)).toEqual([
    first.sessionId,
    second.sessionId,
  ]);
  expect(sessions.every((s) => s.phase.phase === "running")).toBe(true);
});

it("ending_one_orchestration_keeps_the_other_grant", async () => {
  const rig = await openOrchestrated();
  const first = await startOrchestrator(rig, 0);
  const second = await startOrchestrator(rig, 1);

  await rig.call("session/stop", { sessionId: first.sessionId });

  await settled(async () => {
    expect(await postWithToken(first.endpoint, first.endpoint.token)).toBe(
      HTTP_UNAUTHORIZED,
    );
  });
  const listed = (await second.tools.json("list_flows", {
    cwd: rig.cwd,
  })) as { flows: unknown[] };
  expect(listed.flows.length).toBeGreaterThan(0);
});

it("wakeup_reports_reach_their_own_session", async () => {
  const rig = await openOrchestrated();
  const secondCwd = await realpath(await mkdtemp(join(tmpdir(), "cw-orch2-")));
  tempDirs.push(secondCwd);
  await writeFlowFiles(secondCwd);
  const first = await startOrchestrator(rig, 0);
  const second = await startOrchestrator(rig, 1, secondCwd);

  agentOf(rig, 0).enqueue([END_TURN]);
  agentOf(rig, 1).enqueue([END_TURN]);

  const run1 = (await first.tools.json("start_flow", {
    cwd: rig.cwd,
    flowId: "solo",
    task: `${TASK} 1`,
    placement: "in_place",
  })) as { runId: string };
  const run2 = (await second.tools.json("start_flow", {
    cwd: secondCwd,
    flowId: "solo",
    task: `${TASK} 2`,
    placement: "in_place",
  })) as { runId: string };

  await untilRunStatus(rig, run1.runId, "done");
  await untilRunStatus(rig, run2.runId, "done");

  await settled(() => {
    expect(agentOf(rig, 0).prompts).toHaveLength(1);
    expect(agentOf(rig, 1).prompts).toHaveLength(1);
  });
  expect(agentOf(rig, 0).prompts[0]).toContain(run1.runId);
  expect(agentOf(rig, 0).prompts[0]).not.toContain(run2.runId);
  expect(agentOf(rig, 1).prompts[0]).toContain(run2.runId);
  expect(agentOf(rig, 1).prompts[0]).not.toContain(run1.runId);
});

it("shutdown_ends_all_orchestrations", async () => {
  const rig = await openOrchestrated();
  const secondCwd = await realpath(await mkdtemp(join(tmpdir(), "cw-orch2-")));
  tempDirs.push(secondCwd);
  await writeFlowFiles(secondCwd);
  const first = await startOrchestrator(rig, 0);
  const second = await startOrchestrator(rig, 1, secondCwd);

  rig.container.scriptNext([HANGING_TURN]);
  const run1 = (await first.tools.json("start_flow", {
    cwd: rig.cwd,
    flowId: "solo",
    task: `${TASK} 1`,
    placement: "in_place",
  })) as { runId: string };
  rig.container.scriptNext([HANGING_TURN]);
  const run2 = (await second.tools.json("start_flow", {
    cwd: secondCwd,
    flowId: "solo",
    task: `${TASK} 2`,
    placement: "in_place",
  })) as { runId: string };
  await untilRunStatus(rig, run1.runId, "running");
  await untilRunStatus(rig, run2.runId, "running");

  await rig.dispose();

  const runs = await rig.call("sessions/snapshot", {});
  expect(runs.flowRuns.find((r) => r.runId === run1.runId)?.status).toBe(
    "stopped",
  );
  expect(runs.flowRuns.find((r) => r.runId === run2.runId)?.status).toBe(
    "stopped",
  );
  await expect(
    postWithToken(first.endpoint, first.endpoint.token),
  ).rejects.toThrow();
  await expect(
    postWithToken(second.endpoint, second.endpoint.token),
  ).rejects.toThrow();
});

it("merge_blocked_while_other_orchestration_runs_in_place", async () => {
  const { rig, repo } = await openGitOrchestrated();
  const first = await startOrchestrator(rig, 0, repo);
  const second = await startOrchestrator(rig, 1, repo);

  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);

  await second.tools.json("start_flow", {
    cwd: repo,
    flowId: "solo",
    task: `${TASK} in-place`,
    placement: "in_place",
  });

  const reply = await first.tools.call("merge_flow", {
    runId: worktreeRun,
  });
  expect(reply.isError).toBe(true);
});

it("in_place_blocked_while_other_orchestration_merges", async () => {
  const { rig, repo } = await openGitOrchestrated();
  const first = await startOrchestrator(rig, 0, repo);
  const second = await startOrchestrator(rig, 1, repo);

  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);

  await commitMainChange(repo);

  const merged = (await first.tools.json("merge_flow", {
    runId: worktreeRun,
  })) as { status: string };
  expect(merged.status).toBe("conflict");

  const reply = await second.tools.call("start_flow", {
    cwd: repo,
    flowId: "solo",
    task: `${TASK} in-place`,
    placement: "in_place",
  });
  expect(reply.isError).toBe(true);
});

it("merge_conflicts_with_live_plain_session_in_same_repo", async () => {
  const { rig, repo } = await openGitOrchestrated();
  const first = await startOrchestrator(rig, 0, repo);

  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);

  await rig.call("session/start", { cwd: repo });

  const reply = await first.tools.call("merge_flow", {
    runId: worktreeRun,
  });
  expect(reply.isError).toBe(true);
});

it("merge_lease_released_after_abort", async () => {
  const { rig, repo } = await openGitOrchestrated();
  const first = await startOrchestrator(rig, 0, repo);

  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);

  await commitMainChange(repo);

  await first.tools.json("merge_flow", { runId: worktreeRun });
  const aborted = await first.tools.call("abort_merge", {
    runId: worktreeRun,
  });
  expect(aborted.isError).toBe(false);

  await expect(rig.call("session/start", { cwd: repo })).resolves.toMatchObject(
    {
      cwd: repo,
    },
  );
});

interface HeldMergeResolution {
  readonly resolver: LockKeyResolver;
  hold(): void;
  entered(): Promise<void>;
  release(): void;
}

function heldMergeResolution(repo: string): HeldMergeResolution {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let hold = false;
  return {
    resolver: async (cwd) => {
      if (hold && cwd === repo) {
        hold = false;
        entered.resolve(undefined);
        await release.promise;
      }
      return resolvePathLockKey(cwd);
    },
    hold: () => {
      hold = true;
    },
    entered: () => entered.promise,
    release: () => {
      release.resolve(undefined);
    },
  };
}

function expectMergeConflict(reply: ToolReply): void {
  expect(reply.isError).toBe(false);
  const outcome: unknown = JSON.parse(reply.text);
  expect(outcome).toMatchObject({ status: "conflict", files: [BASE_FILE] });
}

it("merge_lease_released_when_orchestration_ends_during_merge", async () => {
  const flowRepo = await createFlowRepo();
  flowRepos.push(flowRepo);
  const repo = flowRepo.repo;
  const gate = await holdMerge(repo, flowRepo.root);
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const first = await startOrchestrator(rig, 0, repo);
  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);
  await commitMainChange(repo);

  const merging = first.tools.call("merge_flow", { runId: worktreeRun });
  try {
    await gate.entered();
    await rig.call("session/stop", { sessionId: first.sessionId });
    await settled(async () => {
      expect(await postWithToken(first.endpoint, first.endpoint.token)).toBe(
        HTTP_UNAUTHORIZED,
      );
    });
  } finally {
    await gate.release();
  }
  expectMergeConflict(await merging);

  await expect(rig.call("session/start", { cwd: repo })).resolves.toMatchObject(
    {
      cwd: repo,
    },
  );
});

it("merge_lease_released_when_orchestration_ends_before_the_lease", async () => {
  const flowRepo = await createFlowRepo();
  flowRepos.push(flowRepo);
  const repo = flowRepo.repo;
  const gate = heldMergeResolution(repo);
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    resolveLockKey: gate.resolver,
  });
  const first = await startOrchestrator(rig, 0, repo);
  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);

  gate.hold();
  const merging = first.tools.call("merge_flow", { runId: worktreeRun });
  try {
    await gate.entered();
    await rig.call("session/stop", { sessionId: first.sessionId });
  } finally {
    gate.release();
  }
  expect(await merging).toEqual({
    text: "The orchestration has ended",
    isError: true,
  });

  await expect(rig.call("session/start", { cwd: repo })).resolves.toMatchObject(
    {
      cwd: repo,
    },
  );
});

it("merge_lease_uses_session_lock_key", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cw-case-")));
  tempDirs.push(root);
  const repo = join(root, "MixedCaseProject");
  await initFlowRepo(repo);
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    platform: "darwin",
  });
  const first = await startOrchestrator(rig, 0, repo);
  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);

  const plain = await rig.call("session/start", { cwd: repo });
  const refused = await first.tools.call("merge_flow", {
    runId: worktreeRun,
  });
  expect(refused.isError).toBe(true);

  await rig.call("session/stop", { sessionId: plain.id });
  await commitMainChange(repo);
  const merged = (await first.tools.json("merge_flow", {
    runId: worktreeRun,
  })) as { status: string };
  expect(merged.status).toBe("conflict");

  await expect(rig.call("session/start", { cwd: repo })).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
  });
});

it("abort_merge_keeps_lease_when_abort_fails", async () => {
  const { rig, repo } = await openGitOrchestrated();
  const first = await startOrchestrator(rig, 0, repo);
  const worktreeRun = await doneWorktreeRun(rig, first.tools, repo);
  await commitMainChange(repo);
  await first.tools.json("merge_flow", { runId: worktreeRun });
  await rm(join(repo, ".git", "MERGE_HEAD"));

  const aborted = await first.tools.call("abort_merge", {
    runId: worktreeRun,
  });
  expect(aborted.isError).toBe(true);

  await expect(rig.call("session/start", { cwd: repo })).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
  });
});

it("settle_ended_keeps_failed_session_failure", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const plain = await rig.call("session/start", { cwd: rig.cwd });
  const failedPhase = {
    phase: "failed",
    reason: "Agent process exited",
    runningAccountId: ACCOUNT_A.id,
  };
  rig.container.contained[0]?.emitExit(1);
  await settled(async () => {
    expect((await rig.session()).phase).toEqual(failedPhase);
  });

  await startOrchestrator(rig, 1);

  const sessions = (await rig.call("sessions/snapshot", {})).sessions;
  expect(sessions.find((session) => session.id === plain.id)?.phase).toEqual(
    failedPhase,
  );
});
