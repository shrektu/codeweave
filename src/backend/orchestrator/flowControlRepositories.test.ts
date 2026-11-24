import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FlowRunStatus } from "../../domain/flowRun";
import { FlowPlacement } from "../../domain/types";
import { IpcErrorCode } from "../../shared/protocol";
import { SAMPLE_FLOWS } from "../../../tests/fakes/fakeFlowControl";
import {
  CONFLICTED,
  FakeRuns,
  FakeWorktrees,
  MERGED,
  repositoryDeps,
} from "../../../tests/fakes/fakeOrchestration";
import type { FlowControl } from "../flowTools/control";

import {
  createOrchestratorFlowControl,
  type Orchestration,
} from "./flowControl";

const IN_PLACE = { flowId: "review", task: "Fix it" };
const WORKTREE = { ...IN_PLACE, placement: FlowPlacement.worktree };

function inPlaceIn(repository?: string): {
  readonly flowId: string;
  readonly task: string;
  readonly placement: FlowPlacement;
  readonly repository?: string;
} {
  return {
    ...IN_PLACE,
    placement: FlowPlacement.inPlace,
    ...(repository === undefined ? {} : { repository }),
  };
}

function worktreeIn(repository: string): ReturnType<typeof inPlaceIn> {
  return { ...WORKTREE, repository };
}

interface Rig {
  readonly control: FlowControl;
  readonly runs: FakeRuns;
  readonly worktrees: FakeWorktrees;
  readonly orchestration: Orchestration;
  readonly listed: (string | undefined)[];
  readonly inspect: ReturnType<typeof vi.fn<(cwd: string) => void>>;
  readonly space: string;
  readonly alpha: string;
  readonly beta: string;
}

const spaces: string[] = [];

async function makeSpace(): Promise<Pick<Rig, "space" | "alpha" | "beta">> {
  const space = await realpath(await mkdtemp(join(tmpdir(), "cw-repos-")));
  spaces.push(space);
  const alpha = join(space, "alpha");
  const beta = join(space, "beta");
  await mkdir(join(alpha, "sub"), { recursive: true });
  await mkdir(beta);
  return { space, alpha, beta };
}

async function openRig(
  options: {
    readonly cwd?: (space: string) => string;
    readonly repoRoot?: (space: string) => string;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<Rig> {
  const { space, alpha, beta } = await makeSpace();
  let counter = 0;
  const runs = new FakeRuns();
  const worktrees = new FakeWorktrees();
  const listed: (string | undefined)[] = [];
  const orchestration: Orchestration = {
    cwd: options.cwd?.(space) ?? space,
    explicitFolder: true,
    runs: new Map(),
    sessionId: "orchestrator-session",
    ended: false,
  };
  const base = repositoryDeps();
  const inspect = vi.fn<(cwd: string) => void>();
  const control = createOrchestratorFlowControl(
    {
      ...base,
      platform: options.platform ?? process.platform,
      inspectWorktree: (dir) => {
        inspect(dir);
        return options.repoRoot === undefined
          ? base.inspectWorktree(dir)
          : Promise.resolve({
              isRepo: true,
              root: options.repoRoot(space),
              porcelain: "",
              diffStat: "",
            });
      },
      flowRuns: runs,
      flowWorktrees: worktrees,
      listFlows: (dir) => {
        listed.push(dir);
        return Promise.resolve(SAMPLE_FLOWS);
      },
      newRunId: () => {
        counter += 1;
        return `run-${String(counter)}`;
      },
    },
    orchestration,
  );
  return {
    control,
    runs,
    worktrees,
    orchestration,
    listed,
    inspect,
    space,
    alpha,
    beta,
  };
}

async function doneWorktreeRun(rig: Rig, repository: string): Promise<string> {
  const { runId } = await rig.control.startFlow(worktreeIn(repository));
  rig.runs.finish(runId, FlowRunStatus.done);
  return runId;
}

const IN_PLACE_RUNNING = {
  code: IpcErrorCode.CONFLICT,
  message: "An in-place flow is already running",
};
const MERGE_IN_PROGRESS = {
  code: IpcErrorCode.CONFLICT,
  message: "A merge is in progress",
};
const MERGE_STEP = {
  code: IpcErrorCode.CONFLICT,
  message: "A merge step is running",
};
const IN_PLACE_STILL_RUNNING = {
  code: IpcErrorCode.CONFLICT,
  message: "An in-place flow is still running",
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    spaces
      .splice(0)
      .map((space) => rm(space, { recursive: true, force: true })),
  );
});

