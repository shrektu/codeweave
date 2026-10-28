import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { vi } from "vitest";
import { z } from "zod";

import type {
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
} from "../../src/backend/agentAdapter";
import { createAgentProcesses } from "../../src/backend/agentProcesses";
import { createCodexAdapter } from "../../src/backend/codex/adapter";
import { WorktreeLocks } from "../../src/backend/locks";
import {
  ContainerKind,
  type Contained,
  type ProcessContainer,
  type SpawnSpec,
  type StopResult,
} from "../../src/backend/process/container";
import type { AgentEvent } from "../../src/domain/events";
import {
  ProviderId,
  PermissionProfile,
  type Account,
} from "../../src/domain/types";

import { FakeContainer, type FakeContained } from "./fakeContainer";

export type Json = Readonly<Record<string, unknown>>;

export type RateLimitRead =
  | { readonly kind: "ok"; readonly response: Json }
  | { readonly kind: "hang" }
  | {
      readonly kind: "delayed";
      readonly delayMs: number;
      readonly response: Json;
    }
  | {
      readonly kind: "error";
      readonly code: number;
      readonly message: string;
    };

export interface FakeCodexConfig {
  loggedIn?: boolean;
  rateLimitReads?: readonly RateLimitRead[];
  stderrText?: string;
  threadStartError?: { code: number; message: string };
  turnStartError?: { code: number; message: string };
  turnStartHang?: boolean;
  interruptHang?: boolean;
}

export function settlesWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  const timer = Promise.withResolvers<boolean>();
  const handle = setTimeout(() => {
    timer.resolve(false);
  }, ms);
  return Promise.race([work.then(() => true), timer.promise]).finally(() => {
    clearTimeout(handle);
  });
}

export type TurnStatusName = "completed" | "interrupted" | "failed";

export type TurnStep =
  | { readonly type: "notify"; readonly method: string; readonly params: Json }
  | {
      readonly type: "approval";
      readonly method: string;
      readonly params: Json;
    }
  | {
      readonly type: "fail";
      readonly codexErrorInfo: unknown;
      readonly message: string;
    }
  | { readonly type: "complete"; readonly status: TurnStatusName }
  | { readonly type: "await_interrupt" }
  | { readonly type: "hang" }
  | { readonly type: "exit" };

export interface ReceivedMessage {
  readonly method: string;
  readonly params: unknown;
}

export interface ServerRequestAnswer {
  readonly id: number;
  readonly method: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

const THREAD_ID = "thr-1";
const FIRST_SERVER_REQUEST_ID = 1000;
const CODEX_HOME = "/home/jane/.codex-main";
const METHOD_NOT_FOUND = -32601;

const IncomingSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type Incoming = z.infer<typeof IncomingSchema>;

const DEFAULT_RATE_LIMIT_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(rateSnapshot(rateWindow(10, 300, null), null)),
};

export function rateWindow(
  usedPercent: number,
  windowDurationMins: number | null,
  resetsAt: number | null,
): Json {
  return { usedPercent, windowDurationMins, resetsAt };
}

export function rateSnapshot(
  primary: Json | null,
  secondary: Json | null,
  rateLimitReachedType: string | null = null,
): Json {
  return {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary,
    secondary,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType,
  };
}

export function rateLimitsResponse(
  rateLimits: Json,
  ordinaryUsageAllowed: boolean | null = true,
): Json {
  return {
    ordinaryUsageAllowed,
    rateLimits,
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  };
}

export function commandItem(
  id: string,
  command: string,
  status: string,
  aggregatedOutput: string | null = null,
): Json {
  return {
    type: "commandExecution",
    id,
    command,
    cwd: "/w",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput,
    exitCode: null,
    durationMs: null,
  };
}

export function fileChangeItem(
  id: string,
  paths: readonly string[],
  status: string,
): Json {
  return {
    type: "fileChange",
    id,
    status,
    changes: paths.map((path) => ({
      path,
      kind: { type: "update", move_path: null },
      diff: "",
    })),
  };
}

export function itemStarted(item: Json): TurnStep {
  return { type: "notify", method: "item/started", params: { item } };
}

