import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { vi } from "vitest";
import { z } from "zod";

import type {
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
} from "../../src/backend/agentAdapter";
import { createAgentProcesses } from "../../src/backend/agentProcesses";
import { createAgyAdapter } from "../../src/backend/agy/adapter";
import { writeAgyHookConfig } from "../../src/backend/agy/hookConfig";
import { runHook } from "../../src/backend/agy/hookRun";
import { fingerprintAgentsDir } from "../../src/backend/agy/workspaceGuard";
import { buildAgentEnv } from "../../src/backend/env";
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
  PermissionProfile,
  ProviderId,
  type Account,
} from "../../src/domain/types";

import { FakeContained, unsupportedLaunch } from "./fakeContainer";

export type Json = Readonly<Record<string, unknown>>;

export type AgyStep =
  | { readonly type: "out"; readonly value: Json }
  | { readonly type: "raw_out"; readonly text: string }
  | { readonly type: "err"; readonly text: string }
  | { readonly type: "await_signal" }
  | { readonly type: "delay"; readonly ms: number }
  | { readonly type: "hang" }
  | { readonly type: "hook"; readonly payload: Json }
  | {
      readonly type: "write_file";
      readonly path: string;
      readonly content: string;
    }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "exit_notice"; readonly code: number }
  | { readonly type: "close_streams" }
  | { readonly type: "await_release" };

export type UsageScript =
  | { readonly kind: "ok"; readonly groups: readonly Json[] }
  | { readonly kind: "logged_out" }
  | { readonly kind: "auth_error_json" }
  | { readonly kind: "garbage" }
  | { readonly kind: "hang" };

export interface ProcessScript {
  readonly stopResults?: readonly StopResult[];
  readonly holdStops?: boolean;
  readonly spawnGate?: Promise<undefined>;
  readonly exitGate?: Promise<undefined>;
}

export interface AgySpawn {
  readonly spec: SpawnSpec;
  readonly contained: FakeAgyContained;
  readonly probe: boolean;
  readonly settings: Json | null;
  readonly mode: string | null;
  readonly model: string | null;
  readonly conversation: string | null;
  readonly geminiDir: string | null;
  readonly configFilesAtSpawn: readonly string[];
  readonly hooksJsonAtSpawn: string | null;
  readonly stdinLines: string[];
  readonly agyRunningAtSpawn: number;
}

const SettingsArgSchema = z.record(z.string(), z.unknown());
const UserLineSchema = z.object({
  event: z.string(),
  message: z.object({ role: z.string(), content: z.string() }),
});
const FLAG_SETTINGS = "--settings";
const FLAG_MODE = "--mode";
const FLAG_MODEL = "--model";
const FLAG_CONVERSATION = "--conversation";
const FLAG_PROMPT = "-p";
const FLAG_GEMINI_DIR_PREFIX = "--gemini_dir=";
const HOOK_CONFIG_DIR = "config";
const HOOKS_JSON = "hooks.json";
const USAGE_PROMPT = "/usage";
const LOGGED_OUT_STDERR = [
  "Authentication required. Please visit the URL to log in:",
  "  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fake",
  "",
  "Waiting for authentication (timeout 60s)...",
];
const INIT_TOOLS: readonly string[] = ["run_command", "write_file"];
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
};

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export class FakeAgyContained extends FakeContained {
  readonly signalled = Promise.withResolvers<undefined>();
  readonly released = Promise.withResolvers<undefined>();
  readonly hookOutputs: string[] = [];
  hasExited = false;
  private exitNotified = false;
  private readonly exitGate: Promise<undefined> | undefined;

  constructor(
    runId: string,
    stopResults: readonly StopResult[],
    exitGate?: Promise<undefined>,
  ) {
    super(runId, stopResults);
    this.exitGate = exitGate;
  }

  override async stop(graceMs: number): Promise<StopResult> {
    this.signalled.resolve(undefined);
    const result = await super.stop(graceMs);
    if (result.ok) {
      await this.exitGate;
      await tick();
      if (!this.exitNotified) {
        this.exit(null);
      }
    }
    return result;
  }

  exit(code: number | null): void {
    if (this.hasExited) {
      return;
    }
    this.hasExited = true;
    this.stdout.end();
    this.stderr.end();
    this.notifyExit(code);
  }

  notifyExit(code: number | null): void {
    if (this.exitNotified) {
      return;
    }
    this.exitNotified = true;
    this.emitExit(code);
  }

  closeStreams(): void {
    this.hasExited = true;
    this.stdout.end();
    this.stderr.end();
  }
}

