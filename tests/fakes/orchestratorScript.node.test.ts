import { describe, expect, it } from "vitest";

import {
  LastKind,
  anthropicTranscript,
  chatTranscript,
  isOrchestratorRequest,
  nextOrchestratorStep,
  responsesTranscript,
  type OrchestratorTranscript,
  type TranscriptLast,
} from "../e2e/orchestratorScript";

import { TurnKind } from "./mockTurn";

const RUN_ID = "run-42";
const START_RESULT = JSON.stringify({ runId: RUN_ID, status: "running" });
const WAKE_UP_DECISION =
  "[Codeweave] These flows need your attention.\n\nDecision needed: missing_verdict at node review. Call decide with one of: approve, another_round, stop.";
const WAKE_UP_FINISHED =
  "[Codeweave] These flows need your attention.\n\nStatus: done";
const FLOW_TOOLS = ["list_flows", "start_flow", "decide", "flow_diff"] as const;

function namesWith(prefix: string): string[] {
  return FLOW_TOOLS.map((name) => `${prefix}${name}`);
}

function transcript(
  last: TranscriptLast,
  calls: OrchestratorTranscript["calls"],
  prefix = "mcp__codeweave__",
): OrchestratorTranscript {
  return { toolNames: ["Bash", ...namesWith(prefix)], calls, last };
}

const START_CALLS = [
  { tool: "mcp__codeweave__list_flows", result: "{}" },
  { tool: "mcp__codeweave__start_flow", result: START_RESULT },
];

describe("nextOrchestratorStep on tool results", () => {
  it("lists_flows_first", () => {
    const first = transcript({ kind: LastKind.userText, text: "task" }, []);

    expect(nextOrchestratorStep(first)).toEqual({
      kind: TurnKind.tool,
      name: "mcp__codeweave__list_flows",
      input: {},
    });
  });

  it("starts_the_flow_after_the_list", () => {
    const step = nextOrchestratorStep(
      transcript(
        {
          kind: LastKind.toolResult,
          tool: "mcp__codeweave__list_flows",
          text: "{}",
        },
        [{ tool: "mcp__codeweave__list_flows", result: "{}" }],
      ),
    );

    expect(step).toEqual({
      kind: TurnKind.tool,
      name: "mcp__codeweave__start_flow",
      input: {
        flowId: "two-node",
        task: "Add a greeting helper",
        placement: "in_place",
      },
    });
  });

  it("waits_after_start_and_after_decide", () => {
    for (const tool of ["start_flow", "decide"]) {
      const step = nextOrchestratorStep(
        transcript(
          {
            kind: LastKind.toolResult,
            tool: `mcp__codeweave__${tool}`,
            text: START_RESULT,
          },
          START_CALLS,
        ),
      );

      expect(step).toEqual({
        kind: TurnKind.text,
        text: "The flow is running; waiting for it.",
      });
    }
  });
});

describe("nextOrchestratorStep on wake-ups", () => {
  it("decides_with_a_note_on_the_decision_wake_up", () => {
    const step = nextOrchestratorStep(
      transcript(
        { kind: LastKind.userText, text: WAKE_UP_DECISION },
        START_CALLS,
      ),
    );

    expect(step).toEqual({
      kind: TurnKind.tool,
      name: "mcp__codeweave__decide",
      input: {
        runId: RUN_ID,
        decision: "approve",
        note: "Approved: the diff adds the greeting helper.",
      },
    });
  });

  it("reads_the_diff_on_the_finished_wake_up_and_then_answers", () => {
    const diff = nextOrchestratorStep(
      transcript(
        { kind: LastKind.userText, text: WAKE_UP_FINISHED },
        START_CALLS,
      ),
    );
    const final = nextOrchestratorStep(
      transcript(
        {
          kind: LastKind.toolResult,
          tool: "mcp__codeweave__flow_diff",
          text: "+greeting",
        },
        [
          ...START_CALLS,
          { tool: "mcp__codeweave__flow_diff", result: "+greeting" },
        ],
      ),
    );

    expect(diff).toEqual({
      kind: TurnKind.tool,
      name: "mcp__codeweave__flow_diff",
      input: { runId: RUN_ID },
    });
    expect(final).toEqual({
      kind: TurnKind.text,
      text: "All done: the greeting helper was added.",
    });
  });
});

