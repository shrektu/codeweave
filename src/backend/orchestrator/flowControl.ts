import { FlowRunStatus, type FlowDecision } from "../../domain/flowRun";
import {
  FlowPlacement,
  FlowRunOrigin,
  MergeStatus,
  type MergeOutcome,
} from "../../domain/types";
import { IpcError, IpcErrorCode } from "../../shared/protocol";
import type { FlowRunView, FlowsList } from "../../shared/views";
import type { FlowRunService } from "../flowRuns";
import type {
  FlowControl,
  FlowStartRequest as ToolStartRequest,
} from "../flowTools/control";
import type { FlowWorktree, FlowWorktrees } from "../flowWorktrees";

import {
  COMMIT_FAILED_MESSAGE,
  ENDED_MESSAGE,
  IN_PLACE_OPEN_MESSAGE,
  IN_PLACE_RUNNING_MESSAGE,
  MERGE_IN_PROGRESS_MESSAGE,
  MERGE_STEP_RUNNING_MESSAGE,
  NO_MERGE_MESSAGE,
  NOT_FINISHED_MESSAGE,
  OTHER_MERGE_MESSAGE,
  UNKNOWN_NODE_MESSAGE,
  UNKNOWN_RUN_MESSAGE,
  WORKTREE_ONLY_MESSAGE,
} from "./constants";

export interface OwnedRun {
  readonly placement: FlowPlacement;
  readonly worktree: FlowWorktree | null;
  merging: boolean;
  mergeStarting: boolean;
  committed: Promise<string | null> | null;
}

export interface Orchestration {
  readonly cwd: string;
  readonly runs: Map<string, OwnedRun>;
  ended: boolean;
}

export interface OrchestratorFlowDeps {
  readonly flowRuns: FlowRunService;
  readonly flowWorktrees: FlowWorktrees;
  readonly listFlows: (cwd: string) => Promise<FlowsList>;
  readonly newRunId: () => string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notFound(message: string): IpcError {
  return new IpcError(IpcErrorCode.NOT_FOUND, message);
}

function conflict(message: string): IpcError {
  return new IpcError(IpcErrorCode.CONFLICT, message);
}

class OrchestratorFlowControl implements FlowControl {
  private readonly deps: OrchestratorFlowDeps;
  private readonly cwd: string;
  private readonly runs: Map<string, OwnedRun>;
  private readonly orchestration: Orchestration;

  constructor(deps: OrchestratorFlowDeps, orchestration: Orchestration) {
    this.deps = deps;
    this.cwd = orchestration.cwd;
    this.runs = orchestration.runs;
    this.orchestration = orchestration;
  }

  async listFlows(): Promise<FlowsList> {
    this.assertActive();
    return this.deps.listFlows(this.cwd);
  }

  startFlow(request: ToolStartRequest): Promise<FlowRunView> {
    return request.placement === FlowPlacement.worktree
      ? this.startInWorktree(request)
      : this.startInPlace(request);
  }

  status(runId: string): FlowRunView {
    this.assertActive();
    return this.viewOf(runId);
  }

  nodeResult(runId: string, nodeId: string): string {
    this.assertActive();
    const node = this.viewOf(runId).nodes.find((item) => item.id === nodeId);
    if (node === undefined) {
      throw notFound(UNKNOWN_NODE_MESSAGE);
    }
    return node.result ?? "";
  }

  async diff(runId: string): Promise<string> {
    this.assertActive();
    const { worktree } = this.ownedRun(runId);
    return worktree === null
      ? this.deps.flowWorktrees.workingDiff(this.cwd)
      : this.deps.flowWorktrees.diff(worktree);
  }

  async decide(runId: string, decision: FlowDecision): Promise<FlowRunView> {
    this.assertActive();
    this.ownedRun(runId);
    return this.deps.flowRuns.decide({ runId, decision });
  }

  async stop(runId: string): Promise<void> {
    this.assertActive();
    this.ownedRun(runId);
    await this.deps.flowRuns.stop(runId);
  }

  async merge(runId: string): Promise<MergeOutcome> {
    this.assertActive();
    const run = this.ownedRun(runId);
    const { worktree } = run;
    if (worktree === null) {
      throw new IpcError(IpcErrorCode.VALIDATION, WORKTREE_ONLY_MESSAGE);
    }
    if (this.viewOf(runId).status !== FlowRunStatus.done) {
      throw conflict(NOT_FINISHED_MESSAGE);
    }
    if (this.hasOpenInPlace()) {
      throw conflict(IN_PLACE_OPEN_MESSAGE);
    }
    if (this.hasMerge()) {
      throw conflict(OTHER_MERGE_MESSAGE);
    }
    run.mergeStarting = true;
    try {
      await this.awaitCommit(run);
      const outcome = await this.deps.flowWorktrees.merge(worktree);
      if (outcome.status === MergeStatus.merged) {
        await this.removeWorktree(worktree);
      } else {
        run.merging = true;
      }
      return outcome;
    } finally {
      run.mergeStarting = false;
    }
  }