function lineOf(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function out(value: Json): AgyStep {
  return { type: "out", value };
}

export function rawOut(text: string): AgyStep {
  return { type: "raw_out", text };
}

export function err(text: string): AgyStep {
  return { type: "err", text };
}

export function delayFor(ms: number): AgyStep {
  return { type: "delay", ms };
}

export function hookStep(
  ref: StepRef,
  tool: ToolRef,
  workspace: string,
): AgyStep {
  return {
    type: "hook",
    payload: {
      conversationId: ref.conversationId,
      stepIdx: ref.index,
      toolCall: { name: tool.name, args: tool.parameters },
      workspacePaths: [workspace],
    },
  };
}

export function writeFileStep(path: string, content: string): AgyStep {
  return { type: "write_file", path, content };
}

export const AWAIT_SIGNAL: AgyStep = { type: "await_signal" };
export const HANG: AgyStep = { type: "hang" };

export function exitWith(code: number): AgyStep {
  return { type: "exit", code };
}

export function exitNotice(code: number): AgyStep {
  return { type: "exit_notice", code };
}

export const AWAIT_RELEASE: AgyStep = { type: "await_release" };
export const CLOSE_STREAMS: AgyStep = { type: "close_streams" };

export function initStep(conversationId: string): AgyStep {
  return out({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: "/work/repo",
      tools: INIT_TOOLS,
      permission_mode: "request-review",
    },
  });
}

export interface StepRef {
  readonly conversationId: string;
  readonly index: number;
}

export function at(conversationId: string, index: number): StepRef {
  return { conversationId, index };
}

export interface ToolRef {
  readonly name: string;
  readonly parameters: Json;
  readonly detail?: Json;
}

export function stepUpdate(
  ref: StepRef,
  state: string,
  stepType: string,
  extra: Json = {},
): AgyStep {
  return out({
    event: "step_update",
    step_update: {
      conversation_id: ref.conversationId,
      step_index: ref.index,
      state,
      step_type: stepType,
      ...extra,
    },
  });
}

export function userInputStep(ref: StepRef): AgyStep {
  return stepUpdate(ref, "DONE", "user_input");
}

export function textDeltaStep(ref: StepRef, text: string): AgyStep {
  return stepUpdate(ref, "ACTIVE", "agent_response", { text_delta: text });
}

export function responseDoneStep(ref: StepRef): AgyStep {
  return stepUpdate(ref, "DONE", "agent_response", {
    duration_seconds: 1.5,
    usage: { ...ZERO_USAGE, input_tokens: 6900, output_tokens: 14 },
  });
}

export function toolStep(
  ref: StepRef,
  state: "ACTIVE" | "DONE" | "ERROR",
  tool: ToolRef,
): AgyStep {
  return stepUpdate(ref, state, "tool", {
    tool_name: tool.name,
    ...(state === "ACTIVE" ? {} : { duration_seconds: 0.04 }),
    tool_info: {
      name: tool.name,
      parameters: tool.parameters,
      ...tool.detail,
    },
  });
}

export function errorMessageStep(ref: StepRef): AgyStep {
  return stepUpdate(ref, "DONE", "error_message");
}

