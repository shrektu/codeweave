import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod";

import { TurnKind, type MockTurn, type ToolInput } from "./mockTurn";

export const MockScenario = {
  toolThen429: "tool-then-429",
  ok: "ok",
} as const;
export type MockScenario = (typeof MockScenario)[keyof typeof MockScenario];

export const MARKDOWN_REPLY = [
  "## Report",
  "",
  "| file | lines |",
  "| ---- | ----- |",
  "| a.ts | 10 |",
  "",
  "```ts",
  "const total: number = 1;",
  "```",
  "",
  "```bash",
  "$ echo codeweave-copy",
  "codeweave-copy",
  "```",
  "",
  "<b>raw html</b>",
  "",
  "Read [the docs](https://example.com/docs).",
].join("\n");

const LOOPBACK_HOST = "127.0.0.1";
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/count_tokens";
const API_KEY_HEADER = "x-api-key";
const BASH_TOOL_NAME = "Bash";
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_RATE_LIMITED = 429;
const SIDE_REPLY = "mock";
const DONE_REPLY = "done";
const TOOL_USE_ID = "toolu_mock_bash";
const MODEL = "claude-mock";
const JSON_HEADERS = { "content-type": "application/json" } as const;
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "request-id": "req_mock",
} as const;

const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  tool_use_id: z.string().optional(),
  content: z
    .union([
      z.string(),
      z.array(z.looseObject({ text: z.string().optional() })),
    ])
    .optional(),
});

const MessageSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

export const MessagesBodySchema = z.looseObject({
  model: z.string().optional(),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z.array(MessageSchema).default([]),
});
export type MessagesBody = z.infer<typeof MessagesBodySchema>;
type MessageBlock = z.infer<typeof ContentBlockSchema>;

export interface MockRequestRecord {
  readonly at: number;
  readonly url: string;
  readonly key: string | null;
  readonly isMain: boolean;
  readonly body: MessagesBody;
}

export interface AnthropicMockOptions {
  readonly scenarios: Readonly<Record<string, MockScenario>>;
  readonly toolCommand: string;
  readonly onMainRequest?: (key: string, body: MessagesBody) => Promise<void>;
  readonly replyText?: (body: MessagesBody) => string;
  readonly respond?: (body: MessagesBody) => MockTurn | undefined;
}

export interface AnthropicMock {
  readonly url: string;
  readonly requests: readonly MockRequestRecord[];
  readonly resetAtSeconds: number;
  close(): Promise<void>;
}

type SseEvent = readonly [string, Record<string, unknown>];

function blocks(
  content: MessagesBody["messages"][number]["content"],
): MessageBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

export function userTexts(body: MessagesBody): string[] {
  return body.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => blocks(message.content))
    .flatMap((block) => (block.text === undefined ? [] : [block.text]));
}

function hasToolResult(body: MessagesBody): boolean {
  return body.messages.some((message) =>
    blocks(message.content).some((block) => block.type === "tool_result"),
  );
}

function isMainRequest(body: MessagesBody): boolean {
  return (body.tools ?? []).some((tool) => tool.name === BASH_TOOL_NAME);
}

function messageStart(id: string): SseEvent {
  return [
    "message_start",
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
}

function messageEnd(stopReason: string): SseEvent[] {
  return [
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

function textEvents(text: string): SseEvent[] {
  return [
    messageStart("msg_text"),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...messageEnd("end_turn"),
  ];
}

function toolUseEvents(id: string, name: string, input: ToolInput): SseEvent[] {
  return [
    messageStart("msg_tool"),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input),
        },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...messageEnd("tool_use"),
  ];
}

function turnEvents(turn: MockTurn, sequence: number): SseEvent[] {
  return turn.kind === TurnKind.text
    ? textEvents(turn.text)
    : toolUseEvents(`toolu_mock_${String(sequence)}`, turn.name, turn.input);
}

function sendSse(res: ServerResponse, events: readonly SseEvent[]): void {
  res.writeHead(HTTP_OK, SSE_HEADERS);
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function sendRateLimit(res: ServerResponse, resetAtSeconds: number): void {
  const reset = String(resetAtSeconds);
  res.writeHead(HTTP_RATE_LIMITED, {
    ...JSON_HEADERS,
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": reset,
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": reset,
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "retry-after": String(SECONDS_PER_HOUR),
    "x-should-retry": "false",
  });
  res.end(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Mock: usage limit reached",
      },
    }),
  );
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(raw: string): MessagesBody {
  const parsed = MessagesBodySchema.safeParse(JSON.parse(raw || "{}"));
  return parsed.success ? parsed.data : { messages: [] };
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

function respondMain(
  res: ServerResponse,
  scenario: MockScenario,
  body: MessagesBody,
  options: {
    toolCommand: string;
    resetAtSeconds: number;
    replyText: ((body: MessagesBody) => string) | undefined;
  },
): void {
  if (scenario === MockScenario.ok) {
    sendSse(res, textEvents(options.replyText?.(body) ?? DONE_REPLY));
  } else if (hasToolResult(body)) {
    sendRateLimit(res, options.resetAtSeconds);
  } else {
    sendSse(
      res,
      toolUseEvents(TOOL_USE_ID, BASH_TOOL_NAME, {
        command: options.toolCommand,
        description: "mock tool",
      }),
    );
  }
}

function createHandler(
  options: AnthropicMockOptions,
  requests: MockRequestRecord[],
  resetAtSeconds: number,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let sequence = 0;
  return async (req, res) => {
    const url = req.url ?? "";
    const raw = await readBody(req);
    if (!url.startsWith(MESSAGES_PATH)) {
      sendJson(res, HTTP_OK, {});
      return;
    }
    if (url.includes(COUNT_TOKENS_PATH)) {
      sendJson(res, HTTP_OK, { input_tokens: 10 });
      return;
    }
    const body = parseBody(raw);
    const key = headerValue(req, API_KEY_HEADER);
    const isMain = isMainRequest(body);
    requests.push({ at: Date.now(), url, key, isMain, body });
    const scenario = key === null ? undefined : options.scenarios[key];
    if (key === null || scenario === undefined) {
      sendJson(res, HTTP_UNAUTHORIZED, {
        type: "error",
        error: { type: "authentication_error", message: "unknown key" },
      });
      return;
    }
    if (!isMain) {
      sendSse(res, textEvents(SIDE_REPLY));
      return;
    }
    await options.onMainRequest?.(key, body);
    sequence += 1;
    const turn = options.respond?.(body);
    if (turn !== undefined) {
      sendSse(res, turnEvents(turn, sequence));
      return;
    }
    respondMain(res, scenario, body, {
      toolCommand: options.toolCommand,
      resetAtSeconds,
      replyText: options.replyText,
    });
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("anthropic mock has no TCP address");
  }
  return address.port;
}

export async function startAnthropicMock(
  options: AnthropicMockOptions,
): Promise<AnthropicMock> {
  const requests: MockRequestRecord[] = [];
  const resetAtSeconds =
    Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR;
  const handle = createHandler(options, requests, resetAtSeconds);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("anthropic mock failed", error);
      res.destroy();
    });
  });
  const port = await listen(server);
  return {
    url: `http://${LOOPBACK_HOST}:${String(port)}`,
    requests,
    resetAtSeconds,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
