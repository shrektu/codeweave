import { FlowRunStatus } from "../../domain/flowRun";
import { ORCHESTRATOR_INSTRUCTIONS } from "../../domain/orchestratorInstructions";
import { buildFlowReport } from "../../domain/orchestratorReport";
import { PermissionProfile } from "../../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../../shared/protocol";
import type { FlowRunView, SessionView } from "../../shared/views";
import {
  startFlowToolServer,
  type FlowToolServer,
  type ToolGrant,
} from "../flowTools/server";
import type { FlowWorktree } from "../flowWorktrees";
import { LeaseMode } from "../locks";
import type { SessionService } from "../session";

import {
  COMMIT_FAILED_MESSAGE,
  ORCHESTRATE_UNAVAILABLE_PREFIX,
} from "./constants";
import {
  createOrchestratorFlowControl,
  type Orchestration,
  type OrchestratorFlowDeps,
  type OwnedRun,
} from "./flowControl";
import { createWakeupQueue, type WakeupQueue } from "./wakeups";

export interface OrchestratorServiceDeps extends OrchestratorFlowDeps {
  readonly main: SessionService;
  readonly startToolServer?: () => Promise<FlowToolServer>;
}

export interface OrchestratorService {
  start(params: ParamsMap["session/start"]): Promise<SessionView>;
  shutdown(): Promise<void>;
}

const REPORTED_STATUSES: readonly FlowRunStatus[] = [
  FlowRunStatus.awaitingDecision,
  FlowRunStatus.done,
  FlowRunStatus.failed,
  FlowRunStatus.stopped,
];
const ENDING_PHASES: readonly SessionView["phase"]["phase"][] = [
  "stopped",
  "failed",
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Binding {
  readonly server: FlowToolServer;
  readonly grant: ToolGrant;
  readonly orchestration: Orchestration;
  readonly sessionId: string;
}

class ActiveOrchestration {
  private readonly deps: OrchestratorServiceDeps;
  private readonly binding: Binding;
  private readonly queue: WakeupQueue;
  private readonly unsubscribers: (() => void)[];
  private readonly onEnded: () => void;
  private ending: Promise<void> | null = null;

  constructor(
    deps: OrchestratorServiceDeps,
    binding: Binding,
    onEnded: () => void,
  ) {
    this.deps = deps;
    this.binding = binding;
    this.onEnded = onEnded;
    this.queue = createWakeupQueue({
      session: deps.main,
      build: buildFlowReport,
    });
    this.unsubscribers = [
      deps.main.onViewChanged((view) => {
        this.watchSession(view);
      }),
      deps.flowRuns.onChanged((view) => {
        this.watchRun(view);
      }),
    ];
  }

  end(): Promise<void> {
    this.ending ??= this.teardown();
    return this.ending;
  }

  watchSession(view: SessionView | null): void {
    const alive =
      view?.id === this.binding.sessionId &&
      !ENDING_PHASES.includes(view.phase.phase);
    if (!alive) {
      void this.end();
    }
  }

  private watchRun(view: FlowRunView): void {
    const run = this.binding.orchestration.runs.get(view.runId);
    if (run === undefined || !REPORTED_STATUSES.includes(view.status)) {
      return;
    }
    const { worktree } = run;
    if (view.status === FlowRunStatus.done && worktree !== null) {
      void this.reportCommitted(view, run, worktree);
      return;
    }
    this.queue.enqueue({ view, note: null });
  }

  private async reportCommitted(
    view: FlowRunView,
    run: OwnedRun,
    worktree: FlowWorktree,
  ): Promise<void> {
    const release = this.queue.hold();
    try {
      const committed = this.deps.flowWorktrees.commitAll(
        worktree,
        `Apply ${view.flowId} flow changes`,
      );
      run.committed = committed;
      const note = await committed
        .then(() => null)
        .catch((error: unknown) => {
          console.error(`failed to commit flow run ${view.runId}`, error);
          return `${COMMIT_FAILED_MESSAGE}: ${errorText(error)}`;
        });
      this.queue.enqueue({ view, note });
    } finally {
      release();
    }
  }

  private async teardown(): Promise<void> {
    const { server, grant, orchestration } = this.binding;
    orchestration.ended = true;
    server.revoke(grant.token);
    this.unsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });
    this.queue.dispose();
    this.onEnded();
    const open = [...orchestration.runs.keys()].filter((runId) =>
      this.deps.flowRuns.isOpen(runId),
    );
    await Promise.all(open.map((runId) => this.stopRun(runId)));
  }

  private async stopRun(runId: string): Promise<void> {
    try {
      await this.deps.flowRuns.stop(runId);
    } catch (error) {
      console.error(`failed to stop flow run ${runId}`, error);
    }
  }
}

class OrchestratorServiceImpl implements OrchestratorService {
  private readonly deps: OrchestratorServiceDeps;
  private server: Promise<FlowToolServer> | null = null;
  private current: ActiveOrchestration | null = null;

  constructor(deps: OrchestratorServiceDeps) {
    this.deps = deps;
  }

  async start(params: ParamsMap["session/start"]): Promise<SessionView> {
    const tools = await this.toolServer();
    const orchestration: Orchestration = {
      cwd: null,
      runs: new Map(),
      sessionId: null,
      ended: false,
    };
    const grant = tools.register(
      createOrchestratorFlowControl(this.deps, orchestration),
    );
    const view = await this.launch(tools, grant, params);
    orchestration.cwd = view.cwd;
    orchestration.sessionId = view.id;
    const previous = this.current;
    const next: ActiveOrchestration = new ActiveOrchestration(
      this.deps,
      { server: tools, grant, orchestration, sessionId: view.id },
      () => {
        if (this.current === next) {
          this.current = null;
        }
      },
    );
    this.current = next;
    next.watchSession(this.deps.main.view());
    await previous?.end();
    return view;
  }

  async shutdown(): Promise<void> {
    await this.current?.end();
    const starting = this.server;
    this.server = null;
    const started = await starting?.catch((error: unknown) => {
      console.error("the flow tool server never started", error);
      return null;
    });
    await started?.close();
  }

  private async toolServer(): Promise<FlowToolServer> {
    const starting = (this.server ??= (
      this.deps.startToolServer ?? startFlowToolServer
    )());
    try {
      return await starting;
    } catch (error) {
      if (this.server === starting) {
        this.server = null;
      }
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        `${ORCHESTRATE_UNAVAILABLE_PREFIX}: ${errorText(error)}`,
      );
    }
  }

  private async launch(
    tools: FlowToolServer,
    grant: ToolGrant,
    params: ParamsMap["session/start"],
  ): Promise<SessionView> {
    try {
      return await this.deps.main.start(
        { ...params, profile: PermissionProfile.plan },
        {
          leaseMode: LeaseMode.observer,
          tools: grant,
          preamble: ORCHESTRATOR_INSTRUCTIONS,
        },
      );
    } catch (error) {
      tools.revoke(grant.token);
      throw error;
    }
  }
}

export function createOrchestratorService(
  deps: OrchestratorServiceDeps,
): OrchestratorService {
  return new OrchestratorServiceImpl(deps);
}
