import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FlowRunStatus } from "../../domain/flowRun";
import { FlowPlacement } from "../../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../../shared/protocol";
import type { SessionView } from "../../shared/views";
import { settled } from "../../../tests/fakes/settle";
import { SAMPLE_FLOWS } from "../../../tests/fakes/fakeFlowControl";
import {
  FakeRuns,
  FakeWorktrees,
  repositoryDeps,
  sessionView,
} from "../../../tests/fakes/fakeOrchestration";
import type { FlowControl } from "../flowTools/control";
import type { FlowToolServer, ToolGrant } from "../flowTools/server";
import { LeaseMode } from "../locks";
import type { SessionService, StartOptions } from "../session";

import { createOrchestratorService, type OrchestratorService } from "./service";

const CWD = "/work/project";
const START_PARAMS: ParamsMap["session/start"] = {
  cwd: CWD,
  orchestrate: true,
};
const WORKTREE_REQUEST = {
  flowId: "review",
  task: "Fix it",
  placement: FlowPlacement.worktree,
};
const IN_PLACE_REQUEST = {
  ...WORKTREE_REQUEST,
  placement: FlowPlacement.inPlace,
};

class FakeMain implements SessionService {
  readonly starts: {
    params: ParamsMap["session/start"];
    options?: StartOptions;
  }[] = [];
  readonly prompts: string[] = [];
  readonly listeners = new Set<(view: SessionView | null) => void>();
  startError: Error | null = null;
  settled = true;
  sessionId = "sess-1";
  shown: SessionView | null = sessionView({ id: this.sessionId });
  readonly resolveFolder: (requested: string | undefined) => Promise<string>;

  constructor(
    resolveFolder: (requested: string | undefined) => Promise<string>,
  ) {
    this.resolveFolder = resolveFolder;
  }

  async start(
    params: ParamsMap["session/start"],
    options?: StartOptions,
  ): Promise<SessionView> {
    this.starts.push(options === undefined ? { params } : { params, options });
    const cwd = await this.resolveFolder(params.cwd);
    if (this.startError !== null) {
      throw this.startError;
    }
    return sessionView({ id: this.sessionId, cwd });
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    return Promise.resolve();
  }

  compact(): Promise<void> {
    return Promise.resolve();
  }

