import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const GeminiScenario = {
  toolThen429: "tool-then-429",
  sudoThenDone: "sudo-then-done",
  editFile: "edit-file",
  ok: "ok",
} as const;
export type GeminiScenario =
  (typeof GeminiScenario)[keyof typeof GeminiScenario];

export const GeminiRequestKind = {
  main: "main",
  side: "side",
  unknown: "unknown",
} as const;
export type GeminiRequestKind =
  (typeof GeminiRequestKind)[keyof typeof GeminiRequestKind];

export interface GeminiRecordedRequest {
  readonly kind: GeminiRequestKind;
  readonly model: string;
  readonly path: string;
  readonly body: unknown;
}

export interface GeminiEditFiles {
  readonly createPath: string;
  readonly editPath: string;
  readonly editTarget: string;
  readonly editReplacement: string;
}

export interface GeminiMockOptions {
  readonly scenario: GeminiScenario;
  readonly toolCommand?: string;
  readonly editFiles?: GeminiEditFiles;
}

export interface GeminiApiMock {
  readonly baseUrl: string;
  requests(kind?: GeminiRequestKind): readonly GeminiRecordedRequest[];
  close(): Promise<void>;
}

const LOOPBACK_HOST = "127.0.0.1";
const GENERATE_PATH_PATTERN =
  /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/;
const SIDE_MODEL_MARKER = "flash-lite";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_RATE_LIMITED = 429;
const SSE_TERMINATOR = "\r\n\r\n";
const JSON_HEADERS = { "content-type": "application/json" } as const;
const SSE_HEADERS = { "content-type": "text/event-stream" } as const;
const RUN_COMMAND_TOOL = "run_command";
const WRITE_FILE_TOOL = "write_file";
const EDIT_FILE_TOOL = "edit_file";
const CREATED_FILE_CONTENT = "first line\nsecond line\n";
const WAIT_MS_BEFORE_ASYNC = 5000;
const DEFAULT_TOOL_COMMAND = "echo side-effect | tee -a effects.log";
const DEFAULT_TOOL_SUMMARY = "Record the effect";
const SUDO_COMMAND = "sudo true";
const SUDO_SUMMARY = "Run sudo";
const SIDE_TEXT = "ok";
const OK_TEXT = "OK";
const DONE_TEXT = "DONE";
const QUOTA_MESSAGE = "You exceeded your current quota.";
const QUOTA_STATUS = "RESOURCE_EXHAUSTED";
const QUOTA_METRIC =
  "generativelanguage.googleapis.com/generate_content_free_tier_requests";
const QUOTA_ID = "GenerateRequestsPerDayPerProjectPerModel-FreeTier";
const QUOTA_VALUE = "50";
const RETRY_DELAY = "43200s";

const ReplyKind = {
  tool: "tool",
  call: "call",
  text: "text",
  quota: "quota",
} as const;

type Reply =
  | {
      readonly kind: typeof ReplyKind.tool;
      readonly command: string;
      readonly summary: string;
    }
  | {
      readonly kind: typeof ReplyKind.call;
      readonly name: string;
      readonly args: Readonly<Record<string, string>>;
    }
  | { readonly kind: typeof ReplyKind.text; readonly text: string }
  | { readonly kind: typeof ReplyKind.quota };

const QUOTA_REPLY: Reply = { kind: ReplyKind.quota };

function textReply(text: string): Reply {
  return { kind: ReplyKind.text, text };
}

function editFileSteps(files: GeminiEditFiles | undefined): readonly Reply[] {
  if (files === undefined) {
    throw new Error("the edit-file scenario needs editFiles");
  }
  return [
    {
      kind: ReplyKind.call,
      name: WRITE_FILE_TOOL,
      args: { Path: files.createPath, Content: CREATED_FILE_CONTENT },
    },
    {
      kind: ReplyKind.call,
      name: EDIT_FILE_TOOL,
      args: {
        Path: files.editPath,
        Target: files.editTarget,
        Replacement: files.editReplacement,
      },
    },
    textReply(DONE_TEXT),
  ];
}

