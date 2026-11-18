import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import type {
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
} from "../../src/backend/agentAdapter";
import { createOpencodeAdapter } from "../../src/backend/opencode/adapter";
import { findFreePort } from "../../src/backend/opencode/port";
import {
  OpencodeGeneration,
  type GenerationProbe,
} from "../../src/backend/opencode/version";
import type { OpencodeCredentials } from "../../src/backend/opencode/config";
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
  type ApiAccount,
} from "../../src/domain/types";

import { FakeContained, unsupportedLaunch } from "./fakeContainer";
import { rigProcesses } from "./rigProcesses";
import { settled } from "./settle";

export type Json = Readonly<Record<string, unknown>>;

export const OPENCODE_SESSION_ID = "ses_fake";
export const OPENCODE_RIG_PASSWORD = randomUUID();
export const OPENCODE_RIG_NOW_MS = 1_700_000_000_000;
export const OPENCODE_RIG_EXECUTABLE = "/usr/bin/opencode";
export const OPENCODE_RIG_GRACE_MS = 25;
export const OPENCODE_RIG_READY_TIMEOUT_MS = 400;
export const OPENCODE_RIG_REQUEST_TIMEOUT_MS = 150;
export const OPENCODE_RIG_WARM_UP_TIMEOUT_MS = 500;
export const OPENCODE_RIG_CREDENTIALS: OpencodeCredentials = {
  providerId: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  apiKey: "sk-test-A",
};

const REPLY_TIMEOUT_MS = 2000;
const PORT_ARG = "--port";
const CONFIG_ENV = "OPENCODE_CONFIG";
const PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
const PERMISSION_MASK = 0o777;
const FILE_REFERENCE = /^\{file:(.*)\}$/;
const PERMISSIONS_ROUTE = /^\/session\/([^/]+)\/permissions\/([^/]+)$/;
const MESSAGES_ROUTE = /^\/session\/([^/]+)\/message$/;
const MESSAGES_ROUTE_RESULT: Route = { kind: "messages" };
const SESSION_ROUTE = /^\/session\/([^/]+)\/(prompt_async|abort)$/;

export type ToolStepStatus = "pending" | "running" | "completed" | "error";

export type OpencodeStep =
  | {
      readonly type: "text";
      readonly partId: string;
      readonly text: string;
      readonly synthetic?: boolean;
    }
  | {
      readonly type: "child_session";
      readonly id: string;
      readonly parentId?: string;
    }
  | { readonly type: "wait"; readonly ms: number }
  | {
      readonly type: "tool";
      readonly callId: string;
      readonly tool: string;
      readonly status: ToolStepStatus;
      readonly input?: Json;
      readonly output?: string;
      readonly error?: string;
      readonly title?: string;
    }
  | {
      readonly type: "permission";
      readonly id: string;
      readonly permission: string;
      readonly patterns: readonly string[];
      readonly metadata: Json;
      readonly callId?: string;
      readonly sessionId?: string;
    }
  | { readonly type: "retry"; readonly next: number; readonly message: string }
  | {
      readonly type: "error";
      readonly name: string;
      readonly message: string;
      readonly statusCode?: number;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly type: "idle" }
  | { readonly type: "raw"; readonly event: Json }
  | { readonly type: "late_idle"; readonly afterPrompts: number }
  | { readonly type: "reject_prompt"; readonly message: string }
  | { readonly type: "slow_user_message"; readonly ms: number }
  | { readonly type: "wait_abort" }
  | { readonly type: "hang" };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorized: boolean;
}

export interface PermissionReply {
  readonly sessionId: string;
  readonly permissionId: string;
  readonly response: unknown;
}

const DEFAULT_SCRIPT: readonly OpencodeStep[] = [{ type: "idle" }];

function envelope(type: string, properties: Json): Json {
  return { type, properties };
}