export interface ResultFields {
  readonly status: "SUCCESS" | "ERROR";
  readonly response?: string;
  readonly error?: string;
  readonly finishedReason?: string;
  readonly deniedActions?: readonly Json[];
}

export function resultStep(
  conversationId: string,
  fields: ResultFields,
): AgyStep {
  return out({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: fields.status,
      response: fields.response ?? "",
      ...(fields.error === undefined ? {} : { error: fields.error }),
      duration_seconds: 1.9,
      num_turns: 1,
      usage: ZERO_USAGE,
      ...(fields.finishedReason === undefined
        ? {}
        : { finished_reason: fields.finishedReason }),
      ...(fields.deniedActions === undefined
        ? {}
        : { denied_actions: fields.deniedActions }),
    },
  });
}

export function replyTurn(
  conversationId: string,
  text: string,
): readonly AgyStep[] {
  return [
    initStep(conversationId),
    userInputStep(at(conversationId, 0)),
    textDeltaStep(at(conversationId, 1), text),
    responseDoneStep(at(conversationId, 1)),
    resultStep(conversationId, { status: "SUCCESS", response: text }),
  ];
}

export const QUOTA_ERROR_TEXT =
  "agent executor error: generating and executing: Error 429, Message: You exceeded your current quota, Status: RESOURCE_EXHAUSTED";

export function agyErrorStep(
  shortError: string,
  status: string,
  errorCode = 429,
): AgyStep {
  return err(
    `AGY_ERROR: ${JSON.stringify({
      short_error: shortError,
      status,
      error_code: errorCode,
      code_kind: "http",
      retryable: true,
      error_id: "e-1",
    })}`,
  );
}

export function quotaFailureTurn(
  conversationId: string,
  withResult = true,
): readonly AgyStep[] {
  return [
    initStep(conversationId),
    userInputStep(at(conversationId, 0)),
    errorMessageStep(at(conversationId, 1)),
    agyErrorStep(QUOTA_ERROR_TEXT, "RESOURCE_EXHAUSTED"),
    ...(withResult
      ? [
          resultStep(conversationId, {
            status: "ERROR",
            error: QUOTA_ERROR_TEXT,
            finishedReason: "error",
          }),
        ]
      : []),
    exitWith(3),
  ];
}

export function usageBucket(
  id: string,
  window: string,
  remainingFraction: number,
  resetTime: string,
): Json {
  return {
    id,
    name: `${window} limit`,
    window,
    remaining_fraction: remainingFraction,
    reset_time: resetTime,
  };
}

export function usageGroup(name: string, buckets: readonly Json[]): Json {
  return { name, description: `Models within ${name}`, buckets };
}

export const OPEN_GEMINI_GROUPS: readonly Json[] = [
  usageGroup("Gemini Models", [
    usageBucket("gemini-weekly", "weekly", 0.75, "2026-11-02T10:21:22Z"),
    usageBucket("gemini-5h", "5h", 0.5, "2026-10-30T12:54:36Z"),
  ]),
];

function usageOutput(groups: readonly Json[]): Json {
  return {
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    duration_seconds: 0,
    num_turns: 0,
    usage: ZERO_USAGE,
    command: { name: "usage", data: { description: "limits", groups } },
  };
}

const AUTH_ERROR_OUTPUT: Json = {
  conversation_id: "",
  status: "ERROR",
  response: "",
  error: "authentication failed or timed out",
  duration_seconds: 0,
  num_turns: 0,
  usage: ZERO_USAGE,
  finished_reason: "error",
};

function isUserLine(line: string): boolean {
  const parsed = UserLineSchema.parse(JSON.parse(line));
  return parsed.event === "user" && parsed.message.role === "user";
}

function valueAfter(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index < 0 ? null : (args[index + 1] ?? null);
}

function geminiDirOf(args: readonly string[]): string | null {
  const flag = args.find((arg) => arg.startsWith(FLAG_GEMINI_DIR_PREFIX));
  return flag === undefined ? null : flag.slice(FLAG_GEMINI_DIR_PREFIX.length);
}