export function itemCompleted(item: Json): TurnStep {
  return { type: "notify", method: "item/completed", params: { item } };
}

export function agentDelta(itemId: string, delta: string): TurnStep {
  return {
    type: "notify",
    method: "item/agentMessage/delta",
    params: { itemId, delta },
  };
}

export function commandApproval(itemId: string, command: string): TurnStep {
  return {
    type: "approval",
    method: "item/commandExecution/requestApproval",
    params: { itemId, command, startedAtMs: 1, kind: "command" },
  };
}

const DEFAULT_SCRIPT: readonly TurnStep[] = [
  { type: "complete", status: "completed" },
];

function turnPayload(id: string, status: string, error: Json | null): Json {
  return { id, status, items: [], error, itemsView: "full" };
}

export class FakeCodexAppServer {
  readonly received: ReceivedMessage[] = [];
  readonly rawLines: string[] = [];
  readonly answers: ServerRequestAnswer[] = [];
  readonly delayedReplies: Promise<void>[] = [];
  private readonly scripts: (readonly TurnStep[])[] = [];
  private readonly serverRequests = new Map<
    number,
    { method: string; resolve: () => void }
  >();
  private readonly config: FakeCodexConfig;
  private readonly contained: FakeContained;
  private rateReads = 0;
  private turnCount = 0;
  private nextServerId = FIRST_SERVER_REQUEST_ID;
  private interrupt = Promise.withResolvers<null>();

  constructor(contained: FakeContained, config: FakeCodexConfig) {
    this.config = config;
    this.contained = contained;
    createInterface({ input: contained.stdin }).on("line", (line) => {
      this.onLine(line);
    });
  }

  enqueue(steps: readonly TurnStep[]): void {
    this.scripts.push(steps);
  }

  methods(): string[] {
    return this.received.map((message) => message.method);
  }

  paramsOf(method: string): unknown[] {
    return this.received
      .filter((message) => message.method === method)
      .map((message) => message.params);
  }

  get currentTurnId(): string {
    return `turn-${String(this.turnCount)}`;
  }

