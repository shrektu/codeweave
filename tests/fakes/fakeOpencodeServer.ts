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
  type BaseContainerConfig,
  type Json,
  type OpencodeRigOf,
  type OpencodeRigOptions,
  type OpencodeStartup,
  type RecordedRequest,
} from "./opencodeFakeCommon";

export {
  OPENCODE_RIG_ACCOUNT_ID,
  OPENCODE_RIG_CREDENTIALS,
  OPENCODE_RIG_EXECUTABLE,
  OPENCODE_RIG_GRACE_MS,
  OPENCODE_RIG_NOW_MS,
  OPENCODE_RIG_PASSWORD,
  OPENCODE_RIG_READY_TIMEOUT_MS,
  OPENCODE_RIG_REQUEST_TIMEOUT_MS,
  OPENCODE_RIG_WARM_UP_TIMEOUT_MS,
  OPENCODE_SESSION_ID,
  disposeOpencodeRigs,
  opencodePermissionRequestOf,
  startOpencodeHandle,
  type Json,
  type OpencodeRigOptions,
  type OpencodeStartup,
  type RecordedRequest,
} from "./opencodeFakeCommon";

const REPLY_TIMEOUT_MS = 2000;
const CONFIG_ENV = "OPENCODE_CONFIG";
const PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
const PERMISSIONS_ROUTE = /^\/session\/([^/]+)\/permissions\/([^/]+)$/;
const MESSAGES_ROUTE = /^\/session\/([^/]+)\/message$/;
const MESSAGES_ROUTE_RESULT: Route = { kind: "messages" };
const SESSION_ROUTE = /^\/session\/([^/]+)\/(prompt_async|abort|summarize)$/;
const SESSION_BY_ID_ROUTE = /^\/session\/([^/]+)$/;

export type ToolStepStatus = "pending" | "running" | "completed" | "error";

export interface OpencodePermissionStep {
  readonly type: "permission";
  readonly id: string;
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly metadata: Json;
  readonly callId?: string;
  readonly sessionId?: string;
}

interface PendingPermission {
  readonly sessionId: string;
  readonly settled: () => void;
}

const ALWAYS_RESPONSE = "always";

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
  | OpencodePermissionStep
  | {
      readonly type: "permissions";
      readonly requests: readonly OpencodePermissionStep[];
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
      | "permissions"
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
  | { readonly kind: "summarize" }
  | { readonly kind: "session"; readonly sessionId: string }
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
    const action = session[2];
    if (action === "abort") {
      return { kind: "abort" };
    }
    return action === "summarize" ? { kind: "summarize" } : { kind: "prompt" };
  }
  return permission === null
    ? UNKNOWN_ROUTE
    : { kind: "permission", match: permission };
}

function routeOf(method: string, path: string): Route {
  if (method === "GET") {
    const mapped = GET_ROUTES.get(path);
    if (mapped !== undefined) {
      return mapped;
    }
    if (MESSAGES_ROUTE.test(path)) {
      return MESSAGES_ROUTE_RESULT;
    }
    const session = SESSION_BY_ID_ROUTE.exec(path);
    return session === null
      ? UNKNOWN_ROUTE
      : { kind: "session", sessionId: session[1] ?? "" };
  }
  return method === "POST" ? postRouteOf(path) : UNKNOWN_ROUTE;
}

