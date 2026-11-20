import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FlowRunStatus } from "../../domain/flowRun";
import { FlowPlacement, FlowRunOrigin } from "../../domain/types";
import { IpcErrorCode } from "../../shared/protocol";
import { SAMPLE_FLOWS, SAMPLE_RUN } from "../../../tests/fakes/fakeFlowControl";
import {
  CONFLICTED,
  FakeRuns,
  FakeWorktrees,
  MERGED,
  PROJECT,
} from "../../../tests/fakes/fakeOrchestration";
import type { FlowControl } from "../flowTools/control";

import {
  createOrchestratorFlowControl,
  type Orchestration,
} from "./flowControl";

const SESSION_ID = "orchestrator-session";
const IN_PLACE_REQUEST = {
  flowId: "review",
  task: "Fix it",
  placement: FlowPlacement.inPlace,
};
const WORKTREE_REQUEST = {
  ...IN_PLACE_REQUEST,
  placement: FlowPlacement.worktree,
};

interface Rig {
  readonly control: FlowControl;
  readonly runs: FakeRuns;
  readonly worktrees: FakeWorktrees;
  readonly orchestration: Orchestration;
}

function openRig(): Rig {
  let counter = 0;
  const runs = new FakeRuns();
  const worktrees = new FakeWorktrees();
  const orchestration: Orchestration = {
    cwd: PROJECT,
    runs: new Map(),
    sessionId: SESSION_ID,
    ended: false,
  };
  const control = createOrchestratorFlowControl(
    {
      flowRuns: runs,
      flowWorktrees: worktrees,
      listFlows: () => Promise.resolve(SAMPLE_FLOWS),
      newRunId: () => {
        counter += 1;
        return `run-${String(counter)}`;
      },
    },
    orchestration,
  );
  return { control, runs, worktrees, orchestration };
}

async function doneWorktreeRun(rig: Rig): Promise<string> {
  const { runId } = await rig.control.startFlow(WORKTREE_REQUEST);
  rig.runs.finish(runId, FlowRunStatus.done);
  return runId;
}

function ownedRun(
  rig: Rig,
  runId: string,
): NonNullable<ReturnType<Orchestration["runs"]["get"]>> {
  const owned = rig.orchestration.runs.get(runId);
  if (owned === undefined) {
    throw new Error("the run was not registered");
  }
  return owned;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("refuses_a_run_it_does_not_own", async () => {
  const rig = openRig();
  rig.runs.runViews.set("foreign", { ...SAMPLE_RUN, runId: "foreign" });
  const refused = { code: IpcErrorCode.NOT_FOUND, message: "Unknown flow run" };

  expect(() => rig.control.status("foreign")).toThrow(
    expect.objectContaining(refused),
  );
  expect(() => rig.control.nodeResult("foreign", "write")).toThrow(
    expect.objectContaining(refused),
  );
  await expect(rig.control.diff("foreign")).rejects.toMatchObject(refused);
  await expect(rig.control.decide("foreign", "approve")).rejects.toMatchObject(
    refused,
  );
  await expect(rig.control.stop("foreign")).rejects.toMatchObject(refused);
  await expect(rig.control.merge("foreign")).rejects.toMatchObject(refused);
  await expect(rig.control.finishMerge("foreign")).rejects.toMatchObject(
    refused,
  );
  await expect(rig.control.abortMerge("foreign")).rejects.toMatchObject(
    refused,
  );
  expect(rig.runs.stopped).toEqual([]);
  expect(rig.runs.decided).toEqual([]);
});

it("refuses_an_unknown_node", async () => {
  const rig = openRig();
  const { runId } = await rig.control.startFlow(IN_PLACE_REQUEST);

  expect(() => rig.control.nodeResult(runId, "missing")).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: "Unknown node",
    }),
  );
  expect(rig.control.nodeResult(runId, "write")).toBe("done");
  expect(rig.control.nodeResult(runId, "check")).toBe("");
});

it("registers_ownership_and_starts_an_in_place_run_in_the_project", async () => {
  const rig = openRig();

  const view = await rig.control.startFlow(IN_PLACE_REQUEST);

  expect(rig.runs.started).toEqual([
    {
      cwd: PROJECT,
      flowId: "review",
      task: "Fix it",
      runId: "run-1",
      origin: FlowRunOrigin.orchestrator,
      placement: FlowPlacement.inPlace,
      branch: null,
      definitionsCwd: PROJECT,
      ownerSessionId: SESSION_ID,
    },
  ]);
  expect(view.runId).toBe("run-1");
  expect([...rig.orchestration.runs.keys()]).toEqual(["run-1"]);
  expect(await rig.control.diff("run-1")).toBe(`working diff of ${PROJECT}`);
});

