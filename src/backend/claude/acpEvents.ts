import type {
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

import {
  ERROR_KIND_AUTH_REQUIRED,
  RPC_CODE_AUTH_REJECTED,
  UNKNOWN_ERROR,
} from "../../domain/constants";
import type { AgentEvent, ToolCallStatus } from "../../domain/events";
import {
  CLAUDE_MODEL_META_KEY,
  CLAUDE_RATE_LIMIT_META_KEY,
  DEFAULT_MODEL_ALIAS,
  DEFAULT_TOOL_KIND,
  DEFAULT_TOOL_STATUS,
  MODEL_CONFIG_ID,
  TOOL_OUTPUT_SEPARATOR,
  UNKNOWN_RATE_LIMIT_STATUS,
} from "../constants";

type SessionUpdate = SessionNotification["update"];
type SessionConfigSelect = Extract<SessionConfigOption, { type: "select" }>;
type TurnError = Extract<AgentEvent, { type: "turn_error" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fieldOf(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function mapMessageChunk(
  update: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>,
): AgentEvent[] {
  if (update.content.type !== "text") {
    return [];
  }
  const messageId = update.messageId;
  return [
    {
      type: "text",
      text: update.content.text,
      ...(typeof messageId === "string" ? { messageId } : {}),
    },
  ];
}

function mapToolCall(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>,
): AgentEvent[] {
  return [
    {
      type: "tool_call",
      toolCallId: update.toolCallId,
      title: update.title,
      kind: update.kind ?? DEFAULT_TOOL_KIND,
      status: update.status ?? DEFAULT_TOOL_STATUS,
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
    },
  ];
}

const FENCED_BLOCK = /^(`{3,})[^\n`]*\r?\n(?:([\s\S]*?)\r?\n)?\1[ \t]*$/;
const LINE_BREAK = /\r?\n/;

function unfence(text: string): string {
  const match = FENCED_BLOCK.exec(text.trim());
  const fence = match?.[1];
  if (fence === undefined) {
    return text;
  }
  const inner = match?.[2] ?? "";
  const closing = new RegExp(`^ {0,3}\`{${fence.length.toString()},}[ \\t]*$`);
  return inner.split(LINE_BREAK).some((line) => closing.test(line))
    ? text
    : inner;
}

function textOf(content: ToolCallContent): string[] {
  return content.type === "content" && content.content.type === "text"
    ? [unfence(content.content.text)]
    : [];
}

function outputOf(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): string | undefined {
  const texts = (update.content ?? []).flatMap(textOf);
  if (texts.length > 0) {
    return texts.join(TOOL_OUTPUT_SEPARATOR);
  }
  return typeof update.rawOutput === "string" ? update.rawOutput : undefined;
}

function mapToolCallUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): AgentEvent[] {
  const status: ToolCallStatus | null | undefined = update.status;
  const output = outputOf(update);
  return [
    {
      type: "tool_call_update",
      toolCallId: update.toolCallId,
      ...(update.title == null ? {} : { title: update.title }),
      ...(update.kind == null ? {} : { kind: update.kind }),
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      ...(status == null ? {} : { status }),
      ...(output === undefined ? {} : { output }),
    },
  ];
}

function selectOf(
  options: readonly SessionConfigOption[] | null | undefined,
): SessionConfigSelect | null {
  const option = options?.find((item) => item.id === MODEL_CONFIG_ID);
  return option?.type === "select" ? option : null;
}

export function modelValueOf(
  options: readonly SessionConfigOption[] | null | undefined,
): string | null {
  return selectOf(options)?.currentValue ?? null;
}

export function modelOf(
  options: readonly SessionConfigOption[] | null | undefined,
): string | null {
  const select = selectOf(options);
  if (select === null) {
    return null;
  }
  if (select.currentValue !== DEFAULT_MODEL_ALIAS) {
    return select.currentValue;
  }
  const alias = select.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .find((entry) => entry.value === DEFAULT_MODEL_ALIAS);
  const resolved = alias?.description ?? "";
  return resolved === "" ? null : resolved;
}

function mapModel(model: unknown): AgentEvent[] {
  return typeof model === "string" && model !== ""
    ? [{ type: "model", model }]
    : [];
}

function mapRateLimit(limit: unknown): AgentEvent[] {
  if (!isRecord(limit)) {
    return [];
  }
  return [
    {
      type: "rate_limit",
      status:
        typeof limit.status === "string"
          ? limit.status
          : UNKNOWN_RATE_LIMIT_STATUS,
      resetsAt: limit.resetsAt,
      rateLimitType: limit.rateLimitType,
      utilization: limit.utilization,
    },
  ];
}

function mapUsageUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>,
): AgentEvent[] {
  return [
    ...mapRateLimit(update._meta?.[CLAUDE_RATE_LIMIT_META_KEY]),
    ...mapModel(update._meta?.[CLAUDE_MODEL_META_KEY]),
  ];
}

export function mapSessionUpdate(update: SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return mapMessageChunk(update);
    case "tool_call":
      return mapToolCall(update);
    case "tool_call_update":
      return mapToolCallUpdate(update);
    case "usage_update":
      return mapUsageUpdate(update);
    case "config_option_update":
      return mapModel(modelOf(update.configOptions));
    default:
      return [];
  }
}

export function mapPromptError(error: unknown): TurnError {
  const code = fieldOf(error, "code");
  const errorKind = fieldOf(fieldOf(error, "data"), "errorKind");
  const message = fieldOf(error, "message");
  return {
    type: "turn_error",
    errorKind: typeof errorKind === "string" ? errorKind : null,
    rpcCode: typeof code === "number" ? code : null,
    message: typeof message === "string" ? message : UNKNOWN_ERROR,
  };
}

export function isAuthError(error: unknown): boolean {
  return (
    fieldOf(error, "code") === RPC_CODE_AUTH_REJECTED ||
    fieldOf(fieldOf(error, "data"), "errorKind") === ERROR_KIND_AUTH_REQUIRED
  );
}