describe("nextOrchestratorStep on unexpected transcripts", () => {
  it("throws_with_the_transcript_on_a_tool_result_it_does_not_script", () => {
    const unexpected = transcript(
      {
        kind: LastKind.toolResult,
        tool: "mcp__codeweave__node_result",
        text: "x",
      },
      START_CALLS,
    );

    expect(() => nextOrchestratorStep(unexpected)).toThrow(
      /unexpected orchestrator transcript: .*node_result/,
    );
  });

  it("throws_on_user_text_that_is_not_a_wake_up", () => {
    const unexpected = transcript(
      { kind: LastKind.userText, text: "please also fix the docs" },
      START_CALLS,
    );

    expect(() => nextOrchestratorStep(unexpected)).toThrow(
      /unexpected orchestrator transcript/,
    );
  });

  it("throws_when_the_wake_up_arrives_before_any_flow_was_started", () => {
    const unexpected = transcript(
      { kind: LastKind.userText, text: WAKE_UP_DECISION },
      [{ tool: "mcp__codeweave__list_flows", result: "{}" }],
    );

    expect(() => nextOrchestratorStep(unexpected)).toThrow(
      /unexpected orchestrator transcript/,
    );
  });

  it("throws_naming_the_offered_tools_when_the_needed_tool_is_missing", () => {
    const missing: OrchestratorTranscript = {
      toolNames: ["Bash", "mcp__codeweave__list_flows"],
      calls: [{ tool: "mcp__codeweave__list_flows", result: "{}" }],
      last: {
        kind: LastKind.toolResult,
        tool: "mcp__codeweave__list_flows",
        text: "{}",
      },
    };

    expect(() => nextOrchestratorStep(missing)).toThrow(
      /start_flow is not offered; offered: Bash, mcp__codeweave__list_flows/,
    );
  });
});

describe("tool name suffix resolution", () => {
  it.each(["mcp__codeweave__", "codeweave__", "codeweave_"])(
    "picks_the_decide_tool_named_with_prefix_%s",
    (prefix) => {
      const calls = START_CALLS.map((call) => ({
        ...call,
        tool: call.tool.replace("mcp__codeweave__", prefix),
      }));

      const step = nextOrchestratorStep(
        transcript(
          { kind: LastKind.userText, text: WAKE_UP_DECISION },
          calls,
          prefix,
        ),
      );

      expect(step).toMatchObject({
        kind: TurnKind.tool,
        name: `${prefix}decide`,
      });
    },
  );

  it("does_not_match_a_tool_that_merely_contains_the_name", () => {
    expect(isOrchestratorRequest(["Bash", "my_list_flows_extra"])).toBe(false);
    expect(isOrchestratorRequest(["Bash", "codeweave_list_flows"])).toBe(true);
  });
});

describe("anthropic transcript adapter", () => {
  it("anthropic_pairs_results_with_calls_and_ignores_trailing_system", () => {
    const body = anthropicTranscript({
      tools: [{ name: "Bash" }, { name: "mcp__codeweave__list_flows" }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__codeweave__list_flows",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "flows json" }],
            },
          ],
        },
        { role: "system", content: "reminder" },
      ],
    });

    expect(body).toEqual({
      toolNames: ["Bash", "mcp__codeweave__list_flows"],
      calls: [{ tool: "mcp__codeweave__list_flows", result: "flows json" }],
      last: {
        kind: LastKind.toolResult,
        tool: "mcp__codeweave__list_flows",
        text: "flows json",
      },
    });
  });
});

describe("responses and chat transcript adapters", () => {
  it("responses_uses_the_latest_user_message_after_earlier_outputs", () => {
    const body = responsesTranscript({
      tools: [{ name: "codeweave__decide" }],
      input: [
        { type: "function_call", call_id: "c1", name: "codeweave__decide" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: WAKE_UP_FINISHED }],
        },
      ],
    });

    expect(body.calls).toEqual([{ tool: "codeweave__decide", result: "ok" }]);
    expect(body.last).toEqual({
      kind: LastKind.userText,
      text: WAKE_UP_FINISHED,
    });
  });

  it("chat_pairs_tool_messages_with_assistant_tool_calls", () => {
    const body = chatTranscript({
      tools: [{ function: { name: "codeweave_list_flows" } }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "codeweave_list_flows" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "flows json" },
      ],
    });

    expect(body).toEqual({
      toolNames: ["codeweave_list_flows"],
      calls: [{ tool: "codeweave_list_flows", result: "flows json" }],
      last: {
        kind: LastKind.toolResult,
        tool: "codeweave_list_flows",
        text: "flows json",
      },
    });
  });
});
