import { afterEach, describe, expect, it } from "vitest";

import { TurnKind, type MockTurn } from "./mockTurn";
import {
  ResponsesScenario,
  startResponsesMock,
  type ResponsesMock,
} from "./responsesMock";

const KEY_TOOL = "key-tool";
const KEY_OK = "key-ok";
const COMMAND = "echo deploy-side-effect | tee -a effects.log";
const EXEC_TOOL = "exec_command";
const SHELL_TOOL = "shell";
const RESPONSES_PATH = "/responses";
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_RATE_LIMITED = 429;

const SCENARIOS = {
  [KEY_TOOL]: ResponsesScenario.toolThen429,
  [KEY_OK]: ResponsesScenario.ok,
};

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

const opened: ResponsesMock[] = [];

async function open(): Promise<ResponsesMock> {
  const mock = await startResponsesMock(SCENARIOS);
  opened.push(mock);
  return mock;
}

function userMessage(text: string): object {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

async function post(
  mock: ResponsesMock,
  key: string,
  body: object,
  path = RESPONSES_PATH,
): Promise<Response> {
  return fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block !== "")
    .map((block) => {
      const [eventLine = "", dataLine = ""] = block.split("\n");
      return {
        event: eventLine.replace("event: ", ""),
        data: JSON.parse(dataLine.replace("data: ", "")) as Record<
          string,
          unknown
        >,
      };
    });
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((mock) => mock.close()));
});

