import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ERROR_KIND_AUTH_REQUIRED,
  ERROR_KIND_RATE_LIMIT,
} from "../../domain/constants";
import type { AgentEvent } from "../../domain/events";
import type { PermissionProfile } from "../../domain/types";
import {
  AgentStartFailure,
  TurnInProgressError,
  UnknownPermissionError,
  type AgentAdapter,
  type AgentHandle,
  type AgentStartResult,
  type AgentStartSpec,
  type TurnOptions,
} from "../agentAdapter";
import type { AgentProcesses } from "../agentProcesses";
import {
  AGENT_STOP_GRACE_MS,
  PROBE_RUN_ID_PREFIX,
  PROBE_TIMEOUT_MS,
  PROCESS_EXITED_MESSAGE,
  STDERR_TAIL_CHARS,
} from "../constants";
import {
  STOP_REASON_CANCELLED,
  STOP_REASON_END_TURN,
} from "../codex/constants";
import { withTimeout } from "../codex/handshake";
import type { ProcessContainer, StopResult } from "../process/container";

import {
  AGY_ERROR_PREFIX,
  AGY_SNAPSHOT_DIR_PREFIX,
  AUTH_REQUIRED_STDERR_PREFIX,
  AgyEventName,
  AgyStepState,
  EXIT_DRAIN_MS,
  NEEDS_LOGIN_MESSAGE,
  PREVIOUS_PROCESS_NOT_STOPPED_MESSAGE,
  PROBE_NOT_STOPPED_MESSAGE,
  START_PROBE_TIMEOUT_MS,
  STOP_SETTLE_FACTOR,
  TOOLS_NOT_SUPPORTED_MESSAGE,
  WORKSPACE_CONFIG_CHANGED_MESSAGE,
} from "./constants";
import { TurnTracker, isEditStep, stepId, type TurnOutcome } from "./events";
import { agyTurnLine, buildAgyLaunch } from "./launch";
import { ListenerSet, type Listener } from "./listeners";
import { agySettingsFor } from "./permissions";
import {
  attachProcess,
  type LiveProcess,
  type ProcessHandlers,
} from "./process";
import {
  parseAgyErrorLine,
  parseAgyEvent,
  type AgyResult,
  type StepUpdate,
} from "./protocol";
import { clearSnapshots, discardStepSnapshot } from "./snapshots";
import { stepDiffsOf } from "./stepDiffs";
import {
  probeAgyUsage,
  toAgyRateLimitEvent,
  type AgyLimits,
  type AgyProbeDeps,
} from "./usage";
import { WorkspaceConfigChangedError } from "./workspaceGuard";

export interface AgyAdapterDeps {
  readonly processes: AgentProcesses;
  readonly container: ProcessContainer;
  readonly envFor: (spec: AgentStartSpec) => Record<string, string>;
  readonly executableFor: (spec: AgentStartSpec) => string;
  readonly writeHookConfig: (configDir: string) => Promise<void>;
  readonly fingerprintWorkspace: (worktreeRoot: string) => Promise<string>;
  readonly stopGraceMs?: number;
  readonly startProbeTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
}

interface ActiveTurn {
  readonly tracker: TurnTracker;
  readonly finished: PromiseWithResolvers<AgentEvent[]>;
  process: LiveProcess | null;
  settling: boolean;
  resultPending: boolean;
  cancelRequested: boolean;
}

interface ConversationResultError {
  readonly conversationId: string | null;
  readonly text: string | undefined;
}

