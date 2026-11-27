import { pathToFileURL } from "node:url";

import type { PromptImage } from "../../agentAdapter";

import {
  OpencodeHttpError,
  createSender,
  type OpencodeClientOptions,
  type RequestInput,
} from "../client";
import {
  ACCEPT_EVENT_STREAM,
  CONTENT_TYPE_JSON,
  WARM_UP_TIMEOUT_MS,
  type OpencodeAgent,
  type OpencodePermissionResponse,
} from "../constants";
import { sseEvents } from "../sse";

import { OpencodeV2Path, QUERY_LOCATION_DIRECTORY } from "./constants";
import {
  ActiveSessionsSchema,
  InterruptResponseSchema,
  ModelListResponseSchema,
  SessionCreatedResponseSchema,
  V2ModelSchema,
  parseOpencodeV2Event,
  type OpencodeV2Event,
  type V2Model,
} from "./protocol";

export interface V2ModelRef {
  readonly id: string;
  readonly providerID: string;
}

const COMPACT_PATH = "compact";

export interface OpencodeV2Client {
  warmUp(): Promise<void>;
  models(): Promise<V2Model[]>;
  createSession(agent: OpencodeAgent): Promise<string>;
  sessionExists(sessionId: string): Promise<boolean>;
  prompt(
    sessionId: string,
    text: string,
    images?: readonly PromptImage[],
  ): Promise<void>;
  compact(sessionId: string): Promise<void>;
  switchAgent(sessionId: string, agent: OpencodeAgent): Promise<void>;
  switchModel(sessionId: string, model: V2ModelRef): Promise<void>;
  interrupt(sessionId: string): Promise<boolean>;
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: OpencodePermissionResponse,
  ): Promise<void>;
  isActive(sessionId: string): Promise<boolean>;
  events(signal: AbortSignal): Promise<AsyncIterable<OpencodeV2Event>>;
}

type Send = (input: RequestInput) => Promise<Response>;

type SessionActions = Pick<
  OpencodeV2Client,
  | "prompt"
  | "compact"
  | "switchAgent"
  | "switchModel"
  | "interrupt"
  | "replyPermission"
>;

async function* typedEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpencodeV2Event> {
  for await (const payload of sseEvents(body)) {
    const event = parseOpencodeV2Event(payload);
    if (event !== null) {
      yield event;
    }
  }
}

function sessionPath(sessionId: string, ...segments: string[]): string {
  return [
    OpencodeV2Path.session,
    encodeURIComponent(sessionId),
    ...segments,
  ].join("/");
}

async function sendAndDiscard(send: Send, input: RequestInput): Promise<void> {
  await (await send(input)).text();
}

async function sendForJson(send: Send, input: RequestInput): Promise<unknown> {
  const response = await send({ ...input, accept: CONTENT_TYPE_JSON });
  return response.json();
}

function createSessionActions(send: Send): SessionActions {
  return {
    prompt: (sessionId, text, images = []) =>
      sendAndDiscard(send, {
        method: "POST",
        path: sessionPath(sessionId, OpencodeV2Path.prompt),
        body: {
          text,
          ...(images.length === 0
            ? {}
            : {
                files: images.map((image) => ({
                  uri: pathToFileURL(image.path).href,
                })),
              }),
        },
      }),
    switchAgent: (sessionId, agent) =>
      sendAndDiscard(send, {
        method: "POST",
        path: sessionPath(sessionId, OpencodeV2Path.agent),
        body: { agent },
      }),
    compact: (sessionId) =>
      sendAndDiscard(send, {
        method: "POST",
        path: sessionPath(sessionId, COMPACT_PATH),
        body: {},
      }),
    switchModel: (sessionId, model) =>
      sendAndDiscard(send, {
        method: "POST",
        path: sessionPath(sessionId, OpencodeV2Path.model),
        body: { model: { id: model.id, providerID: model.providerID } },
      }),
    async interrupt(sessionId) {
      const body = await sendForJson(send, {
        method: "POST",
        path: sessionPath(sessionId, OpencodeV2Path.interrupt),
      });
      return InterruptResponseSchema.parse(body).interrupted;
    },
    replyPermission: (sessionId, requestId, decision) =>
      sendAndDiscard(send, {
        method: "POST",
        path: sessionPath(
          sessionId,
          OpencodeV2Path.permission,
          encodeURIComponent(requestId),
          OpencodeV2Path.reply,
        ),
        body: { decision },
      }),
  };
}

export function createOpencodeV2Client(
  options: OpencodeClientOptions,
): OpencodeV2Client {
  const send = createSender(options, {});
  const warmUpTimeoutMs = options.warmUpTimeoutMs ?? WARM_UP_TIMEOUT_MS;

  return {
    ...createSessionActions(send),
    warmUp: () =>
      sendAndDiscard(send, {
        method: "GET",
        path: OpencodeV2Path.provider,
        query: { [QUERY_LOCATION_DIRECTORY]: options.directory },
        timeoutMs: warmUpTimeoutMs,
      }),
    async models() {
      const body = await sendForJson(send, {
        method: "GET",
        path: OpencodeV2Path.models,
        query: { [QUERY_LOCATION_DIRECTORY]: options.directory },
      });
      return ModelListResponseSchema.parse(body).data.flatMap((raw) => {
        const parsed = V2ModelSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async createSession(agent) {
      const body = await sendForJson(send, {
        method: "POST",
        path: OpencodeV2Path.session,
        body: { location: { directory: options.directory }, agent },
      });
      return SessionCreatedResponseSchema.parse(body).data.id;
    },
    async sessionExists(sessionId) {
      try {
        await sendAndDiscard(send, {
          method: "GET",
          path: sessionPath(sessionId),
          query: { [QUERY_LOCATION_DIRECTORY]: options.directory },
        });
        return true;
      } catch (error) {
        if (error instanceof OpencodeHttpError) {
          return false;
        }
        throw error;
      }
    },
    async isActive(sessionId) {
      const body = await sendForJson(send, {
        method: "GET",
        path: OpencodeV2Path.activeSessions,
      });
      return Object.hasOwn(ActiveSessionsSchema.parse(body).data, sessionId);
    },
    async events(signal) {
      const response = await send({
        method: "GET",
        path: OpencodeV2Path.event,
        signal,
        accept: ACCEPT_EVENT_STREAM,
        untimed: true,
      });
      if (response.body === null) {
        throw new OpencodeHttpError(
          "GET",
          OpencodeV2Path.event,
          response.status,
        );
      }
      return typedEvents(response.body);
    },
  };
}