it("refuses_a_second_in_place_run", async () => {
  const rig = openRig();
  await rig.control.startFlow(IN_PLACE_REQUEST);

  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "An in-place flow is already running",
  });
  expect(rig.runs.started).toHaveLength(1);
  rig.runs.finish("run-1", FlowRunStatus.done);

  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).resolves.toMatchObject({
    runId: "run-2",
  });
});

it("forgets_an_in_place_run_that_fails_to_start", async () => {
  const rig = openRig();
  rig.runs.startError = new Error("no such flow");

  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).rejects.toThrow(
    "no such flow",
  );

  expect(rig.orchestration.runs.size).toBe(0);
});

it("starts_a_worktree_run_in_the_new_worktree_on_its_branch", async () => {
  const rig = openRig();

  await rig.control.startFlow(WORKTREE_REQUEST);

  expect(rig.runs.started[0]).toMatchObject({
    cwd: "/work/.worktrees/run-1",
    placement: FlowPlacement.worktree,
    branch: "codeweave/run-1",
    runId: "run-1",
    definitionsCwd: PROJECT,
    ownerSessionId: SESSION_ID,
  });
  expect(await rig.control.diff("run-1")).toBe("diff of run-1");
});

it("refuses_a_worktree_start_during_a_merge", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);

  await expect(rig.control.startFlow(WORKTREE_REQUEST)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A merge is in progress",
  });

  expect(rig.worktrees.log).toEqual(["create:run-1", "merge:run-1"]);
});

it("removes_the_worktree_when_the_run_fails_to_start", async () => {
  const rig = openRig();
  rig.runs.startError = new Error("start refused");

  await expect(rig.control.startFlow(WORKTREE_REQUEST)).rejects.toThrow(
    "start refused",
  );

  expect(rig.worktrees.log).toEqual(["create:run-1", "remove:run-1"]);
  expect(rig.orchestration.runs.size).toBe(0);
});

it("rethrows_the_start_error_when_the_worktree_removal_fails_too", async () => {
  const rig = openRig();
  rig.runs.startError = new Error("start refused");
  rig.worktrees.removeError = new Error("remove refused");

  await expect(rig.control.startFlow(WORKTREE_REQUEST)).rejects.toThrow(
    "start refused",
  );

  expect(console.error).toHaveBeenCalled();
});

it("refuses_merge_before_done", async () => {
  const rig = openRig();
  const { runId } = await rig.control.startFlow(WORKTREE_REQUEST);
  const inPlace = await rig.control.startFlow(IN_PLACE_REQUEST);

  await expect(rig.control.merge(runId)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "The flow has not finished",
  });
  await expect(rig.control.merge(inPlace.runId)).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: "Only worktree flows can be merged",
  });
  expect(rig.worktrees.log).not.toContain("merge:run-1");
});

it("waits_for_the_done_commit_before_merging", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  const commit = Promise.withResolvers<string | null>();
  ownedRun(rig, runId).committed = commit.promise;

  const merging = rig.control.merge(runId);
  await Promise.resolve();
  await Promise.resolve();

  expect(rig.worktrees.log).toEqual(["create:run-1"]);
  commit.resolve("deadbeef");
  await expect(merging).resolves.toEqual(MERGED);
  expect(rig.worktrees.log).toEqual([
    "create:run-1",
    "merge:run-1",
    "remove:run-1",
  ]);
});

it("refuses_merge_with_the_commit_error_when_the_done_commit_failed", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  ownedRun(rig, runId).committed = Promise.reject(new Error("hook declined"));

  await expect(rig.control.merge(runId)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Committing the flow changes failed: hook declined",
  });
  expect(rig.worktrees.log).toEqual(["create:run-1"]);
});

it("keeps_merged_state_when_worktree_removal_fails", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.removeError = new Error("worktree is locked");

  await expect(rig.control.merge(runId)).resolves.toEqual(MERGED);

  expect(ownedRun(rig, runId).merging).toBe(false);
  expect(console.error).toHaveBeenCalled();
});

it("refuses_a_second_merge_while_one_is_in_progress", async () => {
  const rig = openRig();
  const first = await doneWorktreeRun(rig);
  const second = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(first);

  await expect(rig.control.merge(second)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Another merge is in progress",
  });
});

it("refuses_finish_and_abort_while_an_in_place_run_is_open", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);
  await rig.control.startFlow(IN_PLACE_REQUEST);
  const refused = {
    code: IpcErrorCode.CONFLICT,
    message: "An in-place flow is still running",
  };

  await expect(rig.control.finishMerge(runId)).rejects.toMatchObject(refused);
  await expect(rig.control.abortMerge(runId)).rejects.toMatchObject(refused);

  expect(rig.worktrees.log).toEqual(["create:run-1", "merge:run-1"]);
});