type Prepared =
  { readonly live: LiveProcess } | { readonly events: AgentEvent[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnError(errorKind: string | null, message: string): AgentEvent {
  return { type: "turn_error", errorKind, rpcCode: null, message };
}

function exitedEvents(message: string): AgentEvent[] {
  return [turnError(null, message), { type: "process_exit" }];
}

function newTurn(): ActiveTurn {
  return {
    tracker: new TurnTracker(),
    finished: Promise.withResolvers<AgentEvent[]>(),
    process: null,
    settling: false,
    resultPending: false,
    cancelRequested: false,
  };
}

class AgySession implements AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  private readonly deps: AgyAdapterDeps;
  private readonly spec: AgentStartSpec;
  private readonly graceMs: number;
  private readonly probeTimeoutMs: number;
  private readonly listeners: ListenerSet;
  private readonly handlers: ProcessHandlers;
  private profile: PermissionProfile;
  private model: string | null = null;
  private live: LiveProcess | null = null;
  private spawning: Promise<LiveProcess> | null = null;
  private conversationId: string | null = null;
  private workspaceFingerprint: string | null = null;
  private workspaceChanged = false;
  private resultError: ConversationResultError = {
    conversationId: null,
    text: undefined,
  };
  private limits: AgyLimits | null;
  private limitsAnnounced = false;
  private stderrText = "";
  private stopping = false;
  private turn: ActiveTurn | null = null;

  constructor(
    deps: AgyAdapterDeps,
    spec: AgentStartSpec,
    limits: AgyLimits | null,
  ) {
    this.deps = deps;
    this.spec = spec;
    this.accountId = spec.account.id;
    this.runId = spec.runId;
    this.listeners = new ListenerSet(spec.runId);
    this.profile = spec.profile;
    this.limits = limits;
    this.graceMs = deps.stopGraceMs ?? AGENT_STOP_GRACE_MS;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.handlers = {
      onStdoutLine: (live, line) => {
        this.onStdoutLine(live, line);
      },
      onStderrLine: (live, line) => {
        this.onStderrLine(live, line);
      },
      onExit: (live) => {
        this.onExit(live);
      },
    };
  }

  async launch(): Promise<void> {
    await this.spawnProcess();
  }

  subscribe(listener: Listener): () => void {
    return this.listeners.add(listener);
  }

  async prompt(text: string, options: TurnOptions): Promise<void> {
    const turn = this.beginTurn();
    this.model = options.model;
    this.announceLimits();
    const events = await this.drive(text, turn).catch((error: unknown) => {
      console.error(`agy turn failed: ${this.runId}`, error);
      return [turnError(null, messageOf(error))];
    });
    this.turn = null;
    events.forEach((event) => {
      this.emit(event);
    });
  }

  private beginTurn(): ActiveTurn {
    if (this.turn !== null) {
      throw new TurnInProgressError(this.runId);
    }
    this.turn = newTurn();
    return this.turn;
  }

  answerPermission(requestId: string): void {
    throw new UnknownPermissionError(requestId);
  }

  setProfile(profile: PermissionProfile): Promise<void> {
    this.profile = profile;
    return Promise.resolve();
  }

  async cancel(): Promise<void> {
    const live = this.live;
    if (this.turn === null) {
      return;
    }
    this.turn.cancelRequested = true;
    if (live === null || live.exited) {
      return;
    }
    live.planned = true;
    await live.agentProcess.stop(this.graceMs).catch((error: unknown) => {
      console.error(`cancel failed to stop agy: ${this.runId}`, error);
    });
  }

  async stop(graceMs: number): Promise<StopResult> {
    this.stopping = true;
    await this.spawning?.catch((error: unknown) => {
      console.warn(`agy spawn failed during stop: ${this.runId}`, error);
    });
    const live = this.live;
    if (live === null) {
      return { ok: true };
    }
    live.planned = true;
    return live.agentProcess.stop(graceMs);
  }

  private async drive(text: string, turn: ActiveTurn): Promise<AgentEvent[]> {
    const prepared = await this.prepare(turn);
    if ("events" in prepared) {
      return prepared.events;
    }
    const { live } = prepared;
    if (this.workspaceChanged && live.planned) {
      return [turnError(null, WORKSPACE_CONFIG_CHANGED_MESSAGE)];
    }
    if (live.exited) {
      return exitedEvents(PROCESS_EXITED_MESSAGE);
    }
    turn.process = live;
    this.announceModel(live);
    live.agentProcess.contained.stdin.write(agyTurnLine(text));
    return turn.finished.promise;
  }

  private announceModel(live: LiveProcess): void {
    if (live.model !== null) {
      this.emit({ type: "model", model: live.model });
    }
  }

  private async prepare(turn: ActiveTurn): Promise<Prepared> {
    const previous = this.live;
    if (
      previous !== null &&
      !previous.exited &&
      !previous.planned &&
      previous.profile === this.profile &&
      previous.model === this.model
    ) {
      return { live: previous };
    }
    if (this.stopping) {
      return { events: exitedEvents(PROCESS_EXITED_MESSAGE) };
    }
    if (previous !== null) {
      previous.planned = true;
      if (!(await this.stoppedCleanly(previous))) {
        return {
          events: exitedEvents(PREVIOUS_PROCESS_NOT_STOPPED_MESSAGE),
        };
      }
    }
    if (this.mustDiscard(turn)) {
      return { events: await this.abortedEvents(turn) };
    }
    const live = await this.spawnProcess();
    if (this.mustDiscard(turn)) {
      await this.discard(live);
      return { events: await this.abortedEvents(turn) };
    }
    return { live };
  }

  private mustDiscard(turn: ActiveTurn): boolean {
    return this.stopping || turn.cancelRequested;
  }

  private async discard(live: LiveProcess): Promise<void> {
    live.planned = true;
    await live.agentProcess.stop(this.graceMs).catch((error: unknown) => {
      console.error(`stopping a discarded agy failed: ${this.runId}`, error);
    });
  }

  private abortedEvents(turn: ActiveTurn): Promise<AgentEvent[]> {
    return turn.cancelRequested
      ? this.eventsFor({ kind: "cancelled" })
      : Promise.resolve(exitedEvents(PROCESS_EXITED_MESSAGE));
  }

  private async stoppedCleanly(previous: LiveProcess): Promise<boolean> {
    const grace = previous.exited ? 0 : this.graceMs;
    try {
      const result = await withTimeout(
        previous.agentProcess.stop(grace),
        this.graceMs * STOP_SETTLE_FACTOR,
      );
      return result.ok && !this.stopping;
    } catch (error) {
      console.warn(`previous agy process did not stop: ${this.runId}`, error);
      return false;
    }
  }

  private spawnProcess(): Promise<LiveProcess> {
    const spawning = this.startProcess().finally(() => {
      if (this.spawning === spawning) {
        this.spawning = null;
      }
    });
    this.spawning = spawning;
    return spawning;
  }

  private async guardWorkspaceConfig(): Promise<void> {
    const current = await this.deps.fingerprintWorkspace(this.spec.cwd);
    this.workspaceFingerprint ??= current;
    if (current !== this.workspaceFingerprint) {
      throw new WorkspaceConfigChangedError();
    }
  }

  private async startProcess(): Promise<LiveProcess> {
    const profile = this.profile;
    const model = this.model;
    await this.deps.writeHookConfig(this.spec.account.configDir);
    const snapshotDir = await mkdtemp(join(tmpdir(), AGY_SNAPSHOT_DIR_PREFIX));
    try {
      return await this.startInto(profile, model, snapshotDir);
    } catch (error) {
      await this.removeSnapshotDir(snapshotDir);
      throw error;
    }
  }

  private async startInto(
    profile: PermissionProfile,
    model: string | null,
    snapshotDir: string,
  ): Promise<LiveProcess> {
    const launch = buildAgyLaunch({
      executable: this.deps.executableFor(this.spec),
      env: this.deps.envFor(this.spec),
      permissions: agySettingsFor(profile),
      conversationId: this.conversationId,
      configDir: this.spec.account.configDir,
      profile,
      model,
      worktreeRoot: this.spec.cwd,
      snapshotDir,
    });
    await this.guardWorkspaceConfig();
    const agentProcess = await this.deps.processes.start({
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd: this.spec.cwd,
      runId: this.runId,
    });
    this.live = attachProcess(
      agentProcess,
      profile,
      model,
      this.runId,
      snapshotDir,
      this.handlers,
    );
    return this.live;
  }

  private async removeSnapshotDir(snapshotDir: string): Promise<void> {
    await rm(snapshotDir, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.error(
          `removing the agy snapshot dir failed: ${this.runId}`,
          error,
        );
      },
    );
  }

  private chainDiffWork(live: LiveProcess, work: () => Promise<void>): void {
    live.diffWork = live.diffWork.then(work).catch((error: unknown) => {
      console.error(`agy diff work failed: ${this.runId}`, error);
    });
  }

  private trackEdit(live: LiveProcess, step: StepUpdate): void {
    const conversationId = step.conversation_id ?? this.conversationId ?? "";
    if (step.state === AgyStepState.done) {
      this.chainDiffWork(live, () =>
        this.emitDiffs(live, step, conversationId),
      );
    } else if (step.state === AgyStepState.error) {
      this.chainDiffWork(live, () =>
        discardStepSnapshot(live.snapshotDir, conversationId, step.step_index),
      );
    }
  }

  private async emitDiffs(
    live: LiveProcess,
    step: StepUpdate,
    conversationId: string,
  ): Promise<void> {
    const diffs = await stepDiffsOf({
      dir: live.snapshotDir,
      cwd: this.spec.cwd,
      conversationId,
      stepIdx: step.step_index,
    });
    if (diffs.length > 0) {
      this.emit({
        type: "tool_call_update",
        toolCallId: stepId(step, conversationId),
        diffs,
      });
    }
  }

  private async settleDiffs(live: LiveProcess | null): Promise<void> {
    if (live === null) {
      return;
    }
    await live.diffWork;
    await clearSnapshots(live.snapshotDir).catch((error: unknown) => {
      console.error(`clearing agy snapshots failed: ${this.runId}`, error);
    });
  }

  private async verifyWorkspaceAfterInit(live: LiveProcess): Promise<void> {
    try {
      await this.guardWorkspaceConfig();
      return;
    } catch (error) {
      console.error(`agy workspace config check failed: ${this.runId}`, error);
    }
    this.workspaceChanged = true;
    const turn = this.turnOf(live);
    if (turn !== null) {
      turn.settling = true;
    }
    live.planned = true;
    await live.agentProcess.stop(this.graceMs).catch((error: unknown) => {
      console.error(
        `stopping agy after config change failed: ${this.runId}`,
        error,
      );
    });
    turn?.finished.resolve([turnError(null, WORKSPACE_CONFIG_CHANGED_MESSAGE)]);
  }

  private turnOf(live: LiveProcess): ActiveTurn | null {
    const turn = this.turn;
    return turn !== null && turn.process === live && !turn.settling
      ? turn
      : null;
  }

  private rememberConversation(conversationId: string | undefined): void {
    if (conversationId !== undefined && conversationId !== "") {
      this.conversationId = conversationId;
    }
  }

  private onStdoutLine(live: LiveProcess, line: string): void {
    const event = parseAgyEvent(line);
    switch (event?.event) {
      case AgyEventName.init:
        this.rememberConversation(event.conversation_id);
        live.initCheck = this.verifyWorkspaceAfterInit(live);
        return;
      case AgyEventName.stepUpdate:
        this.onStep(live, event.step_update);
        return;
      case AgyEventName.result:
        this.onResult(live, event.result);
        return;
      default:
        return;
    }
  }

  private onStep(live: LiveProcess, step: StepUpdate): void {
    this.rememberConversation(step.conversation_id);
    const turn = this.turnOf(live);
    if (turn === null) {
      return;
    }
    turn.tracker
      .observeStep(step, this.conversationId ?? "")
      .forEach((event) => {
        this.emit(event);
      });
    if (isEditStep(step)) {
      this.trackEdit(live, step);
    }
  }

  private onResult(live: LiveProcess, result: AgyResult): void {
    this.rememberConversation(result.conversation_id);
    const turn = this.turnOf(live);
    const previousError = this.swapResultError(result);
    if (turn !== null && !turn.resultPending) {
      void this.settleResult(turn, live, result, previousError);
    }
  }

  private swapResultError(result: AgyResult): string | undefined {
    const previous =
      this.resultError.conversationId === this.conversationId
        ? this.resultError.text
        : undefined;
    this.resultError = {
      conversationId: this.conversationId,
      text: result.error ?? previous,
    };
    return previous;
  }

  private async turnOpenAfterInitCheck(
    turn: ActiveTurn,
    live: LiveProcess,
  ): Promise<boolean> {
    await live.initCheck;
    return !turn.settling;
  }

  private async settleResult(
    turn: ActiveTurn,
    live: LiveProcess,
    result: AgyResult,
    previousError: string | undefined,
  ): Promise<void> {
    turn.resultPending = true;
    if (!(await this.turnOpenAfterInitCheck(turn, live))) {
      return;
    }
    if (turn.tracker.awaitsErrorLine(result)) {
      await withTimeout(
        Promise.race([turn.tracker.errorLineSeen, live.stderrClosed]),
        EXIT_DRAIN_MS,
      ).catch((error: unknown) => {
        console.warn(`agy error line did not follow: ${this.runId}`, error);
      });
      if (turn.settling) {
        return;
      }
      if (live.planned) {
        await this.complete(turn, { kind: "cancelled" });
        return;
      }
    }
    await this.complete(turn, turn.tracker.settle(result, previousError));
  }

  private onStderrLine(live: LiveProcess, line: string): void {
    this.stderrText = `${this.stderrText}${line}\n`.slice(-STDERR_TAIL_CHARS);
    const turn = this.turnOf(live);
    if (turn === null) {
      return;
    }
    if (line.startsWith(AGY_ERROR_PREFIX)) {
      const parsed = parseAgyErrorLine(line.slice(AGY_ERROR_PREFIX.length));
      if (parsed !== null) {
        turn.tracker.observeErrorLine(parsed);
      }
    } else if (line.startsWith(AUTH_REQUIRED_STDERR_PREFIX)) {
      live.planned = true;
      void live.agentProcess.stop(this.graceMs).catch((error: unknown) => {
        console.error(
          `stopping agy after auth failure failed: ${this.runId}`,
          error,
        );
      });
      void this.complete(turn, { kind: "auth", message: NEEDS_LOGIN_MESSAGE });
    }
  }

  private onExit(live: LiveProcess): void {
    void this.removeSnapshotDirAfterDrain(live);
    const turn = this.turnOf(live);
    if (turn === null) {
      if (!live.planned) {
        console.warn(`agy exited unexpectedly: ${this.runId}`, this.stderrText);
      }
      return;
    }
    void this.settleAfterExit(turn, live);
  }

  private async removeSnapshotDirAfterDrain(live: LiveProcess): Promise<void> {
    await withTimeout(live.stdoutClosed, EXIT_DRAIN_MS).catch(
      (error: unknown) => {
        console.warn(
          `agy output did not close before snapshot cleanup: ${this.runId}`,
          error,
        );
      },
    );
    await live.diffWork;
    await this.removeSnapshotDir(live.snapshotDir);
  }

  private async settleAfterExit(
    turn: ActiveTurn,
    live: LiveProcess,
  ): Promise<void> {
    await withTimeout(live.stdoutClosed, EXIT_DRAIN_MS).catch(
      (error: unknown) => {
        console.warn(
          `agy output did not close after exit: ${this.runId}`,
          error,
        );
      },
    );
    if (turn.settling || turn.resultPending) {
      return;
    }
    if (live.planned) {
      await this.complete(turn, { kind: "cancelled" });
      return;
    }
    const failure = turn.tracker.failure();
    if (failure !== null) {
      await this.complete(turn, failure);
      return;
    }
    turn.settling = true;
    turn.finished.resolve(exitedEvents(PROCESS_EXITED_MESSAGE));
  }

  private async complete(
    turn: ActiveTurn,
    outcome: TurnOutcome,
  ): Promise<void> {
    turn.settling = true;
    await this.settleDiffs(turn.process);
    turn.finished.resolve(await this.eventsFor(outcome));
  }

  private async eventsFor(outcome: TurnOutcome): Promise<AgentEvent[]> {
    switch (outcome.kind) {
      case "ended":
        return [{ type: "turn_end", stopReason: STOP_REASON_END_TURN }];
      case "cancelled":
        return [{ type: "turn_end", stopReason: STOP_REASON_CANCELLED }];
      case "quota":
        return [
          await this.exhaustionEvent(),
          turnError(ERROR_KIND_RATE_LIMIT, outcome.message),
        ];
      case "auth":
        return [turnError(ERROR_KIND_AUTH_REQUIRED, outcome.message)];
      case "failed":
        return [turnError(null, outcome.message)];
    }
  }

  private async exhaustionEvent(): Promise<AgentEvent> {
    const probe = await probeAgyUsage(this.probeDeps(this.probeTimeoutMs));
    if (probe.kind === "unstopped") {
      console.warn(`${PROBE_NOT_STOPPED_MESSAGE}: ${this.runId}`);
    }
    const limits = probe.kind === "limits" ? probe.limits : null;
    this.limits = limits;
    this.limitsAnnounced = true;
    return toAgyRateLimitEvent(limits, true) ?? { type: "api_retry" };
  }

  private probeDeps(timeoutMs: number): AgyProbeDeps {
    return probeDepsFor(this.deps, this.spec, timeoutMs);
  }

  private announceLimits(): void {
    if (this.limitsAnnounced) {
      return;
    }
    this.limitsAnnounced = true;
    const event =
      this.limits === null ? null : toAgyRateLimitEvent(this.limits);
    if (event !== null) {
      this.emit(event);
    }
  }

  private emit(event: AgentEvent): void {
    this.listeners.emit(event);
  }
}