  private send(message: Json): void {
    this.contained.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private reply(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  private replyError(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  private onLine(line: string): void {
    this.rawLines.push(line);
    const message = IncomingSchema.parse(JSON.parse(line));
    if (message.method === undefined) {
      this.onResponse(message);
      return;
    }
    this.received.push({ method: message.method, params: message.params });
    if (message.id !== undefined) {
      this.onRequest(message.id, message.method);
    }
  }

  private onResponse(message: Incoming): void {
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.serverRequests.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.serverRequests.delete(message.id);
    this.answers.push({
      id: message.id,
      method: pending.method,
      ...(message.result === undefined ? {} : { result: message.result }),
      ...(message.error === undefined ? {} : { error: message.error }),
    });
    pending.resolve();
  }

  private onRequest(id: number | string, method: string): void {
    switch (method) {
      case "initialize":
        this.reply(id, {
          userAgent: "codex/0.165.0",
          codexHome: CODEX_HOME,
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      case "account/read":
        this.reply(id, this.accountResponse());
        return;
      case "account/rateLimits/read":
        this.answerRateLimitRead(id);
        return;
      case "thread/start":
        if (this.config.stderrText !== undefined) {
          this.contained.stderr.write(this.config.stderrText);
        }
        if (this.config.threadStartError !== undefined) {
          const { code, message } = this.config.threadStartError;
          this.replyError(id, code, message);
          return;
        }
        this.reply(id, { thread: { id: THREAD_ID, status: { type: "idle" } } });
        return;
      case "turn/start":
        if (this.config.turnStartHang === true) {
          return;
        }
        if (this.config.turnStartError !== undefined) {
          const { code, message } = this.config.turnStartError;
          this.replyError(id, code, message);
          return;
        }
        this.startTurn(id);
        return;
      case "turn/interrupt":
        if (this.config.interruptHang === true) {
          return;
        }
        this.reply(id, {});
        this.interrupt.resolve(null);
        return;
      default:
        this.replyError(id, METHOD_NOT_FOUND, "Method not found");
    }
  }

  private accountResponse(): Json {
    if (this.config.loggedIn === false) {
      return { account: null, requiresOpenaiAuth: true };
    }
    return {
      account: { type: "chatgpt", email: "jane@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    };
  }

  private answerRateLimitRead(id: number | string): void {
    const reads = this.config.rateLimitReads ?? [DEFAULT_RATE_LIMIT_READ];
    const read =
      reads[Math.min(this.rateReads, reads.length - 1)] ??
      DEFAULT_RATE_LIMIT_READ;
    this.rateReads += 1;
    switch (read.kind) {
      case "ok":
        this.reply(id, read.response);
        return;
      case "error":
        this.replyError(id, read.code, read.message);
        return;
      case "delayed":
        this.delayedReplies.push(
          new Promise((resolve) => {
            setTimeout(() => {
              this.reply(id, read.response);
              resolve();
            }, read.delayMs);
          }),
        );
        return;
      case "hang":
        return;
    }
  }

  private startTurn(id: number | string): void {
    this.turnCount += 1;
    this.interrupt = Promise.withResolvers<null>();
    this.reply(id, {
      turn: turnPayload(this.currentTurnId, "inProgress", null),
    });
    const steps = this.scripts.shift() ?? DEFAULT_SCRIPT;
    void this.runScript(steps).catch((error: unknown) => {
      console.error("fake codex script failed", error);
    });
  }

  private async runScript(steps: readonly TurnStep[]): Promise<void> {
    for (const step of steps) {
      if (await this.runStep(step)) {
        return;
      }
    }
  }

  private completeTurn(status: TurnStatusName, error: Json | null): void {
    this.send({
      method: "turn/completed",
      params: {
        threadId: THREAD_ID,
        turn: turnPayload(this.currentTurnId, status, error),
      },
    });
  }

  private ids(params: Json): Json {
    return { threadId: THREAD_ID, turnId: this.currentTurnId, ...params };
  }

  private async runStep(step: TurnStep): Promise<boolean> {
    switch (step.type) {
      case "notify":
        this.send({ method: step.method, params: this.ids(step.params) });
        return false;
      case "approval": {
        const answered = await Promise.race([
          this.askClient(step.method, step.params).then(() => true),
          this.interrupt.promise.then(() => false),
        ]);
        if (!answered) {
          this.completeTurn("interrupted", null);
        }
        return !answered;
      }
      case "fail": {
        const error = {
          message: step.message,
          codexErrorInfo: step.codexErrorInfo,
          additionalDetails: null,
        };
        this.send({
          method: "error",
          params: this.ids({ error, willRetry: false }),
        });
        this.completeTurn("failed", error);
        return true;
      }
      case "complete":
        this.completeTurn(step.status, null);
        return true;
      case "await_interrupt":
        await this.interrupt.promise;
        this.completeTurn("interrupted", null);
        return true;
      case "hang":
        await new Promise<never>(() => undefined);
        return true;
      case "exit":
        this.contained.emitExit(1);
        return true;
    }
  }

  private askClient(method: string, params: Json): Promise<void> {
    const id = this.nextServerId;
    this.nextServerId += 1;
    const answered = Promise.withResolvers<undefined>();
    this.serverRequests.set(id, {
      method,
      resolve: () => {
        answered.resolve(undefined);
      },
    });
    this.send({ method, id, params: this.ids(params) });
    return answered.promise;
  }

  askServerRequest(method: string, params: Json): Promise<void> {
    return this.askClient(method, params);
  }
}

export class ScriptedCodexContainer implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  readonly specs: SpawnSpec[] = [];
  readonly servers: FakeCodexAppServer[] = [];
  readonly contained: FakeContained[] = [];
  readonly config: FakeCodexConfig = {};
  private readonly inner: FakeContainer;
  private readonly nextScripts: (readonly TurnStep[])[] = [];

  constructor(stopResults: readonly StopResult[] = []) {
    this.inner = new FakeContainer(stopResults);
  }

  scriptNext(steps: readonly TurnStep[]): void {
    this.nextScripts.push(steps);
  }

  async spawn(spec: SpawnSpec): Promise<Contained> {
    const spawned = await this.inner.spawn(spec);
    const fake = this.inner.spawned[this.inner.spawned.length - 1];
    if (fake === undefined) {
      throw new Error("fake container did not record the spawn");
    }
    this.specs.push(spec);
    this.contained.push(fake);
    const server = new FakeCodexAppServer(fake, this.config);
    const steps = this.nextScripts.shift();
    if (steps !== undefined) {
      server.enqueue(steps);
    }
    this.servers.push(server);
    return spawned;
  }

  sweepOrphans(): Promise<number> {
    return this.inner.sweepOrphans();
  }
}

export const CODEX_RIG_ACCOUNT: Account = {
  id: "acc-codex",
  provider: ProviderId.codex,
  label: "Codex",
  configDir: CODEX_HOME,
  order: 0,
};
export const CODEX_RIG_EXECUTABLE = "/usr/bin/codex";
export const CODEX_RIG_GRACE_MS = 25;
export const CODEX_RIG_RATE_READ_TIMEOUT_MS = 300;

const rigDirs: string[] = [];

export async function removeCodexRigDirs(): Promise<void> {
  await Promise.all(
    rigDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export interface CodexRig {
  readonly container: ScriptedCodexContainer;
  readonly cwd: string;
  start(profile?: PermissionProfile, runId?: string): Promise<AgentStartResult>;
}

export interface CodexRigLaunch {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
}

export async function createCodexRig(
  stopResults: readonly StopResult[] = [],
  launch: CodexRigLaunch = {
    platform: "linux",
    executable: CODEX_RIG_EXECUTABLE,
  },
): Promise<CodexRig> {
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-codex-"));
  rigDirs.push(cwd);
  const container = new ScriptedCodexContainer(stopResults);
  const adapter = createCodexAdapter({
    processes: rigProcesses(container),
    envFor: () => ({ PATH: "/usr/bin" }),
    executableFor: () => launch.executable,
    platform: launch.platform,
    stopGraceMs: CODEX_RIG_GRACE_MS,
    rateLimitReadTimeoutMs: CODEX_RIG_RATE_READ_TIMEOUT_MS,
  });
  return {
    container,
    cwd,
    start: (profile = PermissionProfile.ask, runId = "run-1") =>
      adapter.start(specFor(cwd, profile, runId)),
  };
}

export function specFor(
  cwd: string,
  profile: PermissionProfile,
  runId: string,
): AgentStartSpec {
  return {
    account: CODEX_RIG_ACCOUNT,
    cwd,
    profile,
    runId,
    executable: CODEX_RIG_EXECUTABLE,
  };
}

export function rigProcesses(
  container: ScriptedCodexContainer,
): ReturnType<typeof createAgentProcesses> {
  return createAgentProcesses({ container, locks: new WorktreeLocks() });
}

export async function startCodexHandle(
  rig: CodexRig,
  profile: PermissionProfile = PermissionProfile.ask,
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const result = await rig.start(profile);
  if (!result.ok) {
    throw new Error(`start failed: ${result.reason}: ${result.message}`);
  }
  const events: AgentEvent[] = [];
  result.handle.subscribe((event) => events.push(event));
  return { handle: result.handle, events };
}

export function serverOf(rig: CodexRig): FakeCodexAppServer {
  const server = rig.container.servers[0];
  if (server === undefined) {
    throw new Error("no app-server was spawned");
  }
  return server;
}

export function codexContainedOf(rig: CodexRig): FakeContained {
  const contained = rig.container.contained[0];
  if (contained === undefined) {
    throw new Error("no process was spawned");
  }
  return contained;
}

export async function codexPermissionRequestOf(
  events: readonly AgentEvent[],
): Promise<Extract<AgentEvent, { type: "permission_request" }>> {
  return vi.waitFor(() => {
    const found = events.find((event) => event.type === "permission_request");
    if (found === undefined) {
      throw new Error("no permission_request yet");
    }
    return found;
  });
}