it("finishes_a_merge_clears_the_flag_and_removes_the_worktree", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);

  rig.worktrees.finishOutcome = CONFLICTED;
  await expect(rig.control.finishMerge(runId)).resolves.toEqual(CONFLICTED);
  expect(ownedRun(rig, runId).merging).toBe(true);
  rig.worktrees.finishOutcome = MERGED;
  await expect(rig.control.finishMerge(runId)).resolves.toEqual(MERGED);

  expect(ownedRun(rig, runId).merging).toBe(false);
  expect(rig.worktrees.log).toEqual([
    "create:run-1",
    "merge:run-1",
    "finish:run-1",
    "finish:run-1",
    "remove:run-1",
  ]);
});

it("aborts_a_merge_and_keeps_the_worktree", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);

  await rig.control.abortMerge(runId);

  expect(ownedRun(rig, runId).merging).toBe(false);
  expect(rig.worktrees.log).toEqual([
    "create:run-1",
    "merge:run-1",
    "abort:run-1",
  ]);
  await expect(rig.control.abortMerge(runId)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No merge in progress for this flow",
  });
});

it("forwards_decide_stop_and_list_flows_for_an_owned_run", async () => {
  const rig = openRig();
  const { runId } = await rig.control.startFlow(IN_PLACE_REQUEST);

  await rig.control.decide(runId, "approve");
  await rig.control.stop(runId);

  await rig.control.decide(runId, "stop", "Out of budget");

  expect(rig.runs.decided).toEqual([
    { runId, decision: "approve" },
    { runId, decision: "stop", note: "Out of budget" },
  ]);
  expect(rig.runs.stopped).toEqual([runId]);
  await expect(rig.control.listFlows()).resolves.toEqual(SAMPLE_FLOWS);
});

const ENDED = {
  code: IpcErrorCode.CONFLICT,
  message: "The orchestration has ended",
};
const OTHER_MERGE = {
  code: IpcErrorCode.CONFLICT,
  message: "Another merge is in progress",
};

it("starts_no_run_after_the_orchestration_ended_during_worktree_create", async () => {
  const rig = openRig();
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.createGate = gate.promise;

  const starting = rig.control.startFlow(WORKTREE_REQUEST);
  rig.orchestration.ended = true;
  gate.resolve(undefined);

  await expect(starting).rejects.toMatchObject(ENDED);
  expect(rig.runs.started).toEqual([]);
  expect(rig.worktrees.log).toEqual(["create:run-1", "remove:run-1"]);
  expect(rig.orchestration.runs.size).toBe(0);
});

it("stops_a_run_whose_start_resolved_after_the_orchestration_ended", async () => {
  const rig = openRig();
  const gate = Promise.withResolvers<undefined>();
  rig.runs.startGate = gate.promise;

  const starting = rig.control.startFlow(IN_PLACE_REQUEST);
  rig.orchestration.ended = true;
  gate.resolve(undefined);

  await expect(starting).rejects.toMatchObject(ENDED);
  expect(rig.runs.stopped).toEqual(["run-1"]);
});

it("keeps_the_worktree_of_a_run_whose_start_resolved_after_the_orchestration_ended", async () => {
  const rig = openRig();
  const gate = Promise.withResolvers<undefined>();
  rig.runs.startGate = gate.promise;

  const starting = rig.control.startFlow(WORKTREE_REQUEST);
  await vi.waitFor(() => {
    expect(rig.runs.started).toHaveLength(1);
  });
  rig.orchestration.ended = true;
  gate.resolve(undefined);

  await expect(starting).rejects.toMatchObject(ENDED);
  expect(rig.runs.stopped).toEqual(["run-1"]);
  expect(rig.worktrees.log).toEqual(["create:run-1"]);
});

it("logs_a_failing_stop_of_a_run_started_after_the_orchestration_ended", async () => {
  const rig = openRig();
  const gate = Promise.withResolvers<undefined>();
  rig.runs.startGate = gate.promise;
  rig.runs.stopError = new Error("stop refused");

  const starting = rig.control.startFlow(IN_PLACE_REQUEST);
  rig.orchestration.ended = true;
  gate.resolve(undefined);

  await expect(starting).rejects.toMatchObject(ENDED);
  expect(console.error).toHaveBeenCalled();
});