function configFilesIn(geminiDir: string | null): string[] {
  const dir = geminiDir === null ? null : join(geminiDir, HOOK_CONFIG_DIR);
  return dir !== null && existsSync(dir) ? readdirSync(dir).sort() : [];
}

function hooksJsonIn(geminiDir: string | null): string | null {
  const file =
    geminiDir === null ? null : join(geminiDir, HOOK_CONFIG_DIR, HOOKS_JSON);
  return file !== null && existsSync(file) ? readFileSync(file, "utf8") : null;
}

function settingsOf(args: readonly string[]): Json | null {
  const raw = valueAfter(args, FLAG_SETTINGS);
  return raw === null ? null : SettingsArgSchema.parse(JSON.parse(raw));
}

async function runSteps(
  contained: FakeAgyContained,
  steps: readonly AgyStep[],
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  for (const step of steps) {
    if (contained.hasExited) {
      return;
    }
    switch (step.type) {
      case "out":
        contained.stdout.write(lineOf(step.value));
        break;
      case "raw_out":
        contained.stdout.write(`${step.text}\n`);
        break;
      case "err":
        contained.stderr.write(`${step.text}\n`);
        break;
      case "await_signal":
        await contained.signalled.promise;
        break;
      case "delay":
        await new Promise<void>((resolve) => {
          setTimeout(resolve, step.ms);
        });
        break;
      case "hang":
        await new Promise<never>(() => undefined);
        break;
      case "hook":
        await runHook({
          readInput: () => Promise.resolve(JSON.stringify(step.payload)),
          env,
          write: (line) => {
            contained.hookOutputs.push(line);
          },
        });
        break;
      case "write_file":
        await mkdir(dirname(step.path), { recursive: true });
        await writeFile(step.path, step.content);
        break;
      case "exit":
        contained.exit(step.code);
        return;
      case "exit_notice":
        contained.notifyExit(step.code);
        break;
      case "await_release":
        await contained.released.promise;
        break;
      case "close_streams":
        contained.closeStreams();
        return;
    }
  }
}

async function serveUsage(
  contained: FakeAgyContained,
  script: UsageScript,
): Promise<void> {
  switch (script.kind) {
    case "ok":
      await runSteps(contained, [out(usageOutput(script.groups)), exitWith(0)]);
      return;
    case "logged_out":
      await runSteps(contained, [
        ...LOGGED_OUT_STDERR.map(err),
        AWAIT_SIGNAL,
        exitWith(1),
      ]);
      return;
    case "auth_error_json":
      await runSteps(contained, [out(AUTH_ERROR_OUTPUT), exitWith(1)]);
      return;
    case "garbage":
      await runSteps(contained, [rawOut("not json at all"), exitWith(0)]);
      return;
    case "hang":
      await runSteps(contained, [HANG]);
      return;
  }
}

