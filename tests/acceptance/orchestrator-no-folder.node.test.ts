import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { inspectWorktree } from "../../src/backend/worktree";
import {
  FlowRunViewSchema,
  FlowsListSchema,
  type FlowsList,
  type FlowRunView,
} from "../../src/shared/views";
import {
  ACCOUNT_A,
  agentOf,
  closeRigs,
  openRig,
  type BackendRig,
  type BackendRigOptions,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import {
  BASE_FILE,
  LIBRARY_FLOW_ID,
  TASK,
  connectTools,
  createWorkspaceRepos,
  git,
  initFlowRepo,
  isolateGitEnv,
  removeFlowRepo,
  restoreEnv,
  toolEndpointOf,
  untilRunStatus,
  type ToolClient,
  type WorkspaceRepos,
} from "../fakes/orchestratorHarness";
import { settled } from "../fakes/settle";
import { PROCESS_TEST_TIMEOUT_MS } from "../fakes/processHelpers";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const COMMIT_SUBJECT = "Apply solo flow changes";
const SUBFOLDER = "packages";

interface NoFolder {
  readonly rig: BackendRig;
  readonly tools: ToolClient;
  readonly space: WorkspaceRepos;
}

const spaces: WorkspaceRepos[] = [];
const clients: ToolClient[] = [];

beforeEach(() => {
  isolateGitEnv();
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await closeRigs();
  await Promise.all(spaces.splice(0).map(removeFlowRepo));
  restoreEnv();
});

async function openNoFolder(
  names: readonly string[],
  options: {
    readonly workspace?: (space: WorkspaceRepos) => string;
    readonly rig?: Partial<BackendRigOptions>;
    readonly prepare?: (space: WorkspaceRepos) => Promise<void>;
  } = {},
): Promise<NoFolder> {
  const space = await createWorkspaceRepos(names);
  spaces.push(space);
  await options.prepare?.(space);
  const rig = await openRig({
    accounts: [ACCOUNT_A],
    homeDir: space.root,
    platform: process.platform,
    inspectWorktree,
    ...options.rig,
  });
  const settings = await rig.store.readSettings();
  await rig.store.writeSettings({
    ...settings,
    defaultWorkspace: options.workspace?.(space) ?? space.workspace,
    definitionLibrary: space.library,
  });
  await rig.call("session/start", { orchestrate: true });
  const tools = await connectTools(toolEndpointOf(agentOf(rig)));
  clients.push(tools);
  return { rig, tools, space };
}

function writeBase(content: string): readonly ScriptStep[] {
  return [{ type: "write_file", path: BASE_FILE, content }, END_TURN];
}

function parseRun(value: unknown): FlowRunView {
  return FlowRunViewSchema.parse(value);
}

function startArgs(
  repository: string | undefined,
  placement: "in_place" | "worktree" = "in_place",
): Record<string, unknown> {
  return {
    flowId: "solo",
    task: TASK,
    placement,
    ...(repository === undefined ? {} : { repository }),
  };
}

async function startRun(
  tools: ToolClient,
  repository: string | undefined,
  placement: "in_place" | "worktree" = "in_place",
): Promise<FlowRunView> {
  return parseRun(
    await tools.json("start_flow", startArgs(repository, placement)),
  );
}

async function untilCommitted(repo: string, branch: string): Promise<void> {
  await settled(async () => {
    expect(await git(repo, ["log", "--format=%s", branch])).toContain(
      COMMIT_SUBJECT,
    );
  });
}

async function listed(
  tools: ToolClient,
  repository?: string,
): Promise<FlowsList> {
  return FlowsListSchema.parse(
    await tools.json(
      "list_flows",
      repository === undefined ? {} : { repository },
    ),
  );
}

function flowIds(list: FlowsList): string[] {
  return list.flows.map((flow) => flow.id).toSorted();
}

it("list_flows_without_repository_lists_from_non_git_default_workspace_and_library", async () => {
  const { tools, space } = await openNoFolder(["alpha", "beta"]);

  const list = await listed(tools);

  expect(list.locations.project).toBe(space.workspace);
  expect(flowIds(list)).toEqual([LIBRARY_FLOW_ID]);
});

it("list_flows_with_repository_returns_repo_and_library_definitions_for_relative_tilde_and_absolute_paths", async () => {
  const { tools, space } = await openNoFolder(["alpha", "beta"]);
  const beta = space.repos.beta ?? "";

  const lists = await Promise.all([
    listed(tools, "beta"),
    listed(tools, "./beta/"),
    listed(tools, "~/workspace/beta"),
    listed(tools, beta),
  ]);

  for (const list of lists) {
    expect(list.locations.project).toBe(beta);
    expect(flowIds(list)).toEqual(["gated", LIBRARY_FLOW_ID, "solo"]);
  }
});

it("start_flow_in_place_runs_and_diffs_in_the_named_repository_using_its_definitions_and_library", async () => {
  const { rig, tools, space } = await openNoFolder(["alpha", "beta"]);
  const beta = space.repos.beta ?? "";
  const alpha = space.repos.alpha ?? "";
  rig.container.scriptNext(writeBase("in beta\n"));

  const started = await startRun(tools, "beta");
  await untilRunStatus(rig, started.runId, "done");
  const diff = await tools.call("flow_diff", { runId: started.runId });

  expect(started.cwd).toBe(beta);
  expect(await readFile(join(beta, BASE_FILE), "utf8")).toBe("in beta\n");
  expect(await readFile(join(alpha, BASE_FILE), "utf8")).toBe("one\n");
  expect(diff.isError).toBe(false);
  expect(diff.text).toContain("+in beta");
  expect(await git(alpha, ["status", "--porcelain"])).toBe("");
  const library = parseRun(
    await tools.json("start_flow", {
      flowId: LIBRARY_FLOW_ID,
      task: TASK,
      repository: "alpha",
    }),
  );
  expect(library.cwd).toBe(alpha);
  expect(library.flowId).toBe(LIBRARY_FLOW_ID);
});

it("start_flow_worktree_creates_worktree_from_the_named_repository_commits_diffs_and_merges_into_it", async () => {
  const { rig, tools, space } = await openNoFolder(["alpha", "beta"]);
  const beta = space.repos.beta ?? "";
  const alpha = space.repos.alpha ?? "";
  rig.container.scriptNext(writeBase("worktree change\n"));

  const started = await startRun(tools, "beta", "worktree");
  await untilRunStatus(rig, started.runId, "done");
  await untilCommitted(beta, `codeweave/${started.runId}`);
  const diff = await tools.call("flow_diff", { runId: started.runId });
  const merged = await tools.json("merge_flow", { runId: started.runId });

  expect(started.cwd.startsWith(join(space.workspace, ".worktrees"))).toBe(
    true,
  );
  expect(started.branch).toBe(`codeweave/${started.runId}`);
  expect(diff.text).toContain("+worktree change");
  expect(merged).toMatchObject({ status: "merged" });
  expect(await readFile(join(beta, BASE_FILE), "utf8")).toBe(
    "worktree change\n",
  );
  expect(existsSync(started.cwd)).toBe(false);
  expect(await readFile(join(alpha, BASE_FILE), "utf8")).toBe("one\n");
  expect(await git(alpha, ["worktree", "list", "--porcelain"])).not.toContain(
    "codeweave/",
  );
});

it("subfolder_repository_normalizes_to_its_git_toplevel_for_list_start_and_exclusivity", async () => {
  const { rig, tools, space } = await openNoFolder(["alpha", "beta"], {
    prepare: async ({ repos }) => {
      const alpha = repos.alpha ?? "";
      await mkdir(join(alpha, SUBFOLDER));
      await writeFile(join(alpha, SUBFOLDER, "index.txt"), "x\n");
      await git(alpha, ["add", "-A"]);
      await git(alpha, ["commit", "--quiet", "-m", "Add packages"]);
    },
  });
  const alpha = space.repos.alpha ?? "";
  const release = Promise.withResolvers<undefined>();
  rig.container.scriptNext([
    { type: "gate", until: release.promise },
    ...writeBase("sub\n"),
  ]);

  const list = await listed(tools, `alpha/${SUBFOLDER}`);
  const started = await startRun(tools, `alpha/${SUBFOLDER}`);
  await untilRunStatus(rig, started.runId, "running");
  const sameRepo = await tools.call("start_flow", startArgs("alpha"));

  expect(list.locations.project).toBe(alpha);
  expect(started.cwd).toBe(alpha);
  expect(sameRepo).toEqual({
    text: "An in-place flow is already running",
    isError: true,
  });
  release.resolve(undefined);
  await untilRunStatus(rig, started.runId, "done");
});

it("two_in_place_runs_in_different_repositories_run_concurrently_while_same_repository_is_rejected", async () => {
  const { rig, tools } = await openNoFolder(["alpha", "beta"]);
  const release = Promise.withResolvers<undefined>();
  rig.container.scriptNext([
    { type: "gate", until: release.promise },
    ...writeBase("alpha\n"),
  ]);
  rig.container.scriptNext([
    { type: "gate", until: release.promise },
    ...writeBase("beta\n"),
  ]);

  const first = await startRun(tools, "alpha");
  const second = await startRun(tools, "beta");
  const sameAlpha = await tools.call("start_flow", startArgs("alpha"));
  const sameBeta = await tools.call("start_flow", startArgs("./beta"));

  expect(first.cwd).not.toBe(second.cwd);
  expect(sameAlpha.isError).toBe(true);
  expect(sameBeta.isError).toBe(true);
  expect(sameAlpha.text).toBe("An in-place flow is already running");
  release.resolve(undefined);
  await untilRunStatus(rig, first.runId, "done");
  await untilRunStatus(rig, second.runId, "done");
});

it("merge_conflict_in_one_repository_does_not_block_in_place_worktree_or_merge_in_another_repository", async () => {
  const { rig, tools, space } = await openNoFolder(["alpha", "beta"]);
  const alpha = space.repos.alpha ?? "";
  const beta = space.repos.beta ?? "";
  rig.container.scriptNext(writeBase("alpha one\n"));
  const first = await startRun(tools, "alpha", "worktree");
  await untilRunStatus(rig, first.runId, "done");
  rig.container.scriptNext(writeBase("alpha two\n"));
  const second = await startRun(tools, "alpha", "worktree");
  await untilRunStatus(rig, second.runId, "done");
  rig.container.scriptNext(writeBase("beta one\n"));
  const betaRun = await startRun(tools, "beta", "worktree");
  await untilRunStatus(rig, betaRun.runId, "done");
  for (const [repo, run] of [
    [alpha, first],
    [alpha, second],
    [beta, betaRun],
  ] as const) {
    await untilCommitted(repo, `codeweave/${run.runId}`);
  }
  await tools.json("merge_flow", { runId: first.runId });
  const conflict = await tools.json("merge_flow", { runId: second.runId });
  expect(conflict).toMatchObject({ status: "conflict" });

  const merged = await tools.json("merge_flow", { runId: betaRun.runId });
  rig.container.scriptNext(writeBase("beta two\n"));
  const betaWorktree = await startRun(tools, "beta", "worktree");
  await untilRunStatus(rig, betaWorktree.runId, "done");
  const alphaWorktree = await tools.call(
    "start_flow",
    startArgs("alpha", "worktree"),
  );
  rig.container.scriptNext(writeBase("beta in place\n"));
  const betaInPlace = await startRun(tools, "beta");
  await untilRunStatus(rig, betaInPlace.runId, "done");

  expect(merged).toMatchObject({ status: "merged" });
  expect(betaWorktree.branch).toBe(`codeweave/${betaWorktree.runId}`);
  expect(alphaWorktree).toEqual({
    text: "A merge is in progress",
    isError: true,
  });
  expect(await readFile(join(beta, BASE_FILE), "utf8")).toBe("beta in place\n");
});

it("rejects_repository_outside_root_symlink_escape_protected_path_and_non_git_directory_with_validation_error", async () => {
  const { tools, space } = await openNoFolder(["alpha"], {
    prepare: async ({ root, workspace }) => {
      await initFlowRepo(join(root, "outside-repo"));
      await mkdir(join(root, ".ssh"));
      await mkdir(join(workspace, "plain"));
      await writeFile(join(workspace, "file.txt"), "x\n");
      await symlink(
        join(root, "outside-repo"),
        join(workspace, "escape"),
        "dir",
      );
    },
  });
  const outside = join(space.root, "outside-repo");

  const outsideMessage = "The repository is outside the session folder";
  const invalidMessage = "The repository must be a path to a git repository";
  const notGit = "Not a git repository";
  const expected: readonly (readonly [string, string])[] = [
    ["../outside-repo", outsideMessage],
    [outside, outsideMessage],
    ["escape", outsideMessage],
    ["~/.ssh", "The repository is a protected location"],
    ["plain", notGit],
    ["missing", notGit],
    ["file.txt", notGit],
    ["$HOME/alpha", invalidMessage],
    ["~other/alpha", invalidMessage],
    ["   ", invalidMessage],
  ];

  for (const [repository, message] of expected) {
    const list = await tools.call("list_flows", { repository });
    const start = await tools.call("start_flow", startArgs(repository));
    expect(list.isError, repository).toBe(true);
    expect(list.text, repository).toContain(message);
    expect(start.isError, repository).toBe(true);
    expect(start.text, repository).toContain(message);
  }
});

it("session_started_in_repo_subfolder_allows_repository_at_git_toplevel_permission_root", async () => {
  const { tools, space } = await openNoFolder(["alpha"], {
    prepare: async ({ repos }) => {
      const alpha = repos.alpha ?? "";
      await mkdir(join(alpha, SUBFOLDER));
      await writeFile(join(alpha, SUBFOLDER, "index.txt"), "x\n");
      await git(alpha, ["add", "-A"]);
      await git(alpha, ["commit", "--quiet", "-m", "Add packages"]);
    },
    workspace: ({ repos }) => join(repos.alpha ?? "", SUBFOLDER),
  });
  const alpha = space.repos.alpha ?? "";

  const list = await listed(tools, alpha);
  const sibling = await tools.call("list_flows", {
    repository: join(space.workspace, "missing"),
  });

  expect(list.locations.project).toBe(alpha);
  expect(sibling.isError).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "worktree-destination-symlink-rejected",
  async () => {
    const { tools, space } = await openNoFolder(["alpha"], {
      prepare: async ({ root }) => {
        await mkdir(join(root, ".ssh"));
        await mkdir(join(root, "outside"));
      },
    });
    const alpha = space.repos.alpha ?? "";
    const destination = join(space.workspace, ".worktrees");
    const message =
      "The worktree destination is a symlink or a protected location";

    for (const name of [".ssh", "outside"]) {
      const target = join(space.root, name);
      await symlink(target, destination, "dir");
      const start = await tools.call(
        "start_flow",
        startArgs("alpha", "worktree"),
      );
      await rm(destination);

      expect(start.isError, name).toBe(true);
      expect(start.text, name).toContain(message);
      expect(await readdir(target), name).toEqual([]);
      expect(
        await git(alpha, ["worktree", "list", "--porcelain"]),
        name,
      ).not.toContain("codeweave/");
      expect(await git(alpha, ["branch", "--list", "codeweave/*"]), name).toBe(
        "",
      );
    }
  },
);
