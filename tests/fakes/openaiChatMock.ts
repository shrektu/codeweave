import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod";

export const ChatScenario = {
  toolThen429: "tool-then-429",
  ok: "ok",
} as const;
export type ChatScenario = (typeof ChatScenario)[keyof typeof ChatScenario];

const LOOPBACK_HOST = "127.0.0.1";
const BASE_PATH = "/v1";
const COMPLETIONS_PATH = "/chat/completions";
const BEARER_PREFIX = "Bearer ";
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_RATE_LIMITED = 429;
const RETRY_AFTER_SECONDS = "120";
const REPLY_TEXT = "done";
const TITLE_TEXT = "Rotation test";
const TOOL_NAME = "bash";
const TOOL_DESCRIPTION = "Record the side effect";
const MODEL_NAME = "mock-model";
const CHUNK_OBJECT = "chat.completion.chunk";
const DONE_FRAME = "data: [DONE]\n\n";
const JSON_HEADERS = { "content-type": "application/json" } as const;
const SSE_HEADERS = { "content-type": "text/event-stream" } as const;
const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
} as const;

const RequestBodySchema = z.looseObject({
  model: z.string().optional(),
  tools: z.array(z.unknown()).default([]),
});

export interface ChatRecordedRequest {
  readonly key: string;
  readonly model: string | null;
  readonly hasTools: boolean;
  readonly path: string;
}

export interface ChatMockOptions {
  readonly scenarios: Readonly<Record<string, ChatScenario>>;
  readonly toolCommand: string;
}

export interface OpenaiChatMock {
  readonly url: string;
  requests(): readonly ChatRecordedRequest[];
  close(): Promise<void>;
}

type Delta = Record<string, unknown>;

function chunkFrame(
  delta: Delta,
  finishReason: string | null,
  usage?: object,
): string {
  const payload = {
    id: "chatcmpl-mock",
    object: CHUNK_OBJECT,
    created: 0,
    model: MODEL_NAME,
    choices:
      usage === undefined
        ? [{ index: 0, delta, finish_reason: finishReason }]
        : [],
    ...(usage === undefined ? {} : { usage }),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sendStream(
  res: ServerResponse,
  delta: Delta,
  finishReason: string,
): void {
  res.writeHead(HTTP_OK, SSE_HEADERS);
  res.write(chunkFrame(delta, null));
  res.write(chunkFrame({}, finishReason));
  res.write(chunkFrame({}, null, USAGE));
  res.end(DONE_FRAME);
}

function sendText(res: ServerResponse, text: string): void {
  sendStream(res, { role: "assistant", content: text }, "stop");
}

function sendToolCall(
  res: ServerResponse,
  toolCommand: string,
  sequence: number,
): void {
  const args = { command: toolCommand, description: TOOL_DESCRIPTION };
  sendStream(
    res,
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${String(sequence)}`,
          type: "function",
          function: { name: TOOL_NAME, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendRateLimited(res: ServerResponse): void {
  res.writeHead(HTTP_RATE_LIMITED, {
    ...JSON_HEADERS,
    "retry-after": RETRY_AFTER_SECONDS,
  });
  res.end(
    JSON.stringify({
      error: {
        message: "Mock: rate limit reached",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    }),
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bearerKey(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length)
    : "";
}

function hasTools(raw: string): boolean {
  const parsed = RequestBodySchema.safeParse(JSON.parse(raw || "{}"));
  return parsed.success && parsed.data.tools.length > 0;
}

function modelOf(raw: string): string | null {
  const parsed = RequestBodySchema.safeParse(JSON.parse(raw || "{}"));
  return parsed.success ? (parsed.data.model ?? null) : null;
}

function createHandler(
  options: ChatMockOptions,
  requests: ChatRecordedRequest[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const toolRequestsByKey = new Map<string, number>();
  let sequence = 0;
  return async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? "").split("?")[0] ?? "";
    const key = bearerKey(req);
    const withTools = hasTools(raw);
    requests.push({ key, model: modelOf(raw), hasTools: withTools, path });
    const scenario = Object.hasOwn(options.scenarios, key)
      ? options.scenarios[key]
      : undefined;
    if (!path.endsWith(COMPLETIONS_PATH) || scenario === undefined) {
      sendJson(res, HTTP_UNAUTHORIZED, {
        error: { type: "authentication_error", message: "unknown key" },
      });
      return;
    }
    if (!withTools) {
      sendText(res, TITLE_TEXT);
      return;
    }
    sequence += 1;
    const seen = toolRequestsByKey.get(key) ?? 0;
    toolRequestsByKey.set(key, seen + 1);
    if (scenario === ChatScenario.ok) {
      sendText(res, REPLY_TEXT);
    } else if (seen === 0) {
      sendToolCall(res, options.toolCommand, sequence);
    } else {
      sendRateLimited(res);
    }
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("openai chat mock has no TCP address");
  }
  return address.port;
}

export async function startOpenaiChatMock(
  options: ChatMockOptions,
): Promise<OpenaiChatMock> {
  const requests: ChatRecordedRequest[] = [];
  const handle = createHandler(options, requests);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("openai chat mock failed", error);
      res.destroy();
    });
  });
  const port = await listen(server);
  return {
    url: `http://${LOOPBACK_HOST}:${String(port)}${BASE_PATH}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
