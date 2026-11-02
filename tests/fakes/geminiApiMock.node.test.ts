import { afterEach, describe, expect, it } from "vitest";

import {
  GeminiRequestKind,
  GeminiScenario,
  startGeminiApiMock,
  type GeminiApiMock,
} from "./geminiApiMock";

const MAIN_MODEL = "gemini-3.1-pro-preview";
const SIDE_MODEL = "gemini-3.1-flash-lite-preview";
const TOOL_COMMAND = "echo deploy-side-effect | tee -a effects.log";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_RATE_LIMITED = 429;
const QUOTA_FAILURE_TYPE = "type.googleapis.com/google.rpc.QuotaFailure";
const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";

interface SsePart {
  readonly text?: string;
  readonly functionCall?: {
    readonly name: string;
    readonly args: Record<string, string | number | boolean>;
  };
}

interface SseChunk {
  readonly candidates: readonly {
    readonly content: { readonly role: string; readonly parts: SsePart[] };
    readonly finishReason: string;
  }[];
}

interface ErrorBody {
  readonly error: {
    readonly code: number;
    readonly status: string;
    readonly details: readonly Record<string, unknown>[];
  };
}

const opened: GeminiApiMock[] = [];

async function open(
  scenario: GeminiScenario,
  toolCommand = TOOL_COMMAND,
): Promise<GeminiApiMock> {
  const mock = await startGeminiApiMock({ scenario, toolCommand });
  opened.push(mock);
  return mock;
}

async function generate(
  mock: GeminiApiMock,
  model: string,
  body: object = { contents: [] },
): Promise<Response> {
  return fetch(
    `${mock.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function sseChunks(text: string): SseChunk[] {
  return text
    .split("\r\n\r\n")
    .filter((block) => block !== "")
    .map((block) => JSON.parse(block.replace("data: ", "")) as SseChunk);
}

async function partsOf(response: Response): Promise<SsePart[]> {
  return sseChunks(await response.text()).flatMap((chunk) =>
    chunk.candidates.flatMap((candidate) => candidate.content.parts),
  );
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((mock) => mock.close()));
});

describe("geminiApiMock tool then 429", () => {
  it("tool_then_429_answers_a_tool_call_then_a_fatal_quota_error", async () => {
    const mock = await open(GeminiScenario.toolThen429);

    const first = await generate(mock, MAIN_MODEL);
    expect(first.status).toBe(HTTP_OK);
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    expect(await partsOf(first)).toEqual([
      {
        functionCall: {
          name: "run_command",
          args: {
            CommandLine: TOOL_COMMAND,
            IsDaemon: false,
            WaitMsBeforeAsync: 5000,
            toolSummary: "Record the effect",
          },
        },
      },
    ]);

    const second = await generate(mock, MAIN_MODEL);
    expect(second.status).toBe(HTTP_RATE_LIMITED);
    expect(second.headers.get("content-type")).toBe("application/json");
    const body = (await second.json()) as ErrorBody;
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(body.error.code).toBe(HTTP_RATE_LIMITED);
  });

  it("the_429_always_carries_quota_failure_and_retry_info_details", async () => {
    const mock = await open(GeminiScenario.toolThen429);
    await generate(mock, MAIN_MODEL);

    const body = (await (await generate(mock, MAIN_MODEL)).json()) as ErrorBody;

    expect(body.error.details.map((detail) => detail["@type"])).toEqual([
      QUOTA_FAILURE_TYPE,
      RETRY_INFO_TYPE,
    ]);
    expect(body.error.details[1]).toMatchObject({ retryDelay: "43200s" });
  });

  it("tool_then_429_keeps_answering_429_after_the_second_request", async () => {
    const mock = await open(GeminiScenario.toolThen429);
    await generate(mock, MAIN_MODEL);
    await generate(mock, MAIN_MODEL);

    const third = await generate(mock, MAIN_MODEL);

    expect(third.status).toBe(HTTP_RATE_LIMITED);
    expect(((await third.json()) as ErrorBody).error.details).toHaveLength(2);
  });
});

describe("geminiApiMock other scenarios", () => {
  it("sudo_then_done_answers_sudo_true_then_done", async () => {
    const mock = await open(GeminiScenario.sudoThenDone);

    const first = await partsOf(await generate(mock, MAIN_MODEL));
    const second = await partsOf(await generate(mock, MAIN_MODEL));

    expect(first).toEqual([
      {
        functionCall: {
          name: "run_command",
          args: {
            CommandLine: "sudo true",
            IsDaemon: false,
            WaitMsBeforeAsync: 5000,
            toolSummary: "Run sudo",
          },
        },
      },
    ]);
    expect(second).toEqual([{ text: "DONE" }]);
  });

  it("ok_answers_text_ok_every_time", async () => {
    const mock = await open(GeminiScenario.ok);

    const first = await partsOf(await generate(mock, MAIN_MODEL));
    const second = await partsOf(await generate(mock, MAIN_MODEL));

    expect(first).toEqual([{ text: "OK" }]);
    expect(second).toEqual([{ text: "OK" }]);
  });

  it("flash_lite_requests_are_recorded_apart_and_do_not_advance_the_scenario", async () => {
    const mock = await open(GeminiScenario.toolThen429);

    const side = await generate(mock, SIDE_MODEL, { contents: ["side"] });
    const main = await generate(mock, MAIN_MODEL, { contents: ["main"] });

    expect(side.status).toBe(HTTP_OK);
    expect(await partsOf(side)).toEqual([{ text: "ok" }]);
    expect((await partsOf(main))[0]?.functionCall?.name).toBe("run_command");
    expect(
      mock.requests(GeminiRequestKind.side).map((request) => request.model),
    ).toEqual([SIDE_MODEL]);
    expect(
      mock.requests(GeminiRequestKind.main).map((request) => request.model),
    ).toEqual([MAIN_MODEL]);
  });
});

describe("geminiApiMock unknown paths", () => {
  it("main_requests_keep_the_model_and_parsed_json_body", async () => {
    const mock = await open(GeminiScenario.ok);
    const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };

    await generate(mock, MAIN_MODEL, body);

    expect(mock.requests(GeminiRequestKind.main)).toEqual([
      {
        kind: GeminiRequestKind.main,
        model: MAIN_MODEL,
        path: `/v1beta/models/${MAIN_MODEL}:streamGenerateContent`,
        body,
      },
    ]);
  });

  it("unknown_path_404", async () => {
    const mock = await open(GeminiScenario.ok);

    const response = await fetch(`${mock.baseUrl}/v1beta/other`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(HTTP_NOT_FOUND);
    expect(mock.requests(GeminiRequestKind.unknown)).toEqual([
      {
        kind: GeminiRequestKind.unknown,
        model: "",
        path: "/v1beta/other",
        body: {},
      },
    ]);
    expect(mock.requests(GeminiRequestKind.main)).toEqual([]);
  });

  it("requests_without_a_kind_return_everything_in_arrival_order", async () => {
    const mock = await open(GeminiScenario.ok);

    await generate(mock, SIDE_MODEL);
    await generate(mock, MAIN_MODEL);

    expect(mock.requests().map((request) => request.kind)).toEqual([
      GeminiRequestKind.side,
      GeminiRequestKind.main,
    ]);
  });
});