  onViewChanged(listener: (view: SessionView | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isSettled(): boolean {
    return this.settled;
  }

  emit(view: SessionView | null): void {
    this.listeners.forEach((listener) => {
      listener(view);
    });
  }

  view(): SessionView | null {
    return this.shown;
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  answerPermission(): void {
    return undefined;
  }

  isInUse(): boolean {
    return false;
  }

  ownRuntimeOf(): null {
    return null;
  }

  onRuntimeChanged(): () => void {
    return () => undefined;
  }

  isLive(): boolean {
    return true;
  }

  setAccounts(): void {
    return undefined;
  }

  nativeSessions(): [] {
    return [];
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeToolServer implements FlowToolServer {
  readonly url = "http://127.0.0.1:41234/mcp";
  readonly controls = new Map<string, FlowControl>();
  readonly revoked: string[] = [];
  closes = 0;

  register(control: FlowControl): ToolGrant {
    const token = `tok-${String(this.controls.size + 1)}`;
    this.controls.set(token, control);
    return { token, server: "codeweave", url: this.url, toolNames: [] };
  }

  revoke(token: string): void {
    this.revoked.push(token);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }

  control(token: string): FlowControl {
    const control = this.controls.get(token);
    if (control === undefined) {
      throw new Error(`no control registered for ${token}`);
    }
    return control;
  }
}

interface Rig {
  readonly service: OrchestratorService;
  readonly main: FakeMain;
  readonly mains: FakeMain[];
  readonly discarded: SessionService[];
  readonly runs: FakeRuns;
  readonly worktrees: FakeWorktrees;
  readonly server: FakeToolServer;
  readonly serverStarts: () => number;
  readonly listedCwds: (string | undefined)[];
}

function openRig(
  startToolServer?: () => Promise<FlowToolServer>,
  resolveFolder: (requested: string | undefined) => Promise<string> = (
    requested,
  ) => Promise.resolve(requested ?? CWD),
): Rig {
  const main = new FakeMain(resolveFolder);
  const mains: FakeMain[] = [];
  const discarded: SessionService[] = [];
  const runs = new FakeRuns();
  const worktrees = new FakeWorktrees();
  const server = new FakeToolServer();
  let starts = 0;
  let counter = 0;
  const listedCwds: (string | undefined)[] = [];
  const service = createOrchestratorService({
    sessions: {
      createMain: () => {
        if (mains.length === 0) {
          mains.push(main);
          return main;
        }
        const extra = new FakeMain(resolveFolder);
        extra.sessionId = `sess-${String(mains.length + 1)}`;
        extra.shown = sessionView({ id: extra.sessionId });
        mains.push(extra);
        return extra;
      },
      discardMain: (session) => {
        discarded.push(session);
        return Promise.resolve();
      },
      settleEnded: () => Promise.resolve(),
    },
    flowRuns: runs,
    flowWorktrees: worktrees,
    ...repositoryDeps(),
    listFlows: (cwd) => {
      listedCwds.push(cwd);
      return Promise.resolve(SAMPLE_FLOWS);
    },
    newRunId: () => {
      counter += 1;
      return `run-${String(counter)}`;
    },
    startToolServer:
      startToolServer ??
      (() => {
        starts += 1;
        return Promise.resolve(server);
      }),
  });
  return {
    service,
    main,
    mains,
    discarded,
    runs,
    worktrees,
    server,
    serverStarts: () => starts,
    listedCwds,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("starts_the_main_session_with_the_plan_profile_an_observer_lease_and_the_tools", async () => {
  const rig = openRig();

  await rig.service.start(START_PARAMS);

  expect(rig.main.starts).toHaveLength(1);
  const [call] = rig.main.starts;
  expect(call?.params).toEqual({
    cwd: CWD,
    orchestrate: true,
    profile: "plan",
  });
  expect(call?.options).toMatchObject({
    leaseMode: LeaseMode.observer,
    tools: { token: "tok-1", server: "codeweave" },
  });
  expect(call?.options?.preamble).toContain(
    "You are the Codeweave orchestrator.",
  );
});

const RESOLVED_CWD = "/home/user/workspace";

it("orchestrate_start_without_a_folder_uses_the_resolved_folder", async () => {
  const rig = openRig(undefined, () => Promise.resolve(RESOLVED_CWD));

  await rig.service.start({ orchestrate: true });
  await rig.server.control("tok-1").listFlows();

  expect(rig.main.starts.map((call) => call.params.cwd)).toEqual([undefined]);
  expect(rig.listedCwds).toEqual([RESOLVED_CWD]);
});

it("orchestrate_start_with_an_unresolvable_folder_fails_and_revokes_the_tools", async () => {
  const rig = openRig(undefined, () =>
    Promise.reject(new IpcError(IpcErrorCode.VALIDATION, "no folder")),
  );

  await expect(rig.service.start({ orchestrate: true })).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
  });

  expect(rig.server.revoked).toEqual(["tok-1"]);
});

it("orchestrate-start-reserves-slot-before-folder-resolution", async () => {
  const gate = Promise.withResolvers<string>();
  const rig = openRig(undefined, () => gate.promise);

  const starting = rig.service.start({ orchestrate: true });
  await settled(() => {
    expect(rig.main.starts).toHaveLength(1);
  });

  gate.resolve(RESOLVED_CWD);
  await starting;
});

it("ends_the_orchestration_when_the_session_view_id_changes", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const control = rig.server.control("tok-1");
  const { runId } = await control.startFlow(IN_PLACE_REQUEST);

  rig.main.emit(sessionView({ id: "sess-2" }));
  await vi.waitFor(() => {
    expect(rig.runs.stopped).toEqual([runId]);
  });
  rig.main.emit(null);

  expect(rig.server.revoked).toEqual(["tok-1"]);
  expect(rig.runs.stopped).toEqual([runId]);
  expect(rig.main.listeners.size).toBe(0);
  expect(rig.runs.listeners.size).toBe(0);
});

it("ends_the_orchestration_when_the_view_is_null_or_the_session_stopped_or_failed", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  rig.main.emit(null);
  expect(rig.server.revoked).toEqual(["tok-1"]);

  const stopped = openRig();
  await stopped.service.start(START_PARAMS);
  stopped.main.emit(sessionView({ id: "sess-1", phase: { phase: "stopped" } }));
  expect(stopped.server.revoked).toEqual(["tok-1"]);

  const failed = openRig();
  await failed.service.start(START_PARAMS);
  failed.main.emit(
    sessionView({
      id: "sess-1",
      phase: { phase: "failed", reason: "exited", runningAccountId: null },
    }),
  );
  expect(failed.server.revoked).toEqual(["tok-1"]);
});

it("ends_the_orchestration_when_the_session_stopped_before_it_subscribed", async () => {
  const rig = openRig();
  rig.main.shown = sessionView({
    id: "sess-1",
    phase: { phase: "stopped" },
  });

  await rig.service.start(START_PARAMS);

  expect(rig.server.revoked).toEqual(["tok-1"]);
  expect(rig.main.listeners.size).toBe(0);
  expect(rig.runs.listeners.size).toBe(0);
});

it("ends_the_orchestration_when_the_session_was_replaced_before_it_subscribed", async () => {
  const rig = openRig();
  rig.main.shown = sessionView({ id: "sess-2" });

  await rig.service.start(START_PARAMS);

  expect(rig.server.revoked).toEqual(["tok-1"]);
});

it("keeps_the_previous_orchestration_when_a_second_one_starts", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const { runId } = await rig.server
    .control("tok-1")
    .startFlow(IN_PLACE_REQUEST);

  await rig.service.start(START_PARAMS);

  expect(rig.runs.stopped).toEqual([]);
  expect(rig.server.revoked).toEqual([]);
  expect(rig.mains).toHaveLength(2);
  expect(runId).toBe("run-1");
});

it("keeps_the_orchestration_while_halted", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);

  rig.main.emit(sessionView({ id: "sess-1", phase: { phase: "halted" } }));
  rig.main.emit(sessionView({ id: "sess-1" }));

  expect(rig.server.revoked).toEqual([]);
  expect(rig.main.listeners.size).toBeGreaterThan(0);
});

