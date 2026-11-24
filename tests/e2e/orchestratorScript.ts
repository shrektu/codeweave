import { FlowToolName } from "../../src/backend/flowTools/tools";
import { ORCHESTRATOR_WAKEUP_PREFIX } from "../../src/domain/constants";
import { FlowDecision } from "../../src/domain/flowRun";
import { FlowPlacement } from "../../src/domain/types";
import type { MessagesBody } from "../fakes/anthropicMock";
import { TurnKind, type MockTurn, type ToolInput } from "../fakes/mockTurn";
import type { ChatRequestBody } from "../fakes/openaiChatMock";
import type { ResponsesRequestBody } from "../fakes/responsesMock";

import { FLOW_TASK } from "./flowRunFixture";

export const FINAL_ANSWER = "All done: the greeting helper was added.";
export const DECISION_NOTE = "Approved: the diff adds the greeting helper.";
export const WAITING_REPLY = "The flow is running; waiting for it.";
export const GREETING_FILE = "greeting.txt";
export const GREETING_CONTENT = "hello-from-the-flow";

export const DECISION_MARKER = "Decision needed";
const BASH_TOOL_NAME = "Bash";
const DISCOVER_DESCRIPTION = "locate the repository";
const RUN_ID_PATTERN = /runId\\?"\s*:\s*\\?"([^"\\]+)/;
const NAME_SEPARATOR = "_";
const NAMESPACE_SEPARATOR = "__";
const TOOL_TEXT_SEPARATOR = "\n";
const MISSING_TOOL = "";

export const LastKind = {
  toolResult: "tool_result",
  userText: "user_text",
} as const;

export type TranscriptLast =
  | {
      readonly kind: typeof LastKind.toolResult;
      readonly tool: string;
      readonly text: string;
    }
  | { readonly kind: typeof LastKind.userText; readonly text: string };

export interface TranscriptCall {
  readonly tool: string;
  readonly result: string;
}

export interface OrchestratorTranscript {
  readonly toolNames: readonly string[];
  readonly calls: readonly TranscriptCall[];
  readonly last: TranscriptLast;
}

export interface OrchestratorScriptOptions {
  readonly repository?: string;
  readonly placement?: FlowPlacement;
  readonly discoverCommand?: string;
}

export function toolIs(name: string, bare: string): boolean {
  return name === bare || name.endsWith(`${NAME_SEPARATOR}${bare}`);
}

export function isOrchestratorRequest(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => toolIs(name, FlowToolName.listFlows));
}

function unexpected(transcript: OrchestratorTranscript): Error {
  return new Error(
    `unexpected orchestrator transcript: ${JSON.stringify(transcript)}`,
  );
}

function fullName(
  transcript: OrchestratorTranscript,
  bare: FlowToolName,
): string {
  const name = transcript.toolNames.find((candidate) =>
    toolIs(candidate, bare),
  );
  if (name === undefined) {
    throw new Error(
      `tool ${bare} is not offered; offered: ${transcript.toolNames.join(", ")}`,
    );
  }
  return name;
}

function toolTurn(
  transcript: OrchestratorTranscript,
  bare: FlowToolName,
  input: ToolInput,
): MockTurn {
  return { kind: TurnKind.tool, name: fullName(transcript, bare), input };
}

function bashTurn(
  transcript: OrchestratorTranscript,
  command: string,
): MockTurn {
  const name = transcript.toolNames.find((candidate) =>
    toolIs(candidate, BASH_TOOL_NAME),
  );
  if (name === undefined) {
    throw unexpected(transcript);
  }
  return {
    kind: TurnKind.tool,
    name,
    input: { command, description: DISCOVER_DESCRIPTION },
  };
}

function listFlowsTurn(
  transcript: OrchestratorTranscript,
  { repository }: OrchestratorScriptOptions,
): MockTurn {
  return toolTurn(
    transcript,
    FlowToolName.listFlows,
    repository === undefined ? {} : { repository },
  );
}

function textTurn(text: string): MockTurn {
  return { kind: TurnKind.text, text };
}

function runIdOf(transcript: OrchestratorTranscript): string {
  const start = transcript.calls.find((call) =>
    toolIs(call.tool, FlowToolName.startFlow),
  );
  const runId =
    start === undefined ? undefined : RUN_ID_PATTERN.exec(start.result)?.[1];
  if (runId === undefined) {
    throw unexpected(transcript);
  }
  return runId;
}

function afterToolResult(
  transcript: OrchestratorTranscript,
  tool: string,
  options: OrchestratorScriptOptions,
): MockTurn {
  if (toolIs(tool, BASH_TOOL_NAME)) {
    return listFlowsTurn(transcript, options);
  }
  if (toolIs(tool, FlowToolName.listFlows)) {
    return toolTurn(transcript, FlowToolName.startFlow, {
      flowId: "two-node",
      task: FLOW_TASK,
      placement: options.placement ?? FlowPlacement.inPlace,
      ...(options.repository === undefined
        ? {}
        : { repository: options.repository }),
    });
  }
  if (
    toolIs(tool, FlowToolName.startFlow) ||
    toolIs(tool, FlowToolName.decide)
  ) {
    return textTurn(WAITING_REPLY);
  }
  if (toolIs(tool, FlowToolName.flowDiff)) {
    return textTurn(FINAL_ANSWER);
  }
  throw unexpected(transcript);
}

function afterUserText(
  transcript: OrchestratorTranscript,
  text: string,
): MockTurn {
  if (!text.trimStart().startsWith(ORCHESTRATOR_WAKEUP_PREFIX)) {
    throw unexpected(transcript);
  }
  const runId = runIdOf(transcript);
  return text.includes(DECISION_MARKER)
    ? toolTurn(transcript, FlowToolName.decide, {
        runId,
        decision: FlowDecision.approve,
        note: DECISION_NOTE,
      })
    : toolTurn(transcript, FlowToolName.flowDiff, { runId });
}

export function nextOrchestratorStep(
  transcript: OrchestratorTranscript,
  options: OrchestratorScriptOptions = {},
): MockTurn {
  if (transcript.calls.length === 0) {
    return options.discoverCommand === undefined
      ? listFlowsTurn(transcript, options)
      : bashTurn(transcript, options.discoverCommand);
  }
  const { last } = transcript;
  return last.kind === LastKind.toolResult
    ? afterToolResult(transcript, last.tool, options)
    : afterUserText(transcript, last.text);
}

interface TextPart {
  readonly text?: string | undefined;
}

function partsText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null
      ? ""
      : JSON.stringify(content);
  }
  return content
    .flatMap((part: TextPart) => (part.text === undefined ? [] : [part.text]))
    .join(TOOL_TEXT_SEPARATOR);
}

