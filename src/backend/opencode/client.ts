import {
  ACCEPT_EVENT_STREAM,
  CONTENT_TYPE_JSON,
  OpencodePath,
  LATEST_MESSAGE_LIMIT,
  QUERY_DIRECTORY,
  QUERY_LIMIT,
  REQUEST_TIMEOUT_MS,
  SERVER_USERNAME,
  WARM_UP_TIMEOUT_MS,
  type OpencodeAgent,
  type OpencodePermissionResponse,
} from "./constants";
import {
  ProvidersResponseSchema,
  SessionResponseSchema,
  LatestMessagesSchema,
  SessionStatusMapSchema,
  parseOpencodeEvent,
  type OpencodeEvent,
  type ProvidersResponse,
} from "./protocol";
import { sseEvents } from "./sse";

export class OpencodeHttpError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`opencode ${method} ${path} failed with HTTP ${String(status)}`);
    this.name = "OpencodeHttpError";
    this.status = status;
  }
}

export interface OpencodeClientOptions {
  readonly baseUrl: string;
  readonly password: string;
  readonly directory: string;
  readonly fetchImpl: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly warmUpTimeoutMs?: number;
}

export interface PromptModel {
  readonly providerID: string;
  readonly modelID: string;
}

export interface PromptRequest {
  readonly sessionId: string;
  readonly text: string;
  readonly agent: OpencodeAgent;
  readonly model: PromptModel | null;
}

export function promptBody(
  request: PromptRequest,
): Readonly<Record<string, unknown>> {
  return {
    parts: [{ type: "text", text: request.text }],
    agent: request.agent,
    ...(request.model === null ? {} : { model: request.model }),
  };
}

export interface OpencodeClient {
  warmUp(): Promise<void>;
  createSession(): Promise<string>;
  sessionStatus(): Promise<ReadonlyMap<string, { readonly type: string }>>;
  latestMessageId(sessionId: string): Promise<string | null>;
  promptAsync(request: PromptRequest): Promise<void>;
  abort(sessionId: string): Promise<void>;
  replyPermission(
    sessionId: string,
    permissionId: string,
    response: OpencodePermissionResponse,
  ): Promise<void>;
  events(signal: AbortSignal): Promise<AsyncIterable<OpencodeEvent>>;
  providers(): Promise<ProvidersResponse>;
}

interface RequestInput {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly accept?: string;
  readonly untimed?: boolean;
  readonly timeoutMs?: number;
  readonly query?: Readonly<Record<string, string>>;
}

function signalFor(
  input: RequestInput,
  defaultTimeoutMs: number,
): AbortSignal | undefined {
  if (input.untimed === true) {
    return input.signal;
  }
  const timeout = AbortSignal.timeout(input.timeoutMs ?? defaultTimeoutMs);
  return input.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, input.signal]);
}

async function* typedEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpencodeEvent> {
  for await (const payload of sseEvents(body)) {
    const event = parseOpencodeEvent(payload);
    if (event !== null) {
      yield event;
    }
  }
}

function sessionPath(sessionId: string, ...segments: string[]): string {
  return [
    OpencodePath.session,
    encodeURIComponent(sessionId),
    ...segments,
  ].join("/");
}

function createSender(
  options: OpencodeClientOptions,
): (input: RequestInput) => Promise<Response> {
  const authorization = `Basic ${Buffer.from(
    `${SERVER_USERNAME}:${options.password}`,
  ).toString("base64")}`;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  return async (input) => {
    const url = new URL(input.path, options.baseUrl);
    url.searchParams.set(QUERY_DIRECTORY, options.directory);
    Object.entries(input.query ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    const signal = signalFor(input, timeoutMs);
    const response = await options.fetchImpl(url, {
      method: input.method,
      headers: {
        authorization,
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        ...(input.body === undefined
          ? {}
          : { "content-type": CONTENT_TYPE_JSON }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpencodeHttpError(input.method, input.path, response.status);
    }
    return response;
  };
}

export function createOpencodeClient(
  options: OpencodeClientOptions,
): OpencodeClient {
  const send = createSender(options);
  const warmUpTimeoutMs = options.warmUpTimeoutMs ?? WARM_UP_TIMEOUT_MS;

  async function sendAndDiscard(input: RequestInput): Promise<void> {
    await (await send(input)).text();
  }

  return {
    warmUp: () =>
      sendAndDiscard({
        method: "GET",
        path: OpencodePath.config,
        timeoutMs: warmUpTimeoutMs,
      }),
    async providers() {
      const response = await send({
        method: "GET",
        path: OpencodePath.providers,
        accept: CONTENT_TYPE_JSON,
      });
      return ProvidersResponseSchema.parse(await response.json());
    },
    async createSession() {
      const response = await send({
        method: "POST",
        path: OpencodePath.session,
        body: {},
      });
      return SessionResponseSchema.parse(await response.json()).id;
    },
    async sessionStatus() {
      const response = await send({
        method: "GET",
        path: OpencodePath.sessionStatus,
      });
      return new Map(
        Object.entries(SessionStatusMapSchema.parse(await response.json())),
      );
    },
    async latestMessageId(sessionId) {
      const response = await send({
        method: "GET",
        path: sessionPath(sessionId, OpencodePath.message),
        query: { [QUERY_LIMIT]: LATEST_MESSAGE_LIMIT },
      });
      const [latest] = LatestMessagesSchema.parse(await response.json());
      return latest?.info.id ?? null;
    },
    promptAsync: (request) =>
      sendAndDiscard({
        method: "POST",
        path: sessionPath(request.sessionId, OpencodePath.promptAsync),
        body: promptBody(request),
      }),
    abort: (sessionId) =>
      sendAndDiscard({
        method: "POST",
        path: sessionPath(sessionId, OpencodePath.abort),
      }),
    replyPermission: (sessionId, permissionId, response) =>
      sendAndDiscard({
        method: "POST",
        path: sessionPath(
          sessionId,
          OpencodePath.permissions,
          encodeURIComponent(permissionId),
        ),
        body: { response },
      }),
    async events(signal) {
      const response = await send({
        method: "GET",
        path: OpencodePath.event,
        signal,
        accept: ACCEPT_EVENT_STREAM,
        untimed: true,
      });
      if (response.body === null) {
        throw new OpencodeHttpError("GET", OpencodePath.event, response.status);
      }
      return typedEvents(response.body);
    },
  };
}