function probeDepsFor(
  deps: AgyAdapterDeps,
  spec: AgentStartSpec,
  timeoutMs: number,
): AgyProbeDeps {
  const runId = `${PROBE_RUN_ID_PREFIX}${randomUUID()}`;
  const probeSpec: AgentStartSpec = { ...spec, runId };
  return {
    container: deps.container,
    executable: deps.executableFor(probeSpec),
    configDir: spec.account.configDir,
    cwd: spec.account.configDir,
    env: deps.envFor(probeSpec),
    runId,
    timeoutMs,
    stopGraceMs: deps.stopGraceMs ?? AGENT_STOP_GRACE_MS,
  };
}

export function createAgyAdapter(deps: AgyAdapterDeps): AgentAdapter {
  return {
    async start(spec: AgentStartSpec): Promise<AgentStartResult> {
      if (spec.tools !== undefined) {
        return {
          ok: false,
          reason: AgentStartFailure.error,
          message: TOOLS_NOT_SUPPORTED_MESSAGE,
        };
      }
      const probe = await probeAgyUsage(
        probeDepsFor(
          deps,
          spec,
          deps.startProbeTimeoutMs ?? START_PROBE_TIMEOUT_MS,
        ),
      );
      if (probe.kind === "needs_login") {
        return {
          ok: false,
          reason: AgentStartFailure.needsLogin,
          message: NEEDS_LOGIN_MESSAGE,
        };
      }
      if (probe.kind === "unstopped") {
        return {
          ok: false,
          reason: AgentStartFailure.error,
          message: PROBE_NOT_STOPPED_MESSAGE,
        };
      }
      const session = new AgySession(
        deps,
        spec,
        probe.kind === "limits" ? probe.limits : null,
      );
      try {
        await session.launch();
      } catch (error) {
        return {
          ok: false,
          reason: AgentStartFailure.error,
          message: messageOf(error),
        };
      }
      return { ok: true, handle: session };
    },
  };
}