it("allows_in_place_runs_in_different_repos_and_blocks_the_same_repo", async () => {
  const rig = await openRig();

  const first = await rig.control.startFlow(inPlaceIn("alpha"));
  const second = await rig.control.startFlow(inPlaceIn("beta"));

  expect(first.runId).toBe("run-1");
  expect(second.runId).toBe("run-2");
  expect(rig.runs.started.map((request) => request.cwd)).toEqual([
    rig.alpha,
    rig.beta,
  ]);
  await expect(rig.control.startFlow(inPlaceIn("alpha"))).rejects.toMatchObject(
    IN_PLACE_RUNNING,
  );
  await expect(
    rig.control.startFlow(inPlaceIn("./beta/")),
  ).rejects.toMatchObject(IN_PLACE_RUNNING);
  rig.runs.finish("run-1", FlowRunStatus.done);
  await expect(
    rig.control.startFlow(inPlaceIn("alpha")),
  ).resolves.toMatchObject({ status: FlowRunStatus.running });
});

it("normalizes_subfolder_to_git_toplevel_and_collides_with_toplevel_in_place", async () => {
  const rig = await openRig();
  rig.worktrees.projectRoots = { [join(rig.alpha, "sub")]: rig.alpha };

  await rig.control.startFlow(inPlaceIn("alpha/sub"));

  expect(rig.runs.started[0]).toMatchObject({
    cwd: rig.alpha,
    definitionsCwd: rig.alpha,
  });
  await expect(rig.control.startFlow(inPlaceIn("alpha"))).rejects.toMatchObject(
    IN_PLACE_RUNNING,
  );
});

it("an_omitted_repository_collides_with_the_same_repository_named_explicitly", async () => {
  const rig = await openRig({ cwd: (space) => join(space, "alpha") });

  await rig.control.startFlow(inPlaceIn());

  expect(rig.runs.started[0]).toMatchObject({ cwd: rig.alpha });
  await expect(rig.control.startFlow(inPlaceIn("."))).rejects.toMatchObject(
    IN_PLACE_RUNNING,
  );
  await expect(
    rig.control.startFlow(inPlaceIn(rig.alpha)),
  ).rejects.toMatchObject(IN_PLACE_RUNNING);
});

it("an_omitted_repository_in_a_repo_subfolder_session_collides_with_the_toplevel", async () => {
  const rig = await openRig({
    cwd: (space) => join(space, "alpha", "sub"),
    repoRoot: (space) => join(space, "alpha"),
  });

  await rig.control.startFlow(inPlaceIn());

  await expect(rig.control.startFlow(inPlaceIn(".."))).rejects.toMatchObject(
    IN_PLACE_RUNNING,
  );
});

it("repository_keys_fold_case_on_darwin_so_spellings_collide", async () => {
  const rig = await openRig({
    platform: process.platform === "win32" ? "win32" : "darwin",
  });

  await rig.control.startFlow(inPlaceIn("alpha"));

  await expect(rig.control.startFlow(inPlaceIn("ALPHA"))).rejects.toMatchObject(
    IN_PLACE_RUNNING,
  );
});

it("concurrent_in_place_starts_for_one_repository_start_only_one", async () => {
  const rig = await openRig();
  const gate = Promise.withResolvers<undefined>();
  rig.runs.startGate = gate.promise;

  const attempts = Promise.allSettled([
    rig.control.startFlow(inPlaceIn("alpha")),
    rig.control.startFlow(inPlaceIn("alpha")),
  ]);
  await vi.waitFor(() => {
    expect(rig.runs.started).toHaveLength(1);
  });
  gate.resolve(undefined);
  const outcomes = await attempts;

  expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(rig.runs.started).toHaveLength(1);
});

it("allows_merges_across_different_repos_and_blocks_the_same_repo", async () => {
  const rig = await openRig();
  const inAlpha = await doneWorktreeRun(rig, "alpha");
  const secondAlpha = await doneWorktreeRun(rig, "alpha");
  const inBeta = await doneWorktreeRun(rig, "beta");
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.mergeGate = gate.promise;

  const alphaMerge = rig.control.merge(inAlpha);
  await expect(rig.control.merge(secondAlpha)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Another merge is in progress",
  });
  const betaMerge = rig.control.merge(inBeta);
  await vi.waitFor(() => {
    expect(rig.worktrees.log).toContain(`merge:${inBeta}`);
  });
  gate.resolve(undefined);

  await expect(alphaMerge).resolves.toEqual(MERGED);
  await expect(betaMerge).resolves.toEqual(MERGED);
});

it("a_merge_in_one_repository_blocks_only_its_own_starts", async () => {
  const rig = await openRig();
  const inAlpha = await doneWorktreeRun(rig, "alpha");
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.mergeGate = gate.promise;

  const merging = rig.control.merge(inAlpha);
  await expect(rig.control.startFlow(inPlaceIn("alpha"))).rejects.toMatchObject(
    MERGE_STEP,
  );
  await expect(
    rig.control.startFlow(worktreeIn("alpha")),
  ).rejects.toMatchObject(MERGE_IN_PROGRESS);
  await expect(rig.control.startFlow(inPlaceIn("beta"))).resolves.toMatchObject(
    { status: FlowRunStatus.running },
  );
  await expect(
    rig.control.startFlow(worktreeIn("beta")),
  ).resolves.toMatchObject({ status: FlowRunStatus.running });
  gate.resolve(undefined);
  await merging;
});