export class FakeOpencodeServer {
  providers: unknown = { providers: [], default: {} };
  knownSessionIds: readonly string[] = [OPENCODE_SESSION_ID];
  assistantModel: AssistantModel | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly replies: PermissionReply[] = [];
  readonly staleReplies: PermissionReply[] = [];
  private readonly scripts: (readonly OpencodeStep[])[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly pending = new Map<string, PendingPermission>();
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
    const sessionId = step.sessionId ?? OPENCODE_SESSION_ID;
    if (!this.pending.has(step.id)) {
      this.pending.set(step.id, { sessionId, settled: () => undefined });
    }
    this.emit(
      envelope("permission.asked", {
        id: step.id,
        sessionID: sessionId,
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
      case "session":
        if (this.knownSessionIds.includes(route.sessionId)) {
          sendJson(response, { id: route.sessionId });
        } else {
          response.writeHead(404).end();
        }
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
      case "summarize":
        sendJson(response, true);
        void this.runCompact();
        return;
      case "permission":
        if (this.recordReply(route.match, body)) {
          sendJson(response, true);
        } else {
          response.writeHead(404).end();
        }
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

  private ask(step: OpencodePermissionStep): Promise<void> {
    const answered = Promise.withResolvers<undefined>();
    this.pending.set(step.id, {
      sessionId: step.sessionId ?? OPENCODE_SESSION_ID,
      settled: () => {
        answered.resolve(undefined);
      },
    });
    this.emitPermissionAsked(step);
    return answered.promise.then(() => undefined);
  }

  private recordReply(route: RegExpExecArray, body: unknown): boolean {
    const [, sessionId = "", permissionId = ""] = route;
    const { response } = z.looseObject({ response: z.string() }).parse(body);
    const reply = { sessionId, permissionId, response };
    if (!this.pending.has(permissionId)) {
      this.staleReplies.push(reply);
      return false;
    }
    this.replies.push(reply);
    this.settle(sessionId, permissionId, response);
    if (response === ALWAYS_RESPONSE) {
      for (const [id, other] of [...this.pending]) {
        if (other.sessionId === sessionId) {
          this.settle(sessionId, id, ALWAYS_RESPONSE);
        }
      }
    }
    for (const listener of this.replyListeners.splice(0)) {
      listener();
    }
    return true;
  }

  private settle(sessionId: string, permissionId: string, reply: string): void {
    this.pending.get(permissionId)?.settled();
    this.pending.delete(permissionId);
    this.emit(
      envelope("permission.replied", {
        sessionID: sessionId,
        requestID: permissionId,
        reply,
      }),
    );
  }

  private async runCompact(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    this.emit(eventFor({ type: "idle" }));
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
      case "permission":
        await Promise.race([this.ask(step), this.aborted.promise]);
        return;
      case "permissions":
        await Promise.race([
          Promise.all(step.requests.map((request) => this.ask(request))),
          this.aborted.promise,
        ]);
        return;
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

export interface FakeOpencodeConfig extends BaseContainerConfig {
  stalledRoutes?: readonly Route["kind"][];
  delayedRoutes?: ReadonlyMap<Route["kind"], number>;
  providers?: unknown;
  assistantModel?: AssistantModel;
  knownSessionIds?: readonly string[];
}

const StartupConfigSchema = z.looseObject({
  provider: z.record(
    z.string(),
    z.looseObject({ options: z.looseObject({ apiKey: z.string() }) }),
  ),
});

export class ScriptedOpencodeContainer extends ScriptedContainerBase<
  FakeOpencodeServer,
  OpencodeStep,
  FakeOpencodeConfig
> {
  constructor(stopResults: readonly StopResult[]) {
    super(stopResults, {});
  }

  protected passwordEnv(): string {
    return PASSWORD_ENV;
  }

  protected listeningLine(port: number): string {
    return `opencode server listening on http://127.0.0.1:${String(port)}\n`;
  }

  protected readStartup(
    env: Readonly<Record<string, string>>,
  ): Promise<OpencodeStartup> {
    return readRunStartup(env[CONFIG_ENV] ?? "", (config) => {
      const [provider] = Object.values(
        StartupConfigSchema.parse(config).provider,
      );
      return provider?.options.apiKey ?? "";
    });
  }

  protected createServer(password: string): FakeOpencodeServer {
    const server = new FakeOpencodeServer(password);
    if (this.config.providers !== undefined) {
      server.providers = this.config.providers;
    }
    if (this.config.assistantModel !== undefined) {
      server.assistantModel = this.config.assistantModel;
    }
    if (this.config.knownSessionIds !== undefined) {
      server.knownSessionIds = this.config.knownSessionIds;
    }
    this.config.stalledRoutes?.forEach((kind) => {
      server.stall(kind);
    });
    this.config.delayedRoutes?.forEach((ms, kind) => {
      server.delay(kind, ms);
    });
    return server;
  }
}

export type OpencodeRig = OpencodeRigOf<ScriptedOpencodeContainer>;

export function createOpencodeRig(
  options: OpencodeRigOptions = {},
): Promise<OpencodeRig> {
  return createRigOn(
    new ScriptedOpencodeContainer(options.stopResults ?? []),
    options,
    OpencodeGeneration.v1,
  );
}

export function opencodeServerOf(rig: OpencodeRig): FakeOpencodeServer {
  return firstServerOf(rig.container);
}