function toolPart(
  step: Extract<OpencodeStep, { type: "tool" }>,
): Record<string, unknown> {
  return {
    type: "tool",
    id: `prt_${step.callId}`,
    sessionID: OPENCODE_SESSION_ID,
    messageID: "msg_1",
    callID: step.callId,
    tool: step.tool,
    state: {
      status: step.status,
      input: step.input ?? {},
      ...(step.output === undefined ? {} : { output: step.output }),
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.title === undefined ? {} : { title: step.title }),
      metadata: {},
    },
  };
}

type EventStep = Exclude<
  OpencodeStep,
  {
    type:
      | "permission"
      | "wait_abort"
      | "hang"
      | "wait"
      | "late_idle"
      | "reject_prompt"
      | "slow_user_message";
  }
>;

const ASSISTANT_MESSAGE_ID = "msg_1";
const USER_MESSAGE_DIGITS = 4;

export interface AssistantModel {
  readonly providerID: string;
  readonly modelID: string;
}

function messageUpdated(
  id: string,
  role: "user" | "assistant",
  model: AssistantModel | null = null,
): Json {
  return envelope("message.updated", {
    info: { id, role, sessionID: OPENCODE_SESSION_ID, ...model },
  });
}

function userTextEvent(messageId: string, text: string): Json {
  return envelope("message.part.updated", {
    part: {
      type: "text",
      id: `prt_${messageId}`,
      sessionID: OPENCODE_SESSION_ID,
      messageID: messageId,
      text,
    },
  });
}

const PromptBodySchema = z.looseObject({
  parts: z.array(z.looseObject({ text: z.string().optional() })),
});

function promptTextOf(body: unknown): string {
  const parsed = PromptBodySchema.safeParse(body);
  return parsed.success ? (parsed.data.parts[0]?.text ?? "") : "";
}

function errorEvent(step: Extract<EventStep, { type: "error" }>): Json {
  return envelope("session.error", {
    sessionID: OPENCODE_SESSION_ID,
    error: {
      name: step.name,
      data: {
        message: step.message,
        ...(step.statusCode === undefined
          ? {}
          : { statusCode: step.statusCode, isRetryable: true }),
        ...(step.headers === undefined
          ? {}
          : { responseHeaders: step.headers }),
      },
    },
  });
}

function eventFor(step: EventStep): Json {
  switch (step.type) {
    case "text":
      return envelope("message.part.updated", {
        part: {
          type: "text",
          id: step.partId,
          sessionID: OPENCODE_SESSION_ID,
          messageID: ASSISTANT_MESSAGE_ID,
          text: step.text,
          ...(step.synthetic === true ? { synthetic: true } : {}),
        },
      });
    case "child_session":
      return envelope("session.created", {
        info: {
          id: step.id,
          parentID: step.parentId ?? OPENCODE_SESSION_ID,
        },
      });
    case "tool":
      return envelope("message.part.updated", { part: toolPart(step) });
    case "retry":
      return envelope("session.status", {
        sessionID: OPENCODE_SESSION_ID,
        status: {
          type: "retry",
          attempt: 1,
          message: step.message,
          next: step.next,
        },
      });
    case "error":
      return errorEvent(step);
    case "idle":
      return envelope("session.idle", { sessionID: OPENCODE_SESSION_ID });
    case "raw":
      return step.event;
  }
}

type Route =
  | {
      readonly kind:
        | "config"
        | "providers"
        | "events"
        | "create"
        | "status"
        | "messages"
        | "unknown";
    }
  | { readonly kind: "prompt" | "abort" }
  | { readonly kind: "permission"; readonly match: RegExpExecArray };

const UNKNOWN_ROUTE: Route = { kind: "unknown" };
const GET_ROUTES = new Map<string, Route>([
  ["/config", { kind: "config" }],
  ["/config/providers", { kind: "providers" }],
  ["/event", { kind: "events" }],
  ["/session/status", { kind: "status" }],
]);

function postRouteOf(path: string): Route {
  const session = SESSION_ROUTE.exec(path);
  const permission = PERMISSIONS_ROUTE.exec(path);
  if (path === "/session") {
    return { kind: "create" };
  }
  if (session !== null) {
    return { kind: session[2] === "abort" ? "abort" : "prompt" };
  }
  return permission === null
    ? UNKNOWN_ROUTE
    : { kind: "permission", match: permission };
}

