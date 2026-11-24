import { FlowRunStatus, type FlowDecision } from "../../src/domain/flowRun";
import {
  FlowPlacement,
  MergeStatus,
  PermissionProfile,
  ProviderId,
  type MergeOutcome,
} from "../../src/domain/types";
import type {
  FlowRunService,
  FlowStartRequest,
} from "../../src/backend/flowRuns";
import type {
  FlowWorktree,
  FlowWorktrees,
} from "../../src/backend/flowWorktrees";
import type { OrchestratorFlowDeps } from "../../src/backend/orchestrator/flowControl";
import type { FlowRunView, SessionView } from "../../src/shared/views";

import { SAMPLE_RUN } from "./fakeFlowControl";

export function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "sess-1",
    cwd: "/work/project",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.plan,
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    activeProvider: ProviderId.claude,
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    turns: [],
    orchestrate: true,
    ...overrides,
  };
}

export const PROJECT = "/work/project";
export const MERGED: MergeOutcome = {
  status: MergeStatus.merged,
  commit: "abc123",
};
export const CONFLICTED: MergeOutcome = {
  status: MergeStatus.conflict,
  files: ["a.txt"],
};

export class FakeRuns implements FlowRunService {
  readonly started: FlowStartRequest[] = [];
  readonly decided: unknown[] = [];
  readonly stopped: string[] = [];
  readonly open = new Set<string>();
  readonly runViews = new Map<string, FlowRunView>();
  readonly listeners = new Set<(view: FlowRunView) => void>();
  startError: Error | null = null;
  stopError: Error | null = null;
  startGate: Promise<undefined> | null = null;
  stopGate: Promise<undefined> | null = null;

  views(): FlowRunView[] {
    return [...this.runViews.values()];
  }

  view(runId: string): FlowRunView | null {
    return this.runViews.get(runId) ?? null;
  }

  async start(request: FlowStartRequest): Promise<FlowRunView> {
    this.started.push(request);
    await this.startGate;
    if (this.startError !== null) {
      throw this.startError;
    }
    const runId = request.runId ?? "missing";
    const view: FlowRunView = {
      ...SAMPLE_RUN,
      runId,
      status: FlowRunStatus.running,
      decision: null,
      placement: request.placement ?? FlowPlacement.inPlace,
      branch: request.branch ?? null,
      ownerSessionId: request.ownerSessionId ?? null,
    };
    this.runViews.set(runId, view);
    this.open.add(runId);
    return view;
  }

  async stop(runId: string): Promise<void> {
    this.stopped.push(runId);
    await this.stopGate;
    if (this.stopError !== null) {
      throw this.stopError;
    }
  }

  stopAll(): Promise<void> {
    return Promise.resolve();
  }

  decide(
    params: { runId: string; decision: FlowDecision },
    note?: string,
  ): Promise<FlowRunView> {
    this.decided.push(note === undefined ? params : { ...params, note });
    return Promise.resolve(this.runViews.get(params.runId) ?? SAMPLE_RUN);
  }

  answerPermission(): void {
    return undefined;
  }

  isOpen(runId: string): boolean {
    return this.open.has(runId);
  }

  hasOpenRuns(): boolean {
    return this.open.size > 0;
  }

  hasOpenUserRuns(): boolean {
    return false;
  }

  onChanged(listener: (view: FlowRunView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  finish(runId: string, status: FlowRunStatus): FlowRunView {
    const view = {
      ...(this.runViews.get(runId) ?? SAMPLE_RUN),
      runId,
      status,
    };
    this.runViews.set(runId, view);
    this.open.delete(runId);
    this.listeners.forEach((listener) => {
      listener(view);
    });
    return view;
  }
}

export function repositoryDeps(): Pick<
  OrchestratorFlowDeps,
  "inspectWorktree" | "protectedPaths" | "homeDir" | "platform"
> {
  return {
    inspectWorktree: (cwd) => Promise.resolve({ isRepo: false, cwd }),
    protectedPaths: () => Promise.resolve([]),
    homeDir: "/home/jane",
    platform: "linux",
  };
}

export class FakeWorktrees implements FlowWorktrees {
  readonly log: string[] = [];
  mergeOutcome: MergeOutcome = MERGED;
  finishOutcome: MergeOutcome = MERGED;
  removeError: Error | null = null;
  commitError: Error | null = null;
  commitGate: Promise<undefined> | null = null;
  createGate: Promise<undefined> | null = null;
  projectRoots: Readonly<Record<string, string>> = {};
  mergeGate: Promise<undefined> | null = null;
  finishGate: Promise<undefined> | null = null;

  resolveProjectRoot(cwd: string): Promise<string> {
    return Promise.resolve(this.projectRoots[cwd] ?? cwd);
  }

  async create(projectCwd: string, runId: string): Promise<FlowWorktree> {
    this.log.push(`create:${runId}`);
    await this.createGate;
    return {
      runId,
      projectRoot: projectCwd,
      path: `/work/.worktrees/${runId}`,
      branch: `codeweave/${runId}`,
      base: "base",
    };
  }

  async commitAll(
    worktree: FlowWorktree,
    message: string,
  ): Promise<string | null> {
    this.log.push(`commit:${worktree.runId}:${message}`);
    await this.commitGate;
    if (this.commitError !== null) {
      throw this.commitError;
    }
    return "deadbeef";
  }

  diff(worktree: FlowWorktree): Promise<string> {
    return Promise.resolve(`diff of ${worktree.runId}`);
  }

  workingDiff(cwd: string): Promise<string> {
    return Promise.resolve(`working diff of ${cwd}`);
  }

  isDirty(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async merge(worktree: FlowWorktree): Promise<MergeOutcome> {
    this.log.push(`merge:${worktree.runId}`);
    await this.mergeGate;
    return this.mergeOutcome;
  }

  async finishMerge(worktree: FlowWorktree): Promise<MergeOutcome> {
    this.log.push(`finish:${worktree.runId}`);
    await this.finishGate;
    return this.finishOutcome;
  }

  abortMerge(worktree: FlowWorktree): Promise<void> {
    this.log.push(`abort:${worktree.runId}`);
    return Promise.resolve();
  }

  remove(worktree: FlowWorktree): Promise<void> {
    this.log.push(`remove:${worktree.runId}`);
    return this.removeError === null
      ? Promise.resolve()
      : Promise.reject(this.removeError);
  }
}
