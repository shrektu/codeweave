import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";

import { OpencodeGeneration } from "../../src/backend/opencode/constants";
import type { StopResult } from "../../src/backend/process/container";

import {
  OPENCODE_SESSION_ID,
  ScriptedContainerBase,
  basicAuthOf,
  createRigOn,
  firstServerOf,
  readBody,
  readRunStartup,
  sendJson,
  keyPathOf,
  startOpencodeHandle,
  type BaseContainerConfig,
  type Json,
  type OpencodeRigOf,
  type OpencodeRigOptions,
  type OpencodeStartup,
  type RecordedRequest,
  type ScriptedServer,
} from "./opencodeFakeCommon";

const REPLY_TIMEOUT_MS = 2000;
const CONFIG_ENV = "OPENCODE_CONFIG";
const PASSWORD_ENV = "OPENCODE_PASSWORD";
const PROVIDER_PATH = "/api/provider";
const MODEL_PATH = "/api/model";
const SESSION_PATH = "/api/session";
const ACTIVE_PATH = "/api/session/active";
const EVENT_PATH = "/api/event";
const SESSION_ACTION_ROUTE =
  /^\/api\/session\/([^/]+)\/(prompt|agent|model|interrupt)$/;
const PERMISSION_REPLY_ROUTE =
  /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/;
const ASSISTANT_MESSAGE_ID = "msg_assistant_1";
const USER_MESSAGE_ID = "msg_user_1";
const STEP_PROVIDER_ID = "groq";
const STEP_AGENT = "build";
const RUNNING_STATE = { type: "running" };
const NO_CONTENT = 204;
const NOT_FOUND = 404;
const ALWAYS_DECISION = "always";
const DIRECTORY_QUERY = "location[directory]";
const FAKE_MODEL_BASE_URL = "https://opencode.ai/inference/go/openai/v1";