function routeOf(method: string, path: string): Route {
  if (method === "GET") {
    return MESSAGES_ROUTE.test(path)
      ? MESSAGES_ROUTE_RESULT
      : (GET_ROUTES.get(path) ?? UNKNOWN_ROUTE);
  }
  return method === "POST" ? postRouteOf(path) : UNKNOWN_ROUTE;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      resolve(text === "" ? null : (JSON.parse(text) as unknown));
    });
  });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export class FakeOpencodeServer {
  providers: unknown = { providers: [], default: {} };
  assistantModel: AssistantModel | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly replies: PermissionReply[] = [];
  private readonly scripts: (readonly OpencodeStep[])[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly replyWaiters = new Map<string, () => void>();
  private readonly replyListeners: (() => void)[] = [];
  private readonly http: Server;
  private readonly password: string;
  private abortHook: () => Promise<void> | void = () => undefined;
  private readonly aborted = Promise.withResolvers<undefined>();
  private readonly stalled = new Set<Route["kind"]>();
  private readonly delays = new Map<Route["kind"], number>();
  private silentPrompts = 0;
  private promptCount = 0;
  private sessionBusy = false;
  private latestUserMessageId: string | null = null;
  private promptArrivals: (() => void)[] = [];

  constructor(password: string) {
    this.password = password;
    this.http = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        console.error("fake opencode handler failed", error);
        response.writeHead(500).end();
      });
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(port, "127.0.0.1", resolve);
    });
  }

  close(): Promise<void> {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.http.closeAllConnections();
    return new Promise((resolve) => {
      this.http.close(() => {
        resolve();
      });
    });
  }

  enqueue(steps: readonly OpencodeStep[]): void {
    this.scripts.push(steps);
  }

  onAbort(hook: () => Promise<void> | void): void {
    this.abortHook = hook;
  }

  stall(kind: Route["kind"]): void {
    this.stalled.add(kind);
  }

  unstall(kind: Route["kind"]): void {
    this.stalled.delete(kind);
  }

  delay(kind: Route["kind"], ms: number): void {
    this.delays.set(kind, ms);
  }

  acceptNextPromptWithoutReply(): void {
    this.silentPrompts += 1;
  }

  emit(event: Json): void {
    this.emitRaw(JSON.stringify(event));
  }

  emitRaw(payload: string): void {
    for (const client of this.clients) {
      client.write(`data: ${payload}\n\n`);
    }
  }

  emitPermissionAsked(
    step: Extract<OpencodeStep, { type: "permission" }>,
  ): void {
    this.emit(
      envelope("permission.asked", {
        id: step.id,
        sessionID: step.sessionId ?? OPENCODE_SESSION_ID,
        permission: step.permission,
        patterns: step.patterns,
        metadata: step.metadata,
        always: step.patterns,
        tool: { messageID: "msg_1", callID: step.callId ?? `call_${step.id}` },
      }),
    );
  }

  nextReply(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("no permission reply arrived"));
      }, REPLY_TIMEOUT_MS);
      this.replyListeners.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  requestsTo(method: string, path: string): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method && request.path === path,
    );
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const body = await readBody(request);
    const expected = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    const authorized = request.headers.authorization === expected;
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorized,
    });
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    await this.route(method, url.pathname, body, response);
  }

  private async route(
    method: string,
    path: string,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    const route = routeOf(method, path);
    if (this.stalled.has(route.kind)) {
      return;
    }
    const delayMs = this.delays.get(route.kind);
    if (delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    switch (route.kind) {
      case "status":
        sendJson(
          response,
          this.sessionBusy ? { [OPENCODE_SESSION_ID]: { type: "busy" } } : {},
        );
        return;
      case "messages":
        sendJson(
          response,
          this.latestUserMessageId === null
            ? []
            : [
                {
                  info: { id: this.latestUserMessageId, role: "user" },
                  parts: [],
                },
              ],
        );
        return;
      case "config":
        sendJson(response, {});
        return;
      case "providers":
        sendJson(response, this.providers);
        return;
      case "events":
        this.openStream(response);
        return;
      case "create":
        sendJson(response, { id: OPENCODE_SESSION_ID });
        return;
      case "prompt":
        if (this.silentPrompts > 0) {
          this.silentPrompts -= 1;
        } else {
          response.writeHead(204).end();
        }
        void this.runTurn(
          this.scripts.shift() ?? DEFAULT_SCRIPT,
          promptTextOf(body),
        );
        return;
      case "abort":
        await this.abortHook();
        this.aborted.resolve(undefined);
        sendJson(response, true);
        return;
      case "permission":
        this.recordReply(route.match, body);
        sendJson(response, true);
        return;
      case "unknown":
        response.writeHead(404).end();
    }
  }

  private openStream(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.flushHeaders();
    this.clients.add(response);
    response.on("close", () => {
      this.clients.delete(response);
    });
    response.write(
      `data: ${JSON.stringify(envelope("server.connected", {}))}\n\n`,
    );
  }

  private recordReply(route: RegExpExecArray, body: unknown): void {
    const [, sessionId = "", permissionId = ""] = route;
    const response = z.looseObject({ response: z.unknown() }).parse(body);
    this.replies.push({ sessionId, permissionId, response: response.response });
    this.replyWaiters.get(permissionId)?.();
    for (const listener of this.replyListeners.splice(0)) {
      listener();
    }
  }

  private async runTurn(
    steps: readonly OpencodeStep[],
    promptText: string,
  ): Promise<void> {
    this.promptCount += 1;
    this.sessionBusy = true;
    const arrivals = this.promptArrivals.splice(0);
    arrivals.forEach((notify) => {
      notify();
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [first] = steps;
    if (first?.type === "reject_prompt") {
      this.sessionBusy = false;
      const rejection = eventFor({
        type: "error",
        name: "UnknownError",
        message: first.message,
      });
      this.emit(rejection);
      this.emit(rejection);
      return;
    }
    const userMessageId = `msg_user_${String(this.promptCount).padStart(USER_MESSAGE_DIGITS, "0")}`;
    this.latestUserMessageId = userMessageId;
    const announce = (): void => {
      this.emit(messageUpdated(userMessageId, "user"));
      this.emit(userTextEvent(userMessageId, promptText));
      this.emit(
        messageUpdated(ASSISTANT_MESSAGE_ID, "assistant", this.assistantModel),
      );
    };
    if (first?.type === "slow_user_message") {
      setTimeout(announce, first.ms);
    } else {
      announce();
    }
    for (const step of steps) {
      await this.perform(step);
    }
  }

  private async perform(step: OpencodeStep): Promise<void> {
    switch (step.type) {
      case "permission": {
        const replied = Promise.withResolvers<undefined>();
        this.replyWaiters.set(step.id, () => {
          replied.resolve(undefined);
        });
        this.emitPermissionAsked(step);
        await Promise.race([replied.promise, this.aborted.promise]);
        return;
      }
      case "reject_prompt":
      case "slow_user_message":
        return;
      case "late_idle":
        this.sessionBusy = false;
        while (this.promptCount < step.afterPrompts) {
          await new Promise<void>((resolve) => {
            this.promptArrivals.push(resolve);
          });
        }
        this.emit(eventFor({ type: "idle" }));
        return;
      case "wait_abort":
        await this.aborted.promise;
        return;
      case "hang":
        await new Promise<never>(() => undefined);
        return;
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        return;
      default:
        if (step.type === "idle") {
          this.sessionBusy = false;
        }
        this.emit(eventFor(step));
    }
  }
}

export interface OpencodeStartup {
  readonly configPath: string;
  readonly config: unknown;
  readonly keyFileContent: string;
  readonly keyFileMode: number;
  readonly runDirMode: number;
}

export interface FakeOpencodeConfig {
  exitBeforeListening?: boolean;
  silent?: boolean;
  stderrText?: string;
  stalledRoutes?: readonly Route["kind"][];
  delayedRoutes?: ReadonlyMap<Route["kind"], number>;
  providers?: unknown;
  assistantModel?: AssistantModel;
  launchDelayMs?: number;
}

const StartupConfigSchema = z.looseObject({
  provider: z.record(
    z.string(),
    z.looseObject({ options: z.looseObject({ apiKey: z.string() }) }),
  ),
});

function portOf(spec: SpawnSpec): number {
  const index = spec.args.indexOf(PORT_ARG);
  return Number(spec.args[index + 1]);
}

async function readStartup(
  env: Readonly<Record<string, string>>,
): Promise<OpencodeStartup> {
  const configPath = env[CONFIG_ENV] ?? "";
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const [provider] = Object.values(StartupConfigSchema.parse(config).provider);
  const keyPath =
    FILE_REFERENCE.exec(provider?.options.apiKey ?? "")?.[1] ?? "";
  return {
    configPath,
    config,
    keyFileContent: await readFile(keyPath, "utf8"),
    keyFileMode: (await stat(keyPath)).mode & PERMISSION_MASK,
    runDirMode: (await stat(dirname(keyPath))).mode & PERMISSION_MASK,
  };
}

export class ScriptedOpencodeContainer implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  readonly launch = unsupportedLaunch;
  readonly specs: SpawnSpec[] = [];
  readonly servers: FakeOpencodeServer[] = [];
  readonly contained: FakeContained[] = [];
  readonly startups: OpencodeStartup[] = [];
  readonly config: FakeOpencodeConfig = {};
  private readonly stopResults: readonly StopResult[];
  private readonly nextScripts: (readonly OpencodeStep[])[] = [];

  constructor(stopResults: readonly StopResult[]) {
    this.stopResults = stopResults;
  }

  scriptNextServer(steps: readonly OpencodeStep[]): void {
    this.nextScripts.push(steps);
  }

  async spawn(spec: SpawnSpec): Promise<Contained> {
    const { launchDelayMs } = this.config;
    if (launchDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, launchDelayMs));
    }
    const contained = new FakeContained(spec.runId, this.stopResults);
    this.specs.push(spec);
    this.contained.push(contained);
    if (this.config.stderrText !== undefined) {
      contained.stderr.write(this.config.stderrText);
    }
    if (this.config.exitBeforeListening === true) {
      setImmediate(() => {
        contained.emitExit(1);
      });
      return contained;
    }
    if (this.config.silent === true) {
      return contained;
    }
    const startup = await readStartup(spec.env);
    this.startups.push(startup);
    const server = new FakeOpencodeServer(spec.env[PASSWORD_ENV] ?? "");
    this.servers.push(server);
    const script = this.nextScripts.shift();
    if (script !== undefined) {
      server.enqueue(script);
    }
    if (this.config.providers !== undefined) {
      server.providers = this.config.providers;
    }
    if (this.config.assistantModel !== undefined) {
      server.assistantModel = this.config.assistantModel;
    }
    this.config.stalledRoutes?.forEach((kind) => {
      server.stall(kind);
    });
    this.config.delayedRoutes?.forEach((ms, kind) => {
      server.delay(kind, ms);
    });
    const port = portOf(spec);
    await server.listen(port);
    contained.stdout.write(
      `opencode server listening on http://127.0.0.1:${String(port)}\n`,
    );
    return contained;
  }

  sweepOrphans(): Promise<number> {
    return Promise.resolve(0);
  }
}