describe("responses mock", () => {
  it("unknown_key_is_rejected", async () => {
    const mock = await open();

    const response = await post(mock, "nope", { input: [] });

    expect(response.status).toBe(HTTP_UNAUTHORIZED);
  });

  it("non_responses_path_returns_models_stub", async () => {
    const mock = await open();

    const response = await fetch(`${mock.url}/models`, {
      headers: { authorization: `Bearer ${KEY_OK}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [], data: [] });
  });
});

describe("responses mock streams", () => {
  it("ok_scenario_streams_assistant_message_with_usage", async () => {
    const mock = await open();

    const response = await post(mock, KEY_OK, {
      input: [userMessage("hi")],
      tools: [{ name: EXEC_TOOL }],
    });
    const events = parseSse(await response.text());

    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[1]?.data).toMatchObject({
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text" }],
      },
    });
    expect(events[2]?.data).toMatchObject({
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
  });
});

describe("responses mock tool calls", () => {
  it("tool_call_uses_exec_command_when_offered", async () => {
    const mock = await open();

    const response = await post(mock, KEY_TOOL, {
      input: [userMessage("go")],
      tools: [{ name: SHELL_TOOL }, { name: EXEC_TOOL }],
    });
    const events = parseSse(await response.text());

    expect(events[1]?.data).toMatchObject({
      item: {
        type: "function_call",
        name: EXEC_TOOL,
        arguments: JSON.stringify({ cmd: COMMAND }),
      },
    });
  });

  it("tool_call_uses_shell_when_only_shell_offered", async () => {
    const mock = await open();

    const response = await post(mock, KEY_TOOL, {
      input: [userMessage("go")],
      tools: [{ name: SHELL_TOOL }],
    });
    const events = parseSse(await response.text());

    expect(events[1]?.data).toMatchObject({
      item: {
        type: "function_call",
        name: SHELL_TOOL,
        arguments: JSON.stringify({ command: ["bash", "-lc", COMMAND] }),
      },
    });
  });
});

describe("responses mock respond hook", () => {
  const SCRIPTED_TEXT = "scripted reply";
  const MCP_TOOL = "mcp__codeweave__start_flow";

  async function openScripted(turn: MockTurn): Promise<ResponsesMock> {
    const mock = await startResponsesMock(SCENARIOS, { respond: () => turn });
    opened.push(mock);
    return mock;
  }

  it("text_turn_streams_the_scripted_message", async () => {
    const mock = await openScripted({
      kind: TurnKind.text,
      text: SCRIPTED_TEXT,
    });

    const response = await post(mock, KEY_OK, {
      input: [userMessage("hi")],
      tools: [{ name: MCP_TOOL }],
    });
    const events = parseSse(await response.text());

    expect(events[1]?.data).toMatchObject({
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: SCRIPTED_TEXT }],
      },
    });
  });

  it("tool_turn_streams_a_function_call_with_the_scripted_arguments", async () => {
    const mock = await openScripted({
      kind: TurnKind.tool,
      name: MCP_TOOL,
      input: { flowId: "two-node", placement: "in_place" },
    });

    const response = await post(mock, KEY_TOOL, {
      input: [userMessage("hi")],
      tools: [{ name: MCP_TOOL }],
    });
    const events = parseSse(await response.text());

    expect(events[1]?.data).toMatchObject({
      item: {
        type: "function_call",
        name: MCP_TOOL,
        call_id: "call_1",
        arguments: JSON.stringify({
          flowId: "two-node",
          placement: "in_place",
        }),
      },
    });
  });
});

describe("responses mock namespaced tool calls", () => {
  it("tool_turn_with_a_namespace_streams_it_on_the_function_call", async () => {
    const mock = await startResponsesMock(SCENARIOS, {
      respond: () => ({
        kind: TurnKind.tool,
        namespace: "mcp__codeweave",
        name: "start_flow",
        input: { flowId: "two-node" },
      }),
    });
    opened.push(mock);

    const response = await post(mock, KEY_TOOL, {
      input: [userMessage("hi")],
      tools: [{ name: "exec_command" }],
    });
    const events = parseSse(await response.text());

    expect(events[1]?.data).toMatchObject({
      item: {
        type: "function_call",
        namespace: "mcp__codeweave",
        name: "start_flow",
      },
    });
  });
});

describe("responses mock respond hook input and fallback", () => {
  it("respond_receives_the_parsed_request_body", async () => {
    const seen: unknown[] = [];
    const mock = await startResponsesMock(SCENARIOS, {
      respond: (request) => {
        seen.push(request.input.at(-1));
        return undefined;
      },
    });
    opened.push(mock);

    await post(mock, KEY_OK, {
      input: [
        userMessage("first"),
        {
          type: "function_call_output",
          call_id: "call_9",
          output: "result text",
        },
      ],
      tools: [],
    });

    expect(seen).toEqual([
      {
        type: "function_call_output",
        call_id: "call_9",
        output: "result text",
      },
    ]);
  });

  it("undefined_falls_back_to_the_default_reply", async () => {
    const mock = await startResponsesMock(SCENARIOS, {
      respond: () => undefined,
    });
    opened.push(mock);

    const response = await post(mock, KEY_OK, { input: [], tools: [] });
    const events = parseSse(await response.text());

    expect(events[1]?.data).toMatchObject({
      item: { content: [{ type: "output_text", text: "done" }] },
    });
  });
});

describe("responses mock limits and recording", () => {
  it("tool_then_429_sends_limit_headers_after_tool_output", async () => {
    const mock = await open();
    const expectedReset =
      Math.floor(Date.now() / MS_PER_SECOND) + SECONDS_PER_HOUR;

    const response = await post(mock, KEY_TOOL, {
      input: [
        userMessage("go"),
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
      tools: [{ name: EXEC_TOOL }],
    });

    expect(response.status).toBe(HTTP_RATE_LIMITED);
    expect(response.headers.get("x-codex-primary-used-percent")).toBe("100");
    expect(response.headers.get("x-codex-primary-window-minutes")).toBe("300");
    expect(response.headers.get("x-codex-primary-reset-at")).toBe(
      String(mock.resetEpoch),
    );
    expect(Math.abs(mock.resetEpoch - expectedReset)).toBeLessThanOrEqual(5);
    expect(await response.json()).toEqual({
      error: {
        type: "usage_limit_reached",
        message: "Mock: usage limit reached",
        plan_type: "plus",
        resets_at: mock.resetEpoch,
      },
    });
  });

  it("requests_record_key_input_outputs_and_tools", async () => {
    const mock = await open();

    await post(mock, KEY_OK, {
      input: [
        userMessage("first"),
        { type: "function_call_output", call_id: "call_1", output: "out" },
        userMessage("second"),
      ],
      tools: [{ name: SHELL_TOOL }, { name: EXEC_TOOL }],
    });

    expect(mock.requests()).toEqual([
      {
        key: KEY_OK,
        path: "/v1/responses",
        model: null,
        inputText: "first\nsecond",
        functionCallOutputs: 1,
        toolNames: [SHELL_TOOL, EXEC_TOOL],
      },
    ]);
  });
});