export interface FakeV2Error {
  readonly type: string;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface V2PermissionStep {
  readonly type: "permission";
  readonly id: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly callId?: string;
  readonly sessionId?: string;
}

interface PendingPermission {
  readonly sessionId: string;
  readonly settled: () => void;
}

export type OpencodeV2Step =
  | { readonly type: "started" }
  | { readonly type: "step"; readonly model: string }
  | {
      readonly type: "text";
      readonly messageId: string;
      readonly ordinal: number;
      readonly delta: string;
    }
  | {
      readonly type: "text_ended";
      readonly messageId: string;
      readonly ordinal: number;
      readonly text: string;
    }
  | {
      readonly type: "tool_input";
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_called";
      readonly callId: string;
      readonly input: Json;
    }
  | { readonly type: "tool_progress"; readonly callId: string }
  | {
      readonly type: "tool_success";
      readonly callId: string;
      readonly text?: string;
    }
  | {
      readonly type: "tool_failed";
      readonly callId: string;
      readonly message: string;
    }
  | {
      readonly type: "child_session";
      readonly id: string;
      readonly parentId?: string;
    }
  | V2PermissionStep
  | {
      readonly type: "permissions";
      readonly requests: readonly V2PermissionStep[];
    }
  | {
      readonly type: "retry";
      readonly at: number;
      readonly error: FakeV2Error;
    }
  | { readonly type: "succeeded" }
  | { readonly type: "failed"; readonly error: FakeV2Error }
  | { readonly type: "interrupted"; readonly reason: string }
  | { readonly type: "wait"; readonly ms: number }
  | { readonly type: "wait_interrupt" }
  | { readonly type: "hold" }
  | { readonly type: "close_stream" }
  | { readonly type: "raw"; readonly event: Json };

export interface V2PermissionReply {
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: unknown;
}

export interface V2WarmUp {
  readonly directory: string | undefined;
  readonly keyFileContent: string | null;
}

const DEFAULT_SCRIPT: readonly OpencodeV2Step[] = [
  { type: "started" },
  { type: "succeeded" },
];
const DEFAULT_INTERRUPT_OUTCOME: readonly OpencodeV2Step[] = [
  { type: "interrupted", reason: "user" },
];

const StartupConfigSchema = z.looseObject({
  providers: z.record(
    z.string(),
    z.looseObject({ settings: z.looseObject({ apiKey: z.string() }) }),
  ),
});

const ReplyBodySchema = z.looseObject({ decision: z.string() });

function apiKeyReferenceOf(config: unknown): string {
  const [provider] = Object.values(StartupConfigSchema.parse(config).providers);
  return provider?.settings.apiKey ?? "";
}

type V2Route =
  | {
      readonly kind:
        "provider" | "models" | "active" | "events" | "create" | "unknown";
    }
  | { readonly kind: "reply"; readonly match: RegExpExecArray }
  | { readonly kind: "action"; readonly action: string };

const UNKNOWN_ROUTE: V2Route = { kind: "unknown" };
const GET_ROUTES = new Map<string, V2Route>([
  [PROVIDER_PATH, { kind: "provider" }],
  [MODEL_PATH, { kind: "models" }],
  [ACTIVE_PATH, { kind: "active" }],
  [EVENT_PATH, { kind: "events" }],
]);

function postRouteOf(path: string): V2Route {
  const reply = PERMISSION_REPLY_ROUTE.exec(path);
  const action = SESSION_ACTION_ROUTE.exec(path)?.[2];
  if (path === SESSION_PATH) {
    return { kind: "create" };
  }
  if (reply !== null) {
    return { kind: "reply", match: reply };
  }
  return action === undefined ? UNKNOWN_ROUTE : { kind: "action", action };
}

function routeOf(method: string, path: string): V2Route {
  if (method === "GET") {
    return GET_ROUTES.get(path) ?? UNKNOWN_ROUTE;
  }
  return method === "POST" ? postRouteOf(path) : UNKNOWN_ROUTE;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

let eventCounter = 0;

function envelope(type: string, data: Json): Json {
  eventCounter += 1;
  return { id: `evt_${String(eventCounter)}`, created: 0, type, data };
}

function ownSession(): Json {
  return { sessionID: OPENCODE_SESSION_ID };
}

function toolEvent(
  step: Extract<
    OpencodeV2Step,
    {
      type:
        | "tool_input"
        | "tool_called"
        | "tool_progress"
        | "tool_success"
        | "tool_failed";
    }
  >,
): Json {
  const base = { ...ownSession(), id: step.callId };
  switch (step.type) {
    case "tool_input":
      return envelope("session.tool.input.started", {
        ...base,
        name: step.name,
      });
    case "tool_called":
      return envelope("session.tool.called", { ...base, input: step.input });
    case "tool_progress":
      return envelope("session.tool.progress", base);
    case "tool_success":
      return envelope("session.tool.success", {
        ...base,
        content:
          step.text === undefined ? [] : [{ type: "text", text: step.text }],
      });
    case "tool_failed":
      return envelope("session.tool.failed", {
        ...base,
        error: { type: "tool.execution", message: step.message },
      });
  }
}

function textEvent(
  step: Extract<OpencodeV2Step, { type: "text" | "text_ended" }>,
): Json {
  const base = {
    ...ownSession(),
    assistantMessageID: step.messageId,
    ordinal: step.ordinal,
  };
  return step.type === "text"
    ? envelope("session.text.delta", { ...base, delta: step.delta })
    : envelope("session.text.ended", { ...base, text: step.text });
}

function permissionEvent(
  step: Extract<OpencodeV2Step, { type: "permission" }>,
): Json {
  return envelope("permission.asked", {
    id: step.id,
    sessionID: step.sessionId ?? OPENCODE_SESSION_ID,
    action: step.action,
    resources: step.resources,
    source: { type: "tool", id: step.callId ?? `call_${step.id}` },
  });
}

function lifecycleEvent(
  step: Extract<
    OpencodeV2Step,
    {
      type:
        | "started"
        | "step"
        | "child_session"
        | "retry"
        | "succeeded"
        | "failed"
        | "interrupted";
    }
  >,
): Json {
  switch (step.type) {
    case "started":
      return envelope("session.execution.started", ownSession());
    case "step":
      return envelope("session.step.started", {
        ...ownSession(),
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        agent: STEP_AGENT,
        model: { id: step.model, providerID: STEP_PROVIDER_ID },
      });
    case "child_session":
      return envelope("session.created", {
        sessionID: step.id,
        parentID: step.parentId ?? OPENCODE_SESSION_ID,
      });
    case "retry":
      return envelope("session.retry.scheduled", {
        ...ownSession(),
        attempt: 1,
        at: step.at,
        error: step.error,
      });
    case "succeeded":
      return envelope("session.execution.succeeded", ownSession());
    case "failed":
      return envelope("session.execution.failed", {
        ...ownSession(),
        error: step.error,
      });
    case "interrupted":
      return envelope("session.execution.interrupted", {
        ...ownSession(),
        reason: step.reason,
      });
  }
}

const TERMINAL_STEPS: readonly OpencodeV2Step["type"][] = [
  "succeeded",
  "failed",
  "interrupted",
];

export class FakeOpencodeV2Server implements ScriptedServer<OpencodeV2Step> {
  interruptOutcome: readonly OpencodeV2Step[] = DEFAULT_INTERRUPT_OUTCOME;
  readonly requests: RecordedRequest[] = [];
  readonly replies: V2PermissionReply[] = [];
  readonly staleReplies: V2PermissionReply[] = [];
  readonly warmUps: V2WarmUp[] = [];
  private readonly scripts: (readonly OpencodeV2Step[])[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly replyListeners: (() => void)[] = [];
  private readonly http: Server;
  private readonly password: string;
  private readonly configPath: string;
  private readonly models: readonly Json[];
  private readonly reached = Promise.withResolvers<undefined>();
  private readonly released = Promise.withResolvers<undefined>();
  private turnInterrupt = Promise.withResolvers<undefined>();
  private active = false;

  constructor(
    password: string,
    configPath: string,
    models: readonly Json[] = [],
  ) {
    this.password = password;
    this.configPath = configPath;
    this.models = models;
    this.http = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        console.error("fake opencode v2 handler failed", error);
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
    this.closeStream();
    this.http.closeAllConnections();
    return new Promise((resolve) => {
      this.http.close(() => {
        resolve();
      });
    });
  }

  enqueue(steps: readonly OpencodeV2Step[]): void {
    this.scripts.push(steps);
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  untilHeld(): Promise<undefined> {
    return this.reached.promise;
  }

  release(): void {
    this.released.resolve(undefined);
  }

  emit(event: Json): void {
    for (const client of this.clients) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  closeStream(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
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
    const authorized =
      request.headers.authorization === basicAuthOf(this.password);
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
    await this.route(method, url, body, response);
  }

  private async route(
    method: string,
    url: URL,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    const route = routeOf(method, url.pathname);
    switch (route.kind) {
      case "provider":
        await this.warmUp(url, response);
        return;
      case "models":
        await this.listModels(url, response);
        return;
      case "active":
        sendJson(response, {
          data: this.active ? { [OPENCODE_SESSION_ID]: RUNNING_STATE } : {},
        });
        return;
      case "events":
        this.openStream(response);
        return;
      case "create":
        sendJson(response, { data: { id: OPENCODE_SESSION_ID } });
        return;
      case "reply":
        response
          .writeHead(
            this.recordReply(route.match, body) ? NO_CONTENT : NOT_FOUND,
          )
          .end();
        return;
      case "action":
        await this.sessionAction(route.action, body, response);
        return;
      case "unknown":
        response.writeHead(NOT_FOUND).end();
    }
  }

  private async warmUp(url: URL, response: ServerResponse): Promise<void> {
    const directory = url.searchParams.get(DIRECTORY_QUERY) ?? undefined;
    const keyFileContent = await this.readKeyFile();
    this.warmUps.push({ directory, keyFileContent });
    sendJson(response, { location: { directory }, data: [] });
  }

  private async listModels(url: URL, response: ServerResponse): Promise<void> {
    const directory = url.searchParams.get(DIRECTORY_QUERY) ?? undefined;
    const apiKey = (await this.readKeyFile()) ?? "";
    sendJson(response, {
      location: { directory },
      data: this.models.map((model) => ({
        ...model,
        settings: { apiKey, baseURL: FAKE_MODEL_BASE_URL },
      })),
    });
  }

  private async readKeyFile(): Promise<string | null> {
    const config = JSON.parse(
      await readFile(this.configPath, "utf8"),
    ) as unknown;
    return readOptionalFile(keyPathOf(apiKeyReferenceOf(config)));
  }

  private async sessionAction(
    action: string,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    if (action === "interrupt") {
      await this.interrupt(response);
      return;
    }
    if (action !== "prompt") {
      response.writeHead(NO_CONTENT).end();
      return;
    }
    this.active = true;
    this.turnInterrupt = Promise.withResolvers<undefined>();
    sendJson(response, {
      data: {
        id: USER_MESSAGE_ID,
        sessionID: OPENCODE_SESSION_ID,
        type: "user",
        payload: body,
        delivery: "steer",
      },
    });
    void this.runTurn(this.scripts.shift() ?? DEFAULT_SCRIPT);
  }

  private async interrupt(response: ServerResponse): Promise<void> {
    const wasActive = this.active;
    sendJson(response, { interrupted: wasActive });
    if (!wasActive) {
      return;
    }
    this.turnInterrupt.resolve(undefined);
    for (const step of this.interruptOutcome) {
      await this.perform(step);
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

  private ask(step: V2PermissionStep): Promise<void> {
    const answered = Promise.withResolvers<undefined>();
    this.pending.set(step.id, {
      sessionId: step.sessionId ?? OPENCODE_SESSION_ID,
      settled: () => {
        answered.resolve(undefined);
      },
    });
    this.emit(permissionEvent(step));
    return answered.promise.then(() => undefined);
  }

  private recordReply(route: RegExpExecArray, body: unknown): boolean {
    const [, sessionId = "", requestId = ""] = route;
    const { decision } = ReplyBodySchema.parse(body);
    const reply = { sessionId, requestId, decision };
    if (!this.pending.has(requestId)) {
      this.staleReplies.push(reply);
      return false;
    }
    this.replies.push(reply);
    this.settle(sessionId, requestId, decision);
    if (decision === ALWAYS_DECISION) {
      for (const [id, other] of [...this.pending]) {
        if (other.sessionId === sessionId) {
          this.settle(sessionId, id, ALWAYS_DECISION);
        }
      }
    }
    for (const listener of this.replyListeners.splice(0)) {
      listener();
    }
    return true;
  }

  private settle(sessionId: string, requestId: string, reply: string): void {
    this.pending.get(requestId)?.settled();
    this.pending.delete(requestId);
    this.emit(
      envelope("permission.replied", {
        sessionID: sessionId,
        requestID: requestId,
        reply,
      }),
    );
  }

  private async runTurn(steps: readonly OpencodeV2Step[]): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    for (const step of steps) {
      await this.perform(step);
    }
  }

  private async perform(step: OpencodeV2Step): Promise<void> {
    switch (step.type) {
      case "permission":
        await Promise.race([this.ask(step), this.turnInterrupt.promise]);
        return;
      case "permissions":
        await Promise.race([
          Promise.all(step.requests.map((request) => this.ask(request))),
          this.turnInterrupt.promise,
        ]);
        return;
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        return;
      case "wait_interrupt":
        await this.turnInterrupt.promise;
        return;
      case "hold":
        this.reached.resolve(undefined);
        await this.released.promise;
        return;
      case "close_stream":
        this.closeStream();
        return;
      case "raw":
        this.emit(step.event);
        return;
      default:
        this.emitScripted(step);
    }
  }

  private emitScripted(
    step: Exclude<
      OpencodeV2Step,
      {
        type:
          | "permission"
          | "permissions"
          | "wait"
          | "wait_interrupt"
          | "hold"
          | "close_stream"
          | "raw";
      }
    >,
  ): void {
    if (TERMINAL_STEPS.includes(step.type)) {
      this.active = false;
    }
    switch (step.type) {
      case "text":
      case "text_ended":
        this.emit(textEvent(step));
        return;
      case "tool_input":
      case "tool_called":
      case "tool_progress":
      case "tool_success":
      case "tool_failed":
        this.emit(toolEvent(step));
        return;
      default:
        this.emit(lifecycleEvent(step));
    }
  }
}

export interface FakeOpencodeV2Config extends BaseContainerConfig {
  models?: readonly Json[];
}

export class ScriptedOpencodeV2Container extends ScriptedContainerBase<
  FakeOpencodeV2Server,
  OpencodeV2Step,
  FakeOpencodeV2Config
> {
  constructor(stopResults: readonly StopResult[]) {
    super(stopResults, {});
  }

  protected passwordEnv(): string {
    return PASSWORD_ENV;
  }

  protected listeningLine(port: number): string {
    return `server listening on http://127.0.0.1:${String(port)}\n`;
  }

  protected readStartup(
    env: Readonly<Record<string, string>>,
  ): Promise<OpencodeStartup> {
    return readRunStartup(env[CONFIG_ENV] ?? "", apiKeyReferenceOf);
  }

  protected createServer(
    password: string,
    env: Readonly<Record<string, string>>,
  ): FakeOpencodeV2Server {
    return new FakeOpencodeV2Server(
      password,
      env[CONFIG_ENV] ?? "",
      this.config.models,
    );
  }
}

export type OpencodeV2Rig = OpencodeRigOf<ScriptedOpencodeV2Container>;

export function createOpencodeV2Rig(
  options: OpencodeRigOptions = {},
): Promise<OpencodeV2Rig> {
  return createRigOn(
    new ScriptedOpencodeV2Container(options.stopResults ?? []),
    options,
    OpencodeGeneration.v2,
  );
}

export const startOpencodeV2Handle = startOpencodeHandle;

export function opencodeV2ServerOf(rig: OpencodeV2Rig): FakeOpencodeV2Server {
  return firstServerOf(rig.container);
}