it("refuses_every_call_once_the_orchestration_ended", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.orchestration.ended = true;

  await expect(rig.control.listFlows()).rejects.toMatchObject(ENDED);
  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).rejects.toMatchObject(
    ENDED,
  );
  await expect(rig.control.startFlow(WORKTREE_REQUEST)).rejects.toMatchObject(
    ENDED,
  );
  expect(() => rig.control.status(runId)).toThrow(
    expect.objectContaining(ENDED),
  );
  expect(() => rig.control.nodeResult(runId, "write")).toThrow(
    expect.objectContaining(ENDED),
  );
  await expect(rig.control.diff(runId)).rejects.toMatchObject(ENDED);
  await expect(rig.control.decide(runId, "approve")).rejects.toMatchObject(
    ENDED,
  );
  await expect(rig.control.stop(runId)).rejects.toMatchObject(ENDED);
  await expect(rig.control.merge(runId)).rejects.toMatchObject(ENDED);
  await expect(rig.control.finishMerge(runId)).rejects.toMatchObject(ENDED);
  await expect(rig.control.abortMerge(runId)).rejects.toMatchObject(ENDED);
  expect(rig.worktrees.log).toEqual(["create:run-1"]);
});

it("refuses_a_second_merge_while_the_first_is_still_running", async () => {
  const rig = openRig();
  const first = await doneWorktreeRun(rig);
  const second = await doneWorktreeRun(rig);
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.mergeGate = gate.promise;

  const merging = rig.control.merge(first);
  await expect(rig.control.merge(second)).rejects.toMatchObject(OTHER_MERGE);
  await expect(rig.control.merge(first)).rejects.toMatchObject(OTHER_MERGE);
  gate.resolve(undefined);

  await expect(merging).resolves.toEqual(MERGED);
  expect(
    rig.worktrees.log.filter((entry) => entry.startsWith("merge:")),
  ).toEqual(["merge:run-1"]);
  expect(ownedRun(rig, first).merging).toBe(false);
  rig.worktrees.mergeGate = null;
  await expect(rig.control.merge(second)).resolves.toEqual(MERGED);
});

it("clears_the_merge_start_flag_when_the_merge_throws", async () => {
  const rig = openRig();
  const first = await doneWorktreeRun(rig);
  const second = await doneWorktreeRun(rig);
  ownedRun(rig, first).committed = Promise.reject(new Error("hook declined"));

  await expect(rig.control.merge(first)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });

  await expect(rig.control.merge(second)).resolves.toEqual(MERGED);
});

it("refuses_a_second_finish_merge_while_the_first_is_still_running", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.finishGate = gate.promise;

  const finishing = rig.control.finishMerge(runId);
  await expect(rig.control.finishMerge(runId)).rejects.toMatchObject(
    OTHER_MERGE,
  );
  await expect(rig.control.abortMerge(runId)).rejects.toMatchObject(
    OTHER_MERGE,
  );
  gate.resolve(undefined);

  await expect(finishing).resolves.toEqual(MERGED);
  expect(
    rig.worktrees.log.filter((entry) => entry.startsWith("finish:")),
  ).toEqual(["finish:run-1"]);
  expect(rig.worktrees.log).not.toContain("abort:run-1");
});

it("refuses_a_second_abort_merge_while_the_first_is_still_running", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);

  await Promise.all([
    expect(rig.control.abortMerge(runId)).resolves.toBeUndefined(),
    expect(rig.control.abortMerge(runId)).rejects.toMatchObject(OTHER_MERGE),
  ]);

  expect(
    rig.worktrees.log.filter((entry) => entry.startsWith("abort:")),
  ).toEqual(["abort:run-1"]);
});

it("refuses_merge_while_an_in_place_run_is_open", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  const inPlace = await rig.control.startFlow(IN_PLACE_REQUEST);

  await expect(rig.control.merge(runId)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "An in-place flow is still running",
  });
  expect(rig.worktrees.log).toEqual(["create:run-1"]);
  expect(ownedRun(rig, runId).merging).toBe(false);

  rig.runs.finish(inPlace.runId, FlowRunStatus.done);
  await expect(rig.control.merge(runId)).resolves.toEqual(MERGED);
});

it("refuses_an_in_place_start_while_a_merge_step_is_running", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.mergeGate = gate.promise;

  const merging = rig.control.merge(runId);
  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A merge step is running",
  });
  gate.resolve(undefined);
  await expect(merging).resolves.toEqual(MERGED);

  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).resolves.toMatchObject({
    status: FlowRunStatus.running,
  });
});

it("allows_an_in_place_fix_flow_while_a_merge_conflict_is_unresolved", async () => {
  const rig = openRig();
  const runId = await doneWorktreeRun(rig);
  rig.worktrees.mergeOutcome = CONFLICTED;
  await rig.control.merge(runId);

  await expect(rig.control.startFlow(IN_PLACE_REQUEST)).resolves.toMatchObject({
    status: FlowRunStatus.running,
  });
});