  async finishMerge(runId: string): Promise<MergeOutcome> {
    const { run, worktree } = this.beginMergeStep(runId);
    try {
      const outcome = await this.deps.flowWorktrees.finishMerge(worktree);
      if (outcome.status === MergeStatus.merged) {
        run.merging = false;
        await this.removeWorktree(worktree);
      }
      return outcome;
    } finally {
      run.mergeStarting = false;
    }
  }

  async abortMerge(runId: string): Promise<void> {
    const { run, worktree } = this.beginMergeStep(runId);
    try {
      await this.deps.flowWorktrees.abortMerge(worktree);
      run.merging = false;
    } finally {
      run.mergeStarting = false;
    }
  }

  private assertActive(): void {
    if (this.orchestration.ended) {
      throw conflict(ENDED_MESSAGE);
    }
  }

  private ownedRun(runId: string): OwnedRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw notFound(UNKNOWN_RUN_MESSAGE);
    }
    return run;
  }

  private viewOf(runId: string): FlowRunView {
    this.ownedRun(runId);
    const view = this.deps.flowRuns.view(runId);
    if (view === null) {
      throw notFound(UNKNOWN_RUN_MESSAGE);
    }
    return view;
  }

  private hasOpenInPlace(): boolean {
    return [...this.runs].some(
      ([runId, run]) =>
        run.placement === FlowPlacement.inPlace &&
        this.deps.flowRuns.isOpen(runId),
    );
  }

  private hasMerge(): boolean {
    return [...this.runs.values()].some(
      (run) => run.merging || run.mergeStarting,
    );
  }

  private beginMergeStep(runId: string): {
    run: OwnedRun;
    worktree: FlowWorktree;
  } {
    this.assertActive();
    const run = this.ownedRun(runId);
    if (!run.merging || run.worktree === null) {
      throw conflict(NO_MERGE_MESSAGE);
    }
    if (run.mergeStarting) {
      throw conflict(OTHER_MERGE_MESSAGE);
    }
    if (this.hasOpenInPlace()) {
      throw conflict(IN_PLACE_OPEN_MESSAGE);
    }
    run.mergeStarting = true;
    return { run, worktree: run.worktree };
  }

  private async removeWorktree(worktree: FlowWorktree): Promise<void> {
    try {
      await this.deps.flowWorktrees.remove(worktree);
    } catch (error) {
      console.error(`failed to remove worktree ${worktree.path}`, error);
    }
  }

  private async awaitCommit(run: OwnedRun): Promise<void> {
    try {
      await run.committed;
    } catch (error) {
      throw conflict(`${COMMIT_FAILED_MESSAGE}: ${errorText(error)}`);
    }
  }

  private async startInPlace(request: ToolStartRequest): Promise<FlowRunView> {
    this.assertActive();
    if (this.hasOpenInPlace()) {
      throw conflict(IN_PLACE_RUNNING_MESSAGE);
    }
    if ([...this.runs.values()].some((run) => run.mergeStarting)) {
      throw conflict(MERGE_STEP_RUNNING_MESSAGE);
    }
    const runId = this.deps.newRunId();
    this.runs.set(runId, {
      placement: FlowPlacement.inPlace,
      worktree: null,
      merging: false,
      mergeStarting: false,
      committed: null,
    });
    let view: FlowRunView;
    try {
      view = await this.startRun(request, runId, this.cwd, null);
    } catch (error) {
      this.runs.delete(runId);
      throw error;
    }
    await this.refuseStartedRunOfEnded(runId);
    return view;
  }

  private async startInWorktree(
    request: ToolStartRequest,
  ): Promise<FlowRunView> {
    this.assertActive();
    if (this.hasMerge()) {
      throw conflict(MERGE_IN_PROGRESS_MESSAGE);
    }
    const runId = this.deps.newRunId();
    const worktree = await this.deps.flowWorktrees.create(this.cwd, runId);
    if (this.orchestration.ended) {
      await this.removeWorktree(worktree);
      this.assertActive();
    }
    this.runs.set(runId, {
      placement: FlowPlacement.worktree,
      worktree,
      merging: false,
      mergeStarting: false,
      committed: null,
    });
    let view: FlowRunView;
    try {
      view = await this.startRun(
        request,
        runId,
        worktree.path,
        worktree.branch,
      );
    } catch (error) {
      this.runs.delete(runId);
      await this.removeWorktree(worktree);
      throw error;
    }
    await this.refuseStartedRunOfEnded(runId);
    return view;
  }

  private async refuseStartedRunOfEnded(runId: string): Promise<void> {
    if (!this.orchestration.ended) {
      return;
    }
    try {
      await this.deps.flowRuns.stop(runId);
    } catch (error) {
      console.error(`failed to stop flow run ${runId}`, error);
    }
    this.assertActive();
  }

  private startRun(
    request: ToolStartRequest,
    runId: string,
    cwd: string,
    branch: string | null,
  ): Promise<FlowRunView> {
    return this.deps.flowRuns.start({
      cwd,
      flowId: request.flowId,
      task: request.task,
      runId,
      origin: FlowRunOrigin.orchestrator,
      placement: request.placement,
      branch,
    });
  }
}

export function createOrchestratorFlowControl(
  deps: OrchestratorFlowDeps,
  orchestration: Orchestration,
): FlowControl {
  return new OrchestratorFlowControl(deps, orchestration);
}
