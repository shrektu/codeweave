import { afterEach, expect, it } from "vitest";

import { TurnKind } from "./mockTurn";
import {
  ChatScenario,
  startOpenaiChatMock,
  type ChatMockOptions,
  type OpenaiChatMock,
} from "./openaiChatMock";

const KEY = "key-tool";
const COMMAND = "echo deploy-side-effect | tee -a effects.log";
const COMPLETIONS_URL_SUFFIX = "/chat/completions";

const opened: OpenaiChatMock[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((mock) => mock.close()));
});

interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

async function firstToolCall(toolNames: readonly string[]): Promise<ToolCall> {
  const mock = await startOpenaiChatMock({
    scenarios: { [KEY]: ChatScenario.toolThen429 },
    toolCommand: COMMAND,
  });
  opened.push(mock);
  const response = await fetch(`${mock.url}${COMPLETIONS_URL_SUFFIX}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "mock-model",
      tools: toolNames.map((name) => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } },
      })),
    }),
  });
  const text = await response.text();
  const call = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as {
          choices: {
            delta: {
              tool_calls?: { function: { name: string; arguments: string } }[];
            };
          }[];
        },
    )
    .flatMap((frame) => frame.choices)
    .flatMap((choice) => choice.delta.tool_calls ?? [])[0];
  if (call === undefined) {
    throw new Error(`no tool call in: ${text}`);
  }
  return {
    name: call.function.name,
    arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
  };
}

async function scriptedFrames(
  respond: ChatMockOptions["respond"],
  body: object,
): Promise<string> {
  const mock = await startOpenaiChatMock({
    scenarios: { [KEY]: ChatScenario.ok },
    toolCommand: COMMAND,
    ...(respond === undefined ? {} : { respond }),
  });
  opened.push(mock);
  const response = await fetch(`${mock.url}${COMPLETIONS_URL_SUFFIX}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return response.text();
}

const SCRIPTED_TEXT = "scripted reply";
const MCP_TOOL = "codeweave_start_flow";
const WITH_TOOL = {
  model: "mock-model",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: MCP_TOOL } }],
};

it("respond_text_turn_streams_the_scripted_content", async () => {
  const text = await scriptedFrames(
    () => ({ kind: TurnKind.text, text: SCRIPTED_TEXT }),
    WITH_TOOL,
  );

  expect(text).toContain(JSON.stringify(SCRIPTED_TEXT));
  expect(text).not.toContain('"content":"done"');
});

it("respond_tool_turn_streams_a_tool_call_with_the_scripted_arguments", async () => {
  const text = await scriptedFrames(
    () => ({
      kind: TurnKind.tool,
      name: MCP_TOOL,
      input: { flowId: "two-node" },
    }),
    WITH_TOOL,
  );

  const call = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as {
          choices: {
            delta: {
              tool_calls?: { id: string; function: Record<string, string> }[];
            };
            finish_reason: string | null;
          }[];
        },
    )
    .flatMap((frame) => frame.choices)
    .flatMap((choice) => choice.delta.tool_calls ?? [])[0];
  expect(call).toEqual({
    index: 0,
    id: "call_1",
    type: "function",
    function: {
      name: MCP_TOOL,
      arguments: JSON.stringify({ flowId: "two-node" }),
    },
  });
  expect(text).toContain('"finish_reason":"tool_calls"');
});

it("respond_receives_the_parsed_request_body", async () => {
  const seen: string[] = [];

  await scriptedFrames((request) => {
    seen.push(
      ...request.messages.map((message) => message.role ?? ""),
      ...request.tools.map((tool) => tool.function?.name ?? ""),
    );
    return undefined;
  }, WITH_TOOL);

  expect(seen).toEqual(["user", MCP_TOOL]);
});

it("respond_undefined_falls_back_to_the_default_reply", async () => {
  const text = await scriptedFrames(() => undefined, WITH_TOOL);

  expect(text).toContain('"content":"done"');
});

it("mock_calls_shell_when_the_request_offers_shell", async () => {
  const call = await firstToolCall(["read", "shell"]);

  expect(call).toEqual({ name: "shell", arguments: { command: COMMAND } });
});

it("mock_calls_bash_when_shell_is_not_offered", async () => {
  const call = await firstToolCall(["read", "bash"]);

  expect(call).toEqual({
    name: "bash",
    arguments: { command: COMMAND, description: "Record the side effect" },
  });
});