function stepsOf(options: GeminiMockOptions): readonly Reply[] {
  switch (options.scenario) {
    case GeminiScenario.toolThen429:
      return [
        {
          kind: ReplyKind.tool,
          command: options.toolCommand ?? DEFAULT_TOOL_COMMAND,
          summary: DEFAULT_TOOL_SUMMARY,
        },
        QUOTA_REPLY,
      ];
    case GeminiScenario.sudoThenDone:
      return [
        { kind: ReplyKind.tool, command: SUDO_COMMAND, summary: SUDO_SUMMARY },
        textReply(DONE_TEXT),
      ];
    case GeminiScenario.editFile:
      return editFileSteps(options.editFiles);
    case GeminiScenario.ok:
      return [textReply(OK_TEXT)];
  }
}

function sendParts(res: ServerResponse, parts: readonly object[]): void {
  const chunk = {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  };
  res.writeHead(HTTP_OK, SSE_HEADERS);
  res.end(`data: ${JSON.stringify(chunk)}${SSE_TERMINATOR}`);
}

function sendFunctionCall(
  res: ServerResponse,
  name: string,
  args: Readonly<Record<string, unknown>>,
): void {
  sendParts(res, [{ functionCall: { name, args } }]);
}

function sendQuotaExceeded(res: ServerResponse): void {
  res.writeHead(HTTP_RATE_LIMITED, JSON_HEADERS);
  res.end(
    JSON.stringify({
      error: {
        code: HTTP_RATE_LIMITED,
        message: QUOTA_MESSAGE,
        status: QUOTA_STATUS,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: QUOTA_METRIC,
                quotaId: QUOTA_ID,
                quotaValue: QUOTA_VALUE,
              },
            ],
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: RETRY_DELAY,
          },
        ],
      },
    }),
  );
}

function sendNotFound(res: ServerResponse): void {
  res.writeHead(HTTP_NOT_FOUND, JSON_HEADERS);
  res.end(
    JSON.stringify({
      error: { code: HTTP_NOT_FOUND, message: "unknown path" },
    }),
  );
}

function sendReply(res: ServerResponse, reply: Reply): void {
  switch (reply.kind) {
    case ReplyKind.tool:
      sendFunctionCall(res, RUN_COMMAND_TOOL, {
        CommandLine: reply.command,
        IsDaemon: false,
        WaitMsBeforeAsync: WAIT_MS_BEFORE_ASYNC,
        toolSummary: reply.summary,
      });
      return;
    case ReplyKind.call:
      sendFunctionCall(res, reply.name, reply.args);
      return;
    case ReplyKind.text:
      sendParts(res, [{ text: reply.text }]);
      return;
    case ReplyKind.quota:
      sendQuotaExceeded(res);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw === "" ? "{}" : raw);
}

function kindOf(model: string | undefined): GeminiRequestKind {
  if (model === undefined) {
    return GeminiRequestKind.unknown;
  }
  return model.includes(SIDE_MODEL_MARKER)
    ? GeminiRequestKind.side
    : GeminiRequestKind.main;
}

function createHandler(
  options: GeminiMockOptions,
  requests: GeminiRecordedRequest[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const steps = stepsOf(options);
  return async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? "").split("?")[0] ?? "";
    const model = GENERATE_PATH_PATTERN.exec(path)?.[1];
    const kind = kindOf(model);
    const mainBefore = requests.filter(
      (request) => request.kind === GeminiRequestKind.main,
    ).length;
    requests.push({ kind, model: model ?? "", path, body });
    if (kind === GeminiRequestKind.unknown) {
      sendNotFound(res);
    } else if (kind === GeminiRequestKind.side) {
      sendReply(res, textReply(SIDE_TEXT));
    } else {
      const last = steps.length - 1;
      sendReply(res, steps[Math.min(mainBefore, last)] ?? QUOTA_REPLY);
    }
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("gemini api mock has no TCP address");
  }
  return address.port;
}

export async function startGeminiApiMock(
  options: GeminiMockOptions,
): Promise<GeminiApiMock> {
  const requests: GeminiRecordedRequest[] = [];
  const handle = createHandler(options, requests);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("gemini api mock failed", error);
      res.destroy();
    });
  });
  const port = await listen(server);
  return {
    baseUrl: `http://${LOOPBACK_HOST}:${String(port)}`,
    requests: (kind) =>
      kind === undefined
        ? requests
        : requests.filter((request) => request.kind === kind),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