export class ScriptedAgyContainer implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  readonly launch = unsupportedLaunch;
  readonly spawns: AgySpawn[] = [];
  spawnFailure: Error | null = null;
  private gatedSpawnCount = 0;
  private readonly turnScripts: (readonly AgyStep[])[] = [];
  private readonly usageScripts: UsageScript[] = [];
  private readonly processScripts: ProcessScript[] = [];
  private readonly probeProcessScripts: ProcessScript[] = [];
  private defaultUsage: UsageScript = {
    kind: "ok",
    groups: OPEN_GEMINI_GROUPS,
  };

  scriptTurn(steps: readonly AgyStep[]): void {
    this.turnScripts.push(steps);
  }

  scriptUsage(script: UsageScript): void {
    this.usageScripts.push(script);
  }

  scriptProbeProcess(script: ProcessScript): void {
    this.probeProcessScripts.push(script);
  }

  scriptProcess(script: ProcessScript): void {
    this.processScripts.push(script);
  }

  agySpawns(): AgySpawn[] {
    return this.spawns.filter((spawn) => !spawn.probe);
  }

  probeSpawns(): AgySpawn[] {
    return this.spawns.filter((spawn) => spawn.probe);
  }

  runningCount(): number {
    return this.spawns.filter((spawn) => !spawn.contained.hasExited).length;
  }

  gatedSpawns(): number {
    return this.gatedSpawnCount;
  }

  spawn(spec: SpawnSpec): Promise<Contained> {
    if (this.spawnFailure !== null) {
      return Promise.reject(this.spawnFailure);
    }
    const probe = spec.args[0] === FLAG_PROMPT && spec.args[1] === USAGE_PROMPT;
    const processScript = (
      probe ? this.probeProcessScripts : this.processScripts
    ).shift();
    const gate = processScript?.spawnGate;
    if (gate === undefined) {
      return Promise.resolve(this.create(spec, probe, processScript));
    }
    this.gatedSpawnCount += 1;
    return gate.then(() => this.create(spec, probe, processScript));
  }

  sweepOrphans(): Promise<number> {
    return Promise.resolve(0);
  }

  private create(
    spec: SpawnSpec,
    probe: boolean,
    processScript: ProcessScript | undefined,
  ): Contained {
    const contained = new FakeAgyContained(
      spec.runId,
      processScript?.stopResults ?? [],
      processScript?.exitGate,
    );
    if (processScript?.holdStops === true) {
      contained.holdStops();
    }
    const geminiDir = geminiDirOf(spec.args);
    const spawned: AgySpawn = {
      spec,
      contained,
      probe,
      settings: settingsOf(spec.args),
      mode: valueAfter(spec.args, FLAG_MODE),
      model: valueAfter(spec.args, FLAG_MODEL),
      conversation: valueAfter(spec.args, FLAG_CONVERSATION),
      geminiDir,
      configFilesAtSpawn: configFilesIn(geminiDir),
      hooksJsonAtSpawn: hooksJsonIn(geminiDir),
      stdinLines: [],
      agyRunningAtSpawn: this.agySpawns().filter(
        (earlier) => !earlier.contained.hasExited,
      ).length,
    };
    this.spawns.push(spawned);
    if (probe) {
      void serveUsage(
        contained,
        this.usageScripts.shift() ?? this.defaultUsage,
      );
    } else {
      this.serveTurns(spawned);
    }
    return contained;
  }

  private serveTurns(spawned: AgySpawn): void {
    let chain: Promise<void> = Promise.resolve();
    createInterface({ input: spawned.contained.stdin }).on("line", (line) => {
      spawned.stdinLines.push(line);
      if (!isUserLine(line)) {
        return;
      }
      const steps = this.turnScripts.shift();
      if (steps === undefined) {
        throw new Error(`no script for the turn: ${line}`);
      }
      chain = chain.then(() =>
        runSteps(spawned.contained, steps, spawned.spec.env),
      );
    });
  }
}

export const AGY_RIG_ACCOUNT: Account = {
  id: "acc-agy",
  provider: ProviderId.gemini,
  label: "Gemini",
  configDir: "/home/jane/.gemini",
  order: 0,
};
export const AGY_RIG_EXECUTABLE = "/home/jane/.local/bin/agy";
export const AGY_RIG_GRACE_MS = 25;
export const AGY_RIG_START_PROBE_TIMEOUT_MS = 150;
export const AGY_RIG_PROBE_TIMEOUT_MS = 300;
export const AGY_RIG_PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HTTPS_PROXY: "http://proxy.corp:3128",
  AGY_TOKEN_FILE: "/tmp/token",
  ANTIGRAVITY_HOME: "/elsewhere",
  GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9",
};

const rigDirs: string[] = [];

