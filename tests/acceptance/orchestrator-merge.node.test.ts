import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FlowRunViewSchema, type FlowRunView } from "../../src/shared/views";
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
  isolateGitEnv,
  removeFlowRepo,
  restoreEnv,
  toolEndpointOf,
  untilAgents,
  untilRunStatus,
  type FlowRepo,
  type ToolClient,
} from "../fakes/orchestratorHarness";
import { settled } from "../fakes/settle";
import { PROCESS_TEST_TIMEOUT_MS } from "../fakes/processHelpers";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const COMMIT_SUBJECT = "Apply solo flow changes";
const WAKEUP_PREFIX = "[Codeweave]";

interface Session {
  readonly rig: BackendRig;
  readonly flowRepo: FlowRepo;
  readonly tools: ToolClient;
}

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

async function openSession(): Promise<Session> {
  const flowRepo = await createFlowRepo();
  repos.push(flowRepo);
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  await rig.call("session/start", { cwd: flowRepo.repo, orchestrate: true });
  const tools = await connectTools(toolEndpointOf(agentOf(rig)));
  clients.push(tools);
  return { rig, flowRepo, tools };
}

function writeBase(content: string): readonly ScriptStep[] {
  return [{ type: "write_file", path: BASE_FILE, content }, END_TURN];
}

async function startWorktree(tools: ToolClient): Promise<FlowRunView> {
  return FlowRunViewSchema.parse(
    await tools.json("start_flow", {
      flowId: "solo",
      task: TASK,
      placement: "worktree",
    }),
  );
}

async function branchSubjects(repo: string, branch: string): Promise<string> {
  return git(repo, ["log", "--format=%s", branch]);
}

async function untilCommitted(repo: string, branch: string): Promise<void> {
  await settled(async () => {
    expect(await branchSubjects(repo, branch)).toContain(COMMIT_SUBJECT);
  });
}

async function runTwoWorktreeFlows(
  session: Session,
): Promise<readonly [FlowRunView, FlowRunView]> {
  const { rig, tools } = session;
  const releaseFirst = Promise.withResolvers<undefined>();
  rig.container.scriptNext([
    { type: "gate", until: releaseFirst.promise },
    ...writeBase("flow one\n"),
  ]);
  const first = await startWorktree(tools);
  await untilAgents(rig, 2);
  rig.container.scriptNext(writeBase("flow two\n"));
  const second = await startWorktree(tools);
  await untilRunStatus(rig, second.runId, "done");
  expect((await untilRunStatus(rig, first.runId, "running")).status).toBe(
    "running",
  );
  releaseFirst.resolve(undefined);
  await untilRunStatus(rig, first.runId, "done");
  return [first, second];
}

async function mergedBranches(repo: string): Promise<string> {
  return git(repo, ["branch", "--list", "codeweave/*"]);
}

it("two_worktree_flows_run_in_parallel_and_each_done_run_is_committed_before_its_report", async () => {
  const session = await openSession();
  const { flowRepo, rig } = session;

  const [first, second] = await runTwoWorktreeFlows(session);

  expect(first.placement).toBe("worktree");
  expect(first.branch).toBe(`codeweave/${first.runId}`);
  expect(first.cwd).not.toBe(flowRepo.repo);
  expect(second.cwd).not.toBe(first.cwd);
  await settled(() => {
    const reports = agentOf(rig).prompts.join("\n");
    expect(reports).toContain(first.runId);
    expect(reports).toContain(second.runId);
  });
  expect(
    await branchSubjects(flowRepo.repo, `codeweave/${first.runId}`),
  ).toContain(COMMIT_SUBJECT);
  expect(
    await branchSubjects(flowRepo.repo, `codeweave/${second.runId}`),
  ).toContain(COMMIT_SUBJECT);
  expect(await readFile(join(first.cwd, BASE_FILE), "utf8")).toBe("flow one\n");
  expect(await readFile(join(flowRepo.repo, BASE_FILE), "utf8")).toBe("one\n");
});

it("two_runs_ending_together_are_coalesced_into_one_codeweave_prompt", async () => {
  const session = await openSession();
  const { rig, tools, flowRepo } = session;
  const release = Promise.withResolvers<undefined>();
  agentOf(rig).enqueue([{ type: "gate", until: release.promise }, END_TURN]);
  await rig.call("session/prompt", { text: "go" });
  rig.container.scriptNext(writeBase("flow one\n"));
  const first = await startWorktree(tools);
  await untilAgents(rig, 2);
  rig.container.scriptNext(writeBase("flow two\n"));
  const second = await startWorktree(tools);
  await untilRunStatus(rig, first.runId, "done");
  await untilRunStatus(rig, second.runId, "done");
  await untilCommitted(flowRepo.repo, `codeweave/${first.runId}`);
  await untilCommitted(flowRepo.repo, `codeweave/${second.runId}`);

  expect(agentOf(rig).prompts).toHaveLength(1);
  release.resolve(undefined);
  await settled(() => {
    expect(agentOf(rig).prompts).toHaveLength(2);
  });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(false);
  });

  const wakeup = agentOf(rig).prompts[1] ?? "";
  expect(wakeup.startsWith(WAKEUP_PREFIX)).toBe(true);
  expect(wakeup).toContain(first.runId);
  expect(wakeup).toContain(second.runId);
  expect(agentOf(rig).prompts).toHaveLength(2);
});