const EventKind = {
  use: "use",
  result: "result",
  user: "user",
} as const;

type TranscriptEvent =
  | {
      readonly kind: typeof EventKind.use;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly kind: typeof EventKind.result;
      readonly id: string;
      readonly text: string;
    }
  | { readonly kind: typeof EventKind.user; readonly text: string };

function transcriptFrom(
  toolNames: readonly string[],
  events: readonly TranscriptEvent[],
): OrchestratorTranscript {
  const names = new Map(
    events.flatMap((event) =>
      event.kind === EventKind.use ? [[event.id, event.name] as const] : [],
    ),
  );
  const toolOf = (id: string): string => names.get(id) ?? MISSING_TOOL;
  const calls = events.flatMap((event) =>
    event.kind === EventKind.result
      ? [{ tool: toolOf(event.id), result: event.text }]
      : [],
  );
  const lastEvent = events.findLast((event) => event.kind !== EventKind.use);
  if (lastEvent === undefined) {
    throw new Error("the request has no user message or tool result");
  }
  const last: TranscriptLast =
    lastEvent.kind === EventKind.result
      ? {
          kind: LastKind.toolResult,
          tool: toolOf(lastEvent.id),
          text: lastEvent.text,
        }
      : { kind: LastKind.userText, text: lastEvent.text };
  return { toolNames, calls, last };
}