export async function removeAgyRigDirs(): Promise<void> {
  await Promise.all(
    rigDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export const AGY_RIG_HOOK_EXEC_PATH = "/opt/Codeweave/codeweave";
export const AGY_RIG_HOOK_ENTRY =
  "/opt/Codeweave/resources/app.asar.unpacked/out/main/agyHook.js";

export interface HookConfigWrite {
  readonly configDir: string;
  readonly spawnsBefore: number;
}

export interface AgyRig {
  readonly container: ScriptedAgyContainer;
  readonly cwd: string;
  readonly configDir: string;
  readonly hookWrites: HookConfigWrite[];
  start(profile?: PermissionProfile, runId?: string): Promise<AgentStartResult>;
}

export function agySpecFor(
  cwd: string,
  profile: PermissionProfile,
  runId: string,
  account: Account = AGY_RIG_ACCOUNT,
): AgentStartSpec {
  return {
    account,
    cwd,
    profile,
    runId,
    executable: AGY_RIG_EXECUTABLE,
  };
}

export interface AgyRigOptions {
  readonly fingerprintWorkspace?: (worktreeRoot: string) => Promise<string>;
}

export async function createAgyRig(
  options: AgyRigOptions = {},
): Promise<AgyRig> {
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-agy-"));
  const configDir = await mkdtemp(join(tmpdir(), "codeweave-agy-acct-"));
  rigDirs.push(cwd, configDir);
  const account: Account = { ...AGY_RIG_ACCOUNT, configDir };
  const container = new ScriptedAgyContainer();
  const hookWrites: HookConfigWrite[] = [];
  const adapter = createAgyAdapter({
    writeHookConfig: async (dir) => {
      hookWrites.push({
        configDir: dir,
        spawnsBefore: container.agySpawns().length,
      });
      await writeAgyHookConfig({
        configDir: dir,
        execPath: AGY_RIG_HOOK_EXEC_PATH,
        hookEntry: AGY_RIG_HOOK_ENTRY,
        platform: "linux",
      });
    },
    fingerprintWorkspace: options.fingerprintWorkspace ?? fingerprintAgentsDir,
    processes: createAgentProcesses({ container, locks: new WorktreeLocks() }),
    container,
    envFor: (spec) =>
      buildAgentEnv({
        parent: AGY_RIG_PARENT_ENV,
        platform: "linux",
        homeDir: "/home/jane",
        account: spec.account,
        executable: spec.executable,
        runMarker: spec.runId,
        testMode: false,
      }),
    executableFor: (spec) => spec.executable,
    stopGraceMs: AGY_RIG_GRACE_MS,
    startProbeTimeoutMs: AGY_RIG_START_PROBE_TIMEOUT_MS,
    probeTimeoutMs: AGY_RIG_PROBE_TIMEOUT_MS,
  });
  return {
    container,
    cwd,
    configDir,
    hookWrites,
    start: (profile = PermissionProfile.ask, runId = "run-1") =>
      adapter.start(agySpecFor(cwd, profile, runId, account)),
  };
}

export async function startAgyHandle(
  rig: AgyRig,
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

export interface StartedAgy {
  readonly rig: AgyRig;
  readonly handle: AgentHandle;
  readonly events: AgentEvent[];
}

export async function startedAgy(script?: ProcessScript): Promise<StartedAgy> {
  const rig = await createAgyRig();
  if (script !== undefined) {
    rig.container.scriptProcess(script);
  }
  const { handle, events } = await startAgyHandle(rig);
  return { rig, handle, events };
}

export function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

export function eventOfType<T extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }> | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: T }> => event.type === type,
  );
}

export function waitForEvent(
  events: readonly AgentEvent[],
  type: AgentEvent["type"],
): Promise<AgentEvent> {
  return vi.waitFor(() => {
    const found = events.find((event) => event.type === type);
    if (found === undefined) {
      throw new Error(`no ${type} event yet`);
    }
    return found;
  });
}