it("merge_flow_merges_the_first_run_reports_the_second_conflict_and_finish_merge_commits_the_in_place_fix", async () => {
  const session = await openSession();
  const { rig, tools, flowRepo } = session;
  const { repo } = flowRepo;
  const [first, second] = await runTwoWorktreeFlows(session);
  await untilCommitted(repo, `codeweave/${first.runId}`);
  await untilCommitted(repo, `codeweave/${second.runId}`);

  const merged = await tools.json("merge_flow", { runId: first.runId });
  const conflict = await tools.json("merge_flow", { runId: second.runId });

  expect(merged).toMatchObject({ status: "merged" });
  expect(existsSync(first.cwd)).toBe(false);
  expect(await mergedBranches(repo)).not.toContain(first.runId);
  expect(conflict).toEqual({ status: "conflict", files: [BASE_FILE] });
  expect(existsSync(second.cwd)).toBe(true);

  const releaseFix = Promise.withResolvers<undefined>();
  rig.container.scriptNext([
    { type: "gate", until: releaseFix.promise },
    ...writeBase("resolved\n"),
  ]);
  const fix = FlowRunViewSchema.parse(
    await tools.json("start_flow", { flowId: "solo", task: TASK }),
  );
  await untilRunStatus(rig, fix.runId, "running");
  const refusedAbort = await tools.call("abort_merge", { runId: second.runId });
  const refusedWorktree = await tools.call("start_flow", {
    flowId: "solo",
    task: TASK,
    placement: "worktree",
  });

  expect(refusedAbort).toEqual({
    text: "An in-place flow is still running",
    isError: true,
  });
  expect(refusedWorktree).toEqual({
    text: "A merge is in progress",
    isError: true,
  });
  releaseFix.resolve(undefined);
  await untilRunStatus(rig, fix.runId, "done");
  const finished = await tools.json("finish_merge", { runId: second.runId });

  expect(finished).toMatchObject({ status: "merged" });
  expect(await readFile(join(repo, BASE_FILE), "utf8")).toBe("resolved\n");
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  expect(await git(repo, ["log", "--format=%s", "-1"])).toBe(
    `Merge codeweave/${second.runId}\n`,
  );
  expect(existsSync(second.cwd)).toBe(false);
  expect(await mergedBranches(repo)).toBe("");
});

it("two_merge_flow_calls_at_once_merge_one_and_refuse_the_other", async () => {
  const session = await openSession();
  const { tools, flowRepo } = session;
  const { repo } = flowRepo;
  const [first, second] = await runTwoWorktreeFlows(session);
  await untilCommitted(repo, `codeweave/${first.runId}`);
  await untilCommitted(repo, `codeweave/${second.runId}`);

  const replies = await Promise.all([
    tools.call("merge_flow", { runId: first.runId }),
    tools.call("merge_flow", { runId: second.runId }),
  ]);

  const refused = replies.filter((reply) => reply.isError);
  const merged = replies.filter((reply) => !reply.isError);
  expect(refused).toEqual([
    { text: "Another merge is in progress", isError: true },
  ]);
  expect(merged).toHaveLength(1);
  expect(JSON.parse(merged[0]?.text ?? "")).toMatchObject({
    status: "merged",
  });
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  expect(await mergedBranches(repo)).toContain("codeweave/");
});

it("merge_flow_is_refused_while_an_in_place_flow_runs", async () => {
  const { rig, tools, flowRepo } = await openSession();
  const { repo } = flowRepo;
  rig.container.scriptNext(writeBase("flow one\n"));
  const worktreeRun = await startWorktree(tools);
  await untilRunStatus(rig, worktreeRun.runId, "done");
  await untilCommitted(repo, `codeweave/${worktreeRun.runId}`);
  const release = Promise.withResolvers<undefined>();
  rig.container.scriptNext([
    { type: "gate", until: release.promise },
    ...writeBase("in place\n"),
  ]);
  const inPlace = FlowRunViewSchema.parse(
    await tools.json("start_flow", { flowId: "solo", task: TASK }),
  );
  await untilRunStatus(rig, inPlace.runId, "running");

  const refused = await tools.call("merge_flow", { runId: worktreeRun.runId });

  expect(refused).toEqual({
    text: "An in-place flow is still running",
    isError: true,
  });
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  expect(await readFile(join(repo, BASE_FILE), "utf8")).toBe("one\n");
  expect(existsSync(worktreeRun.cwd)).toBe(true);
  release.resolve(undefined);
  await untilRunStatus(rig, inPlace.runId, "done");
});

it("a_worktree_start_on_a_dirty_project_is_refused_and_a_failed_start_removes_the_worktree", async () => {
  const { tools, flowRepo } = await openSession();
  const { repo, root } = flowRepo;
  await writeFile(join(repo, "scratch.txt"), "dirty\n");

  const dirty = await tools.call("start_flow", {
    flowId: "solo",
    task: TASK,
    placement: "worktree",
  });

  expect(dirty).toEqual({
    text: "The project has uncommitted changes",
    isError: true,
  });
  expect(existsSync(join(root, ".worktrees"))).toBe(false);
  expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(
    "codeweave/",
  );

  await rm(join(repo, "scratch.txt"));
  const failed = await tools.call("start_flow", {
    flowId: "missing",
    task: TASK,
    placement: "worktree",
  });

  expect(failed).toEqual({ text: 'Unknown flow "missing"', isError: true });
  expect(await mergedBranches(repo)).toBe("");
  expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(
    "codeweave/",
  );
});