function userEvent(text: string): TranscriptEvent[] {
  return text === "" ? [] : [{ kind: EventKind.user, text }];
}

function anthropicEvents(
  message: MessagesBody["messages"][number],
): TranscriptEvent[] {
  if (message.role !== "user" && message.role !== "assistant") {
    return [];
  }
  if (typeof message.content === "string") {
    return message.role === "user" ? userEvent(message.content) : [];
  }
  const uses = message.content.flatMap((block): TranscriptEvent[] =>
    block.type === "tool_use"
      ? [
          {
            kind: EventKind.use,
            id: block.id ?? "",
            name: block.name ?? MISSING_TOOL,
          },
        ]
      : [],
  );
  const results = message.content.flatMap((block): TranscriptEvent[] =>
    block.type === "tool_result"
      ? [
          {
            kind: EventKind.result,
            id: block.tool_use_id ?? "",
            text: partsText(block.content),
          },
        ]
      : [],
  );
  const texts =
    message.role === "user"
      ? userEvent(
          partsText(message.content.filter((block) => block.type === "text")),
        )
      : [];
  return [...uses, ...texts, ...results];
}

export function anthropicTranscript(
  body: MessagesBody,
): OrchestratorTranscript {
  return transcriptFrom(
    (body.tools ?? []).map((tool) => tool.name),
    body.messages.flatMap(anthropicEvents),
  );
}

function namespaced(namespace: string | undefined, name: string): string {
  return namespace === undefined
    ? name
    : `${namespace}${NAMESPACE_SEPARATOR}${name}`;
}

function offeredResponsesTools(
  tool: ResponsesRequestBody["tools"][number],
): string[] {
  if (tool.tools === undefined) {
    return tool.name === undefined ? [] : [tool.name];
  }
  return tool.tools.map((inner) => namespaced(tool.name, inner.name));
}

function responsesEvents(
  item: ResponsesRequestBody["input"][number],
): TranscriptEvent[] {
  if (item.type === "function_call") {
    return [
      {
        kind: EventKind.use,
        id: item.call_id ?? "",
        name:
          item.name === undefined
            ? MISSING_TOOL
            : namespaced(item.namespace, item.name),
      },
    ];
  }
  if (item.type === "function_call_output") {
    return [
      {
        kind: EventKind.result,
        id: item.call_id ?? "",
        text: partsText(item.output),
      },
    ];
  }
  return item.role === "user" ? userEvent(partsText(item.content)) : [];
}

export function responsesTranscript(
  body: ResponsesRequestBody,
): OrchestratorTranscript {
  return transcriptFrom(
    body.tools.flatMap(offeredResponsesTools),
    body.input.flatMap(responsesEvents),
  );
}

function chatEvents(
  message: ChatRequestBody["messages"][number],
): TranscriptEvent[] {
  if (message.role === "tool") {
    return [
      {
        kind: EventKind.result,
        id: message.tool_call_id ?? "",
        text: partsText(message.content),
      },
    ];
  }
  if (message.role === "user") {
    return userEvent(partsText(message.content));
  }
  return (message.tool_calls ?? []).map((call): TranscriptEvent => ({
    kind: EventKind.use,
    id: call.id ?? "",
    name: call.function?.name ?? MISSING_TOOL,
  }));
}

export function chatTranscript(body: ChatRequestBody): OrchestratorTranscript {
  return transcriptFrom(
    body.tools.flatMap((tool) =>
      tool.function?.name === undefined ? [] : [tool.function.name],
    ),
    body.messages.flatMap(chatEvents),
  );
}

export function responsesWireTurn(
  body: ResponsesRequestBody,
  turn: MockTurn,
): MockTurn {
  if (turn.kind !== TurnKind.tool) {
    return turn;
  }
  for (const tool of body.tools) {
    const child = tool.tools?.find(
      (inner) => namespaced(tool.name, inner.name) === turn.name,
    );
    if (tool.name !== undefined && child !== undefined) {
      return { ...turn, namespace: tool.name, name: child.name };
    }
  }
  return turn;
}
