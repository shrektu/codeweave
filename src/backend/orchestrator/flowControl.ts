import { FlowRunStatus, type FlowDecision } from "../../domain/flowRun";
import {
  FlowPlacement,
  FlowRunOrigin,
  MergeStatus,
  type MergeOutcome,
} from "../../domain/types";
import type { WorktreeState } from "../../domain/types";
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
import {
  createRepositoryScope,
  repositoryKey,
  type RepositoryScope,
} from "./repositoryScope";

export interface OwnedRun {
  readonly repository: string;
  readonly repositoryKey: string;
  readonly placement: FlowPlacement;
  readonly worktree: FlowWorktree | null;
  starting: boolean;
  merging: boolean;
  mergeStarting: boolean;
  committed: Promise<string | null> | null;
}

export interface Orchestration {
  cwd: string | null;
  readonly runs: Map<string, OwnedRun>;
  sessionId: string | null;
  ended: boolean;
}

export interface OrchestratorFlowDeps {
  readonly flowRuns: FlowRunService;
  readonly flowWorktrees: FlowWorktrees;
  readonly listFlows: (cwd: string) => Promise<FlowsList>;
  readonly newRunId: () => string;
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
  readonly protectedPaths: () => Promise<readonly string[]>;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}

interface RunTarget {
  readonly repository: string;
  readonly key: string;
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
  private readonly runs: Map<string, OwnedRun>;
  private readonly orchestration: Orchestration;
  private readonly scope: RepositoryScope;

  constructor(deps: OrchestratorFlowDeps, orchestration: Orchestration) {
    this.deps = deps;
    this.runs = orchestration.runs;
    this.orchestration = orchestration;
    this.scope = createRepositoryScope({
      sessionCwd: () => this.activeCwd(),
      homeDir: deps.homeDir,
      platform: deps.platform,
      inspectWorktree: deps.inspectWorktree,
      protectedPaths: deps.protectedPaths,
      resolveProjectRoot: (cwd) => deps.flowWorktrees.resolveProjectRoot(cwd),
    });
  }

  async listFlows(repository?: string): Promise<FlowsList> {
    if (repository === undefined) {
      return this.deps.listFlows(this.activeCwd());
    }
    const resolved = await this.scope.resolveRepository(repository);
    this.assertActive();
    return this.deps.listFlows(resolved);
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
    const { worktree, repository } = this.ownedRun(runId);
    return worktree === null
      ? this.deps.flowWorktrees.workingDiff(repository)
      : this.deps.flowWorktrees.diff(worktree);
  }

  async decide(
    runId: string,
    decision: FlowDecision,
    note?: string,
  ): Promise<FlowRunView> {
    this.assertActive();
    this.ownedRun(runId);
    return this.deps.flowRuns.decide({ runId, decision }, note);
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
    if (this.hasOpenInPlace(run.repositoryKey)) {
      throw conflict(IN_PLACE_OPEN_MESSAGE);
    }
    if (this.hasMerge(run.repositoryKey)) {
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

  private activeCwd(): string {
    this.assertActive();
    const { cwd } = this.orchestration;
    if (cwd === null) {
      throw conflict(ENDED_MESSAGE);
    }
    return cwd;
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

  private async targetOf(repository: string | undefined): Promise<RunTarget> {
    if (repository === undefined) {
      const cwd = this.activeCwd();
      const key = await this.scope.sessionExclusivityKey();
      this.assertActive();
      return { repository: cwd, key };
    }
    const resolved = await this.scope.resolveRepository(repository);
    this.assertActive();
    return {
      repository: resolved,
      key: repositoryKey(resolved, this.deps.platform),
    };
  }

  private hasOpenInPlace(key: string): boolean {
    return [...this.runs].some(
      ([runId, run]) =>
        run.repositoryKey === key &&
        run.placement === FlowPlacement.inPlace &&
        (run.starting || this.deps.flowRuns.isOpen(runId)),
    );
  }

  private hasMerge(key: string): boolean {
    return [...this.runs.values()].some(
      (run) => run.repositoryKey === key && (run.merging || run.mergeStarting),
    );
  }

  private hasMergeStarting(key: string): boolean {
    return [...this.runs.values()].some(
      (run) => run.repositoryKey === key && run.mergeStarting,
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
    if (this.hasOpenInPlace(run.repositoryKey)) {
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
    const target = await this.targetOf(request.repository);
    if (this.hasOpenInPlace(target.key)) {
      throw conflict(IN_PLACE_RUNNING_MESSAGE);
    }
    if (this.hasMergeStarting(target.key)) {
      throw conflict(MERGE_STEP_RUNNING_MESSAGE);
    }
    const runId = this.deps.newRunId();
    const run = this.register(runId, target, null);
    run.starting = true;
    let view: FlowRunView;
    try {
      view = await this.startRun(
        request,
        runId,
        target.repository,
        target.repository,
        null,
      );
    } catch (error) {
      this.runs.delete(runId);
      throw error;
    } finally {
      run.starting = false;
    }
    await this.refuseStartedRunOfEnded(runId);
    return view;
  }

  private async startInWorktree(
    request: ToolStartRequest,
  ): Promise<FlowRunView> {
    const target = await this.targetOf(request.repository);
    if (this.hasMerge(target.key)) {
      throw conflict(MERGE_IN_PROGRESS_MESSAGE);
    }
    await this.scope.assertWorktreeDestination(target.repository);
    const runId = this.deps.newRunId();
    const worktree = await this.deps.flowWorktrees.create(
      target.repository,
      runId,
    );
    if (this.orchestration.ended) {
      await this.removeWorktree(worktree);
      this.assertActive();
    }
    if (this.hasMerge(target.key)) {
      await this.removeWorktree(worktree);
      throw conflict(MERGE_IN_PROGRESS_MESSAGE);
    }
    this.register(runId, target, worktree);
    let view: FlowRunView;
    try {
      view = await this.startRun(
        request,
        runId,
        worktree.path,
        target.repository,
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

  private register(
    runId: string,
    target: RunTarget,
    worktree: FlowWorktree | null,
  ): OwnedRun {
    const run: OwnedRun = {
      repository: target.repository,
      repositoryKey: target.key,
      placement:
        worktree === null ? FlowPlacement.inPlace : FlowPlacement.worktree,
      worktree,
      starting: false,
      merging: false,
      mergeStarting: false,
      committed: null,
    };
    this.runs.set(runId, run);
    return run;
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
    definitionsCwd: string,
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
      definitionsCwd,
      ownerSessionId: this.orchestration.sessionId,
    });
  }
}

export function createOrchestratorFlowControl(
  deps: OrchestratorFlowDeps,
  orchestration: Orchestration,
): FlowControl {
  return new OrchestratorFlowControl(deps, orchestration);
}