it("a_conflict_in_one_repository_does_not_block_in_place_worktree_or_merge_in_another", async () => {
  const rig = await openRig();
  const inAlpha = await doneWorktreeRun(rig, "alpha");
  const inBeta = await doneWorktreeRun(rig, "beta");
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(inAlpha);
  rig.worktrees.mergeOutcome = MERGED;

  await expect(
    rig.control.startFlow(worktreeIn("alpha")),
  ).rejects.toMatchObject(MERGE_IN_PROGRESS);
  await expect(
    rig.control.startFlow(inPlaceIn("alpha")),
  ).resolves.toMatchObject({ status: FlowRunStatus.running });
  await expect(rig.control.startFlow(inPlaceIn("beta"))).resolves.toMatchObject(
    { status: FlowRunStatus.running },
  );
  await expect(rig.control.merge(inBeta)).rejects.toMatchObject(
    IN_PLACE_STILL_RUNNING,
  );
  rig.runs.finish("run-4", FlowRunStatus.done);
  await expect(rig.control.merge(inBeta)).resolves.toEqual(MERGED);
  await expect(rig.control.abortMerge(inAlpha)).rejects.toMatchObject(
    IN_PLACE_STILL_RUNNING,
  );
});

it("finish_and_abort_merge_ignore_an_in_place_run_of_another_repository", async () => {
  const rig = await openRig();
  const inAlpha = await doneWorktreeRun(rig, "alpha");
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(inAlpha);
  await rig.control.startFlow(inPlaceIn("beta"));
  rig.worktrees.finishOutcome = MERGED;

  await expect(rig.control.finishMerge(inAlpha)).resolves.toEqual(MERGED);
});

it("diff_reads_the_working_tree_of_the_run_repository", async () => {
  const rig = await openRig();
  const { runId } = await rig.control.startFlow(inPlaceIn("beta"));
  const omitted = await rig.control.startFlow(inPlaceIn());

  expect(await rig.control.diff(runId)).toBe(`working diff of ${rig.beta}`);
  expect(await rig.control.diff(omitted.runId)).toBe(
    `working diff of ${rig.space}`,
  );
});

it("list_flows_with_a_repository_forwards_the_toplevel_and_without_skips_the_resolver", async () => {
  const rig = await openRig();
  rig.worktrees.projectRoots = { [join(rig.alpha, "sub")]: rig.alpha };

  await rig.control.listFlows();
  expect(rig.listed).toEqual([rig.space]);
  expect(rig.inspect).not.toHaveBeenCalled();

  await rig.control.listFlows("alpha/sub");
  expect(rig.listed).toEqual([rig.space, rig.alpha]);
});

it("refuses_when_the_orchestration_ends_during_repository_resolution", async () => {
  const rig = await openRig();
  const starting = rig.control.startFlow(worktreeIn("alpha"));
  const listing = rig.control.listFlows("alpha");
  rig.orchestration.ended = true;

  const outcomes = await Promise.allSettled([starting, listing]);

  for (const outcome of outcomes) {
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: {
        code: IpcErrorCode.CONFLICT,
        message: "The orchestration has ended",
      },
    });
  }
  expect(rig.worktrees.log).toEqual([]);
  expect(rig.listed).toEqual([]);
  expect(rig.orchestration.runs.size).toBe(0);
});

it("refuses_and_cleans_up_when_a_merge_starts_in_the_repository_during_worktree_create", async () => {
  const rig = await openRig();
  const done = await doneWorktreeRun(rig, "alpha");
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.createGate = gate.promise;
  const mergeGate = Promise.withResolvers<undefined>();
  rig.worktrees.mergeGate = mergeGate.promise;

  const starting = rig.control.startFlow(worktreeIn("alpha"));
  await vi.waitFor(() => {
    expect(rig.worktrees.log).toContain("create:run-2");
  });
  const merging = rig.control.merge(done);
  gate.resolve(undefined);

  await expect(starting).rejects.toMatchObject(MERGE_IN_PROGRESS);
  expect(rig.worktrees.log).toContain("remove:run-2");
  expect(rig.orchestration.runs.has("run-2")).toBe(false);
  mergeGate.resolve(undefined);
  await merging;
});

it("a_merge_in_another_repository_during_worktree_create_does_not_refuse_the_start", async () => {
  const rig = await openRig();
  const inBeta = await doneWorktreeRun(rig, "beta");
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.createGate = gate.promise;
  const mergeGate = Promise.withResolvers<undefined>();
  rig.worktrees.mergeGate = mergeGate.promise;

  const starting = rig.control.startFlow(worktreeIn("alpha"));
  await vi.waitFor(() => {
    expect(rig.worktrees.log).toContain("create:run-2");
  });
  const merging = rig.control.merge(inBeta);
  gate.resolve(undefined);

  await expect(starting).resolves.toMatchObject({
    status: FlowRunStatus.running,
  });
  mergeGate.resolve(undefined);
  await merging;
});