it("revokes_the_grant_when_the_session_fails_to_start", async () => {
  const rig = openRig();
  rig.main.startError = new IpcError(
    IpcErrorCode.CONFLICT,
    "No usable account",
  );

  await expect(rig.service.start(START_PARAMS)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No usable account",
  });

  expect(rig.server.revoked).toEqual(["tok-1"]);
  expect(rig.main.listeners.size).toBe(0);
  expect(rig.runs.listeners.size).toBe(0);
});

it("retries_the_tool_server_after_a_bind_failure", async () => {
  const server = new FakeToolServer();
  let attempts = 0;
  const rig = openRig(() => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error("address in use"))
      : Promise.resolve(server);
  });

  await expect(rig.service.start(START_PARAMS)).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: "Orchestrate is unavailable: address in use",
  });
  expect(rig.main.starts).toHaveLength(0);
  await rig.service.start(START_PARAMS);
  rig.main.emit(null);
  await rig.service.start(START_PARAMS);

  expect(attempts).toBe(2);
  expect(server.controls.size).toBe(2);
});

it("commits_a_done_worktree_run_before_reporting_it", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const { runId } = await rig.server
    .control("tok-1")
    .startFlow(WORKTREE_REQUEST);
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.commitGate = gate.promise;

  rig.runs.finish(runId, FlowRunStatus.done);

  expect(rig.worktrees.log).toContain(
    `commit:${runId}:Apply review flow changes`,
  );
  expect(rig.main.prompts).toEqual([]);
  gate.resolve(undefined);
  await vi.waitFor(() => {
    expect(rig.main.prompts).toHaveLength(1);
  });
  expect(rig.main.prompts[0]).toContain("[Codeweave]");
  expect(rig.main.prompts[0]).toContain(`Run ${runId}`);
  expect(rig.main.prompts[0]).not.toContain("Note:");
});

