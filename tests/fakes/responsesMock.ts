import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod";

import { ROTATION_COMMAND } from "../e2e/rotationFixture";

import { TurnKind, type MockTurn } from "./mockTurn";

export const ResponsesScenario = {
  toolThen429: "tool-then-429",
  ok: "ok",
} as const;
export type ResponsesScenario =
  (typeof ResponsesScenario)[keyof typeof ResponsesScenario];

const LOOPBACK_HOST = "127.0.0.1";
const BASE_PATH = "/v1";
const RESPONSES_PATH = "/responses";
const BEARER_PREFIX = "Bearer ";
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_RATE_LIMITED = 429;
const REPLY_TEXT = "done";
const EXEC_TOOL_NAME = "exec_command";
const SHELL_TOOL_NAME = "shell";
const SHELL_BINARY = "bash";
const SHELL_FLAG = "-lc";
const FUNCTION_CALL_OUTPUT_TYPE = "function_call_output";
const PRIMARY_WINDOW_MINUTES = "300";
const USED_PERCENT_FULL = "100";
const MODELS_STUB = { models: [], data: [] } as const;
const JSON_HEADERS = { "content-type": "application/json" } as const;
const SSE_HEADERS = { "content-type": "text/event-stream" } as const;
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
} as const;

const InputItemSchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  call_id: z.string().optional(),
  output: z.unknown().optional(),
  content: z
    .union([
      z.string(),
      z.array(z.looseObject({ text: z.string().optional() })),
    ])
    .optional(),
});

const RequestBodySchema = z.looseObject({
  model: z.string().optional(),
  input: z.array(InputItemSchema).default([]),
  tools: z.array(z.looseObject({ name: z.string().optional() })).default([]),
});
export type ResponsesRequestBody = z.infer<typeof RequestBodySchema>;
type InputItem = z.infer<typeof InputItemSchema>;

export interface ResponsesMockOptions {
  readonly respond?: (body: ResponsesRequestBody) => MockTurn | undefined;
}

export interface RecordedRequest {
  readonly key: string;
  readonly path: string;
  readonly model: string | null;
  readonly inputText: string;
  readonly functionCallOutputs: number;
  readonly toolNames: readonly string[];
}

export interface ResponsesMock {
  readonly url: string;
  readonly resetEpoch: number;
  requests(): readonly RecordedRequest[];
  close(): Promise<void>;
}

type SseEvent = readonly [string, Record<string, unknown>];

function itemTexts(item: InputItem): string[] {
  if (item.content === undefined) {
    return [];
  }
  if (typeof item.content === "string") {
    return [item.content];
  }
  return item.content.flatMap((part) =>
    part.text === undefined ? [] : [part.text],
  );
}

function record(
  key: string,
  path: string,
  body: ResponsesRequestBody,
): RecordedRequest {
  return {
    key,
    path,
    model: body.model ?? null,
    inputText: body.input.flatMap(itemTexts).join("\n"),
    functionCallOutputs: body.input.filter(
      (item) => item.type === FUNCTION_CALL_OUTPUT_TYPE,
    ).length,
    toolNames: body.tools.flatMap((tool) =>
      tool.name === undefined ? [] : [tool.name],
    ),
  };
}

function parseBody(raw: string): ResponsesRequestBody {
  const parsed = RequestBodySchema.safeParse(JSON.parse(raw || "{}"));
  return parsed.success ? parsed.data : { input: [], tools: [] };
}

function functionCallItem(
  toolNames: readonly string[],
  sequence: number,
): Record<string, unknown> {
  const useExec = toolNames.some((name) => name.includes(EXEC_TOOL_NAME));
  const name = useExec ? EXEC_TOOL_NAME : SHELL_TOOL_NAME;
  const args = useExec
    ? { cmd: ROTATION_COMMAND }
    : { command: [SHELL_BINARY, SHELL_FLAG, ROTATION_COMMAND] };
  return {
    type: "function_call",
    id: `fc_${String(sequence)}`,
    call_id: `call_${String(sequence)}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function messageItem(
  sequence: number,
  text: string = REPLY_TEXT,
): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    id: `msg_${String(sequence)}`,
    content: [{ type: "output_text", text }],
  };
}

function turnItem(turn: MockTurn, sequence: number): Record<string, unknown> {
  if (turn.kind === TurnKind.text) {
    return messageItem(sequence, turn.text);
  }
  return {
    type: "function_call",
    id: `fc_${String(sequence)}`,
    call_id: `call_${String(sequence)}`,
    name: turn.name,
    arguments: JSON.stringify(turn.input),
  };
}

function sendStream(
  res: ServerResponse,
  item: Record<string, unknown>,
  sequence: number,
): void {
  const responseId = `resp_${String(sequence)}`;
  const events: SseEvent[] = [
    [
      "response.created",
      { type: "response.created", response: { id: responseId } },
    ],
    ["response.output_item.done", { type: "response.output_item.done", item }],
    [
      "response.completed",
      {
        type: "response.completed",
        response: { id: responseId, usage: USAGE },
      },
    ],
  ];
  res.writeHead(HTTP_OK, SSE_HEADERS);
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendUsageLimit(res: ServerResponse, resetEpoch: number): void {
  res.writeHead(HTTP_RATE_LIMITED, {
    ...JSON_HEADERS,
    "x-codex-primary-used-percent": USED_PERCENT_FULL,
    "x-codex-primary-window-minutes": PRIMARY_WINDOW_MINUTES,
    "x-codex-primary-reset-at": String(resetEpoch),
  });
  res.end(
    JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "Mock: usage limit reached",
        plan_type: "plus",
        resets_at: resetEpoch,
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

function createHandler(
  scenarios: Readonly<Record<string, ResponsesScenario>>,
  options: ResponsesMockOptions,
  requests: RecordedRequest[],
  resetEpoch: number,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let sequence = 0;
  return async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.includes(RESPONSES_PATH)) {
      sendJson(res, HTTP_OK, MODELS_STUB);
      return;
    }
    const key = bearerKey(req);
    const body = parseBody(raw);
    requests.push(record(key, path, body));
    const scenario = Object.hasOwn(scenarios, key) ? scenarios[key] : undefined;
    if (scenario === undefined) {
      sendJson(res, HTTP_UNAUTHORIZED, {
        error: { type: "authentication_error", message: "unknown key" },
      });
      return;
    }
    sequence += 1;
    const turn = options.respond?.(body);
    if (turn !== undefined) {
      sendStream(res, turnItem(turn, sequence), sequence);
      return;
    }
    const toolNames = record(key, path, body).toolNames;
    const hasOutput = body.input.some(
      (item) => item.type === FUNCTION_CALL_OUTPUT_TYPE,
    );
    if (scenario === ResponsesScenario.ok) {
      sendStream(res, messageItem(sequence), sequence);
    } else if (hasOutput) {
      sendUsageLimit(res, resetEpoch);
    } else {
      sendStream(res, functionCallItem(toolNames, sequence), sequence);
    }
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("responses mock has no TCP address");
  }
  return address.port;
}

export async function startResponsesMock(
  scenarios: Readonly<Record<string, ResponsesScenario>>,
  options: ResponsesMockOptions = {},
): Promise<ResponsesMock> {
  const requests: RecordedRequest[] = [];
  const resetEpoch = Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR;
  const handle = createHandler(scenarios, options, requests, resetEpoch);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("responses mock failed", error);
      res.destroy();
    });
  });
  const port = await listen(server);
  return {
    url: `http://${LOOPBACK_HOST}:${String(port)}${BASE_PATH}`,
    resetEpoch,
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