export const OPENCODE_RIG_ACCOUNT_ID = "acc-opencode";

const rigRoots: string[] = [];
const rigContainers: ScriptedOpencodeContainer[] = [];

export async function disposeOpencodeRigs(): Promise<void> {
  const containers = rigContainers.splice(0);
  await Promise.allSettled(
    containers.flatMap((container) =>
      container.servers.map((server) => server.close()),
    ),
  );
  await Promise.allSettled(
    rigRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export interface OpencodeRigOptions {
  readonly credentials?: OpencodeCredentials | null;
  readonly stopResults?: readonly StopResult[];
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly warmUpTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly staleGateGraceMs?: number;
  readonly api?: ApiAccount;
  readonly generationFor?: GenerationProbe;
}

export interface OpencodeRig {
  readonly container: ScriptedOpencodeContainer;
  readonly cwd: string;
  readonly accountDir: string;
  readonly runtimeRoot: string;
  start(profile?: PermissionProfile, runId?: string): Promise<AgentStartResult>;
}

export async function createOpencodeRig(
  options: OpencodeRigOptions = {},
): Promise<OpencodeRig> {
  const root = await mkdtemp(join(tmpdir(), "codeweave-opencode-rig-"));
  rigRoots.push(root);
  const cwd = join(root, "work");
  const accountDir = join(root, "account");
  const runtimeRoot = join(root, "runtime");
  await Promise.all([cwd, accountDir, runtimeRoot].map((dir) => mkdir(dir)));
  const container = new ScriptedOpencodeContainer(options.stopResults ?? []);
  rigContainers.push(container);
  const credentials =
    options.credentials === undefined
      ? OPENCODE_RIG_CREDENTIALS
      : options.credentials;
  const adapter = createOpencodeAdapter({
    processes: rigProcesses(container),
    envFor: () => ({ PATH: "/usr/bin" }),
    executableFor: () => OPENCODE_RIG_EXECUTABLE,
    credentialsFor: () => Promise.resolve(credentials),
    generationFor:
      options.generationFor ?? (() => Promise.resolve(OpencodeGeneration.v1)),
    runtimeRoot,
    platform: "linux",
    fetchImpl: fetch,
    now: () => OPENCODE_RIG_NOW_MS,
    freePort: findFreePort,
    newPassword: () => OPENCODE_RIG_PASSWORD,
    stopGraceMs: options.stopGraceMs ?? OPENCODE_RIG_GRACE_MS,
    staleGateGraceMs: options.staleGateGraceMs ?? OPENCODE_RIG_GRACE_MS,
    readyTimeoutMs: options.readyTimeoutMs ?? OPENCODE_RIG_READY_TIMEOUT_MS,
    requestTimeoutMs:
      options.requestTimeoutMs ?? OPENCODE_RIG_REQUEST_TIMEOUT_MS,
    warmUpTimeoutMs: options.warmUpTimeoutMs ?? OPENCODE_RIG_WARM_UP_TIMEOUT_MS,
  });
  const account: Account = {
    id: OPENCODE_RIG_ACCOUNT_ID,
    provider: ProviderId.opencode,
    label: "OpenCode",
    configDir: accountDir,
    order: 0,
    api: options.api,
  };
  return {
    container,
    cwd,
    accountDir,
    runtimeRoot,
    start: (profile = PermissionProfile.ask, runId = "run-1") =>
      adapter.start(specFor(account, cwd, profile, runId)),
  };
}

function specFor(
  account: Account,
  cwd: string,
  profile: PermissionProfile,
  runId: string,
): AgentStartSpec {
  return {
    account,
    cwd,
    profile,
    runId,
    executable: OPENCODE_RIG_EXECUTABLE,
  };
}

export async function startOpencodeHandle(
  rig: OpencodeRig,
  profile: PermissionProfile = PermissionProfile.ask,
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const result = await rig.start(profile);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(result.message);
  }
  const events: AgentEvent[] = [];
  result.handle.subscribe((event) => events.push(event));
  return { handle: result.handle, events };
}

export function opencodeServerOf(rig: OpencodeRig): FakeOpencodeServer {
  const server = rig.container.servers[0];
  if (server === undefined) {
    throw new Error("no opencode server was spawned");
  }
  return server;
}

export async function opencodePermissionRequestOf(
  events: readonly AgentEvent[],
): Promise<Extract<AgentEvent, { type: "permission_request" }>> {
  return settled(() => {
    const found = events.find((event) => event.type === "permission_request");
    if (found === undefined) {
      throw new Error("no permission_request yet");
    }
    return found;
  });
}