it("holds_other_reports_while_a_done_worktree_run_is_committing", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const control = rig.server.control("tok-1");
  const worktreeRun = await control.startFlow(WORKTREE_REQUEST);
  const inPlaceRun = await control.startFlow(IN_PLACE_REQUEST);
  const gate = Promise.withResolvers<undefined>();
  rig.worktrees.commitGate = gate.promise;

  rig.runs.finish(worktreeRun.runId, FlowRunStatus.done);
  rig.runs.finish(inPlaceRun.runId, FlowRunStatus.awaitingDecision);

  expect(rig.main.prompts).toEqual([]);
  gate.resolve(undefined);
  await vi.waitFor(() => {
    expect(rig.main.prompts).toHaveLength(1);
  });
  expect(rig.main.prompts[0]).toContain(`Run ${worktreeRun.runId}`);
  expect(rig.main.prompts[0]).toContain(`Run ${inPlaceRun.runId}`);
});

it("puts_the_commit_failure_into_the_report", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const { runId } = await rig.server
    .control("tok-1")
    .startFlow(WORKTREE_REQUEST);
  rig.worktrees.commitError = new Error("pre-commit hook failed");

  rig.runs.finish(runId, FlowRunStatus.done);

  await vi.waitFor(() => {
    expect(rig.main.prompts).toHaveLength(1);
  });
  expect(rig.main.prompts[0]).toContain(
    "Note: Committing the flow changes failed: pre-commit hook failed",
  );
});

it("reports_in_place_runs_that_wait_or_end_without_committing", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const { runId } = await rig.server
    .control("tok-1")
    .startFlow(IN_PLACE_REQUEST);

  rig.runs.finish(runId, FlowRunStatus.awaitingDecision);

  expect(rig.main.prompts).toHaveLength(1);
  expect(rig.main.prompts[0]).toContain("awaiting_decision");
  expect(rig.worktrees.log.some((entry) => entry.startsWith("commit"))).toBe(
    false,
  );
});

it("ignores_flow_changes_of_runs_it_does_not_own_and_of_running_runs", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const { runId } = await rig.server
    .control("tok-1")
    .startFlow(IN_PLACE_REQUEST);

  rig.runs.finish("foreign-run", FlowRunStatus.done);
  rig.runs.finish(runId, FlowRunStatus.running);

  expect(rig.main.prompts).toEqual([]);
});

it("shutdown_ends_the_orchestration_and_closes_the_server_once", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const { runId } = await rig.server
    .control("tok-1")
    .startFlow(IN_PLACE_REQUEST);

  await rig.service.shutdown();
  await rig.service.shutdown();

  expect(rig.server.revoked).toEqual(["tok-1"]);
  expect(rig.runs.stopped).toEqual([runId]);
  expect(rig.server.closes).toBe(1);
});

it("shutdown_without_an_orchestrate_start_never_starts_the_server", async () => {
  const rig = openRig();

  await rig.service.shutdown();

  expect(rig.serverStarts()).toBe(0);
});

it("logs_a_failing_run_stop_and_still_stops_the_others", async () => {
  const rig = openRig();
  await rig.service.start(START_PARAMS);
  const control = rig.server.control("tok-1");
  const first = await control.startFlow(IN_PLACE_REQUEST);
  rig.runs.open.delete(first.runId);
  const second = await control.startFlow(IN_PLACE_REQUEST);
  rig.runs.open.add(first.runId);
  rig.runs.stopError = new Error("stop refused");

  rig.main.emit(null);

  await vi.waitFor(() => {
    expect(rig.runs.stopped.toSorted()).toEqual(
      [first.runId, second.runId].toSorted(),
    );
  });
  await vi.waitFor(() => {
    expect(console.error).toHaveBeenCalled();
  });
});
