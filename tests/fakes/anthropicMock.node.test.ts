import { afterEach, describe, expect, it } from "vitest";

import {
  MockScenario,
  startAnthropicMock,
  type AnthropicMock,
  type AnthropicMockOptions,
  type MessagesBody,
} from "./anthropicMock";
import { TurnKind, type MockTurn } from "./mockTurn";

const KEY = "key-ok";
const COMMAND = "echo deploy-side-effect | tee -a effects.log";
const SCRIPTED_TEXT = "scripted reply";
const TOOL_NAME = "mcp__codeweave__start_flow";
const BASH_TOOL = "Bash";

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

const opened: AnthropicMock[] = [];

async function open(
  options: Partial<AnthropicMockOptions> = {},
): Promise<AnthropicMock> {
  const mock = await startAnthropicMock({
    scenarios: { [KEY]: MockScenario.ok },
    toolCommand: COMMAND,
    ...options,
  });
  opened.push(mock);
  return mock;
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

async function post(mock: AnthropicMock, body: object): Promise<SseEvent[]> {
  const response = await fetch(`${mock.url}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseSse(await response.text());
}

function mainRequest(text: string): object {
  return {
    tools: [{ name: BASH_TOOL }, { name: TOOL_NAME }],
    messages: [{ role: "user", content: text }],
  };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((mock) => mock.close()));
});

describe("anthropic mock respond hook", () => {
  it("text_turn_streams_the_scripted_text", async () => {
    const mock = await open({
      respond: () => ({ kind: TurnKind.text, text: SCRIPTED_TEXT }),
    });

    const events = await post(mock, mainRequest("hi"));

    expect(events.map((event) => event.data)).toContainEqual(
      expect.objectContaining({
        delta: { type: "text_delta", text: SCRIPTED_TEXT },
      }),
    );
  });

  it("tool_turn_streams_a_tool_use_with_the_scripted_input", async () => {
    const turn: MockTurn = {
      kind: TurnKind.tool,
      name: TOOL_NAME,
      input: { flowId: "two-node", placement: "in_place" },
    };
    const mock = await open({ respond: () => turn });

    const events = await post(mock, mainRequest("hi"));

    expect(events[1]?.data).toMatchObject({
      content_block: { type: "tool_use", name: TOOL_NAME },
    });
    expect(events[2]?.data).toMatchObject({
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          flowId: "two-node",
          placement: "in_place",
        }),
      },
    });
    expect(events.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
    });
  });

  it("two_tool_turns_get_distinct_tool_use_ids", async () => {
    const mock = await open({
      respond: () => ({ kind: TurnKind.tool, name: TOOL_NAME, input: {} }),
    });

    const first = await post(mock, mainRequest("one"));
    const second = await post(mock, mainRequest("two"));

    const idOf = (events: SseEvent[]): unknown =>
      (events[1]?.data.content_block as { id: unknown }).id;
    expect(idOf(first)).not.toEqual(idOf(second));
  });
});

describe("anthropic mock respond hook input and fallback", () => {
  it("respond_receives_the_parsed_request_body", async () => {
    const seen: MessagesBody[] = [];
    const mock = await open({
      respond: (body) => {
        seen.push(body);
        return undefined;
      },
    });

    await post(mock, mainRequest("hello there"));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.tools?.map((tool) => tool.name)).toEqual([
      BASH_TOOL,
      TOOL_NAME,
    ]);
    expect(seen[0]?.messages[0]?.content).toBe("hello there");
  });

  it("undefined_falls_back_to_the_default_reply", async () => {
    const mock = await open({ respond: () => undefined });

    const events = await post(mock, mainRequest("hi"));

    expect(events.map((event) => event.data)).toContainEqual(
      expect.objectContaining({ delta: { type: "text_delta", text: "done" } }),
    );
  });
});
