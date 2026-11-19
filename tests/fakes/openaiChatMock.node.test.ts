import { afterEach, expect, it } from "vitest";

import {
  ChatScenario,
  startOpenaiChatMock,
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
