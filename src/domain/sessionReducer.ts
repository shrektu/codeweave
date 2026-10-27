import type { AgentEvent, ToolCallStatus } from "./events";
import {
  createPermissionRecord,
  expireAll,
  type PermissionRecord,
} from "./permissionRecords";

export interface TurnLogEntry {
  readonly toolCallId: string;
  readonly title: string;
  readonly command?: string;
  readonly status: ToolCallStatus;
  readonly output?: string;
}

export interface AssistantMessage {
  readonly id: string | null;
  readonly text: string;
}

export type LastTurn =
  | { readonly kind: "ended"; readonly stopReason: string }
  | { readonly kind: "failed"; readonly message: string };

export interface SessionState {
  readonly messages: readonly AssistantMessage[];
  readonly toolCalls: readonly TurnLogEntry[];
  readonly turnLog: readonly TurnLogEntry[];
  readonly previousTurnLog: readonly TurnLogEntry[];
  readonly permissions: readonly PermissionRecord[];
  readonly lastTurn: LastTurn | null;
}

export const INITIAL_SESSION_STATE: SessionState = {
  messages: [],
  toolCalls: [],
  turnLog: [],
  previousTurnLog: [],
  permissions: [],
  lastTurn: null,
};

function extractCommand(rawInput: unknown): string | undefined {
  if (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "command" in rawInput &&
    typeof rawInput.command === "string"
  ) {
    return rawInput.command;
  }
  return undefined;
}

function appendText(
  messages: readonly AssistantMessage[],
  messageId: string | undefined,
  text: string,
): readonly AssistantMessage[] {
  const id = messageId ?? null;
  const index =
    id === null
      ? messages.length - 1
      : messages.findIndex((message) => message.id === id);
  const target = messages[index];
  if (target?.id === id) {
    return messages.with(index, { id, text: target.text + text });
  }
  return [...messages, { id, text }];
}

function upsert(
  entries: readonly TurnLogEntry[],
  entry: TurnLogEntry,
): readonly TurnLogEntry[] {
  const index = entries.findIndex(
    (item) => item.toolCallId === entry.toolCallId,
  );
  return index === -1
    ? [...entries, entry]
    : entries.with(index, { ...entries[index], ...entry });
}

function toEntry(
  event: Extract<AgentEvent, { type: "tool_call" }>,
): TurnLogEntry {
  const command = extractCommand(event.rawInput);
  return {
    toolCallId: event.toolCallId,
    title: event.title,
    status: event.status,
    ...(command === undefined ? {} : { command }),
  };
}

function applyUpdate(
  entries: readonly TurnLogEntry[],
  event: Extract<AgentEvent, { type: "tool_call_update" }>,
): readonly TurnLogEntry[] {
  const index = entries.findIndex(
    (item) => item.toolCallId === event.toolCallId,
  );
  const existing = entries[index];
  if (existing === undefined) {
    return entries;
  }
  return entries.with(index, {
    ...existing,
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.output === undefined ? {} : { output: event.output }),
  });
}

function addPermission(
  state: SessionState,
  event: Extract<AgentEvent, { type: "permission_request" }>,
): SessionState {
  if (
    state.permissions.some((record) => record.requestId === event.requestId)
  ) {
    return state;
  }
  const record = createPermissionRecord({
    requestId: event.requestId,
    toolCallId: event.toolCallId,
    options: event.options,
  });
  return { ...state, permissions: [...state.permissions, record] };
}

function finishTurn(state: SessionState, lastTurn: LastTurn): SessionState {
  return {
    ...state,
    turnLog: [],
    previousTurnLog: state.turnLog,
    lastTurn,
  };
}

export function reduceSession(
  state: SessionState,
  event: AgentEvent,
): SessionState {
  switch (event.type) {
    case "text":
      return {
        ...state,
        messages: appendText(state.messages, event.messageId, event.text),
      };
    case "tool_call": {
      const entry = toEntry(event);
      return {
        ...state,
        toolCalls: upsert(state.toolCalls, entry),
        turnLog: upsert(state.turnLog, entry),
      };
    }
    case "tool_call_update":
      return {
        ...state,
        toolCalls: applyUpdate(state.toolCalls, event),
        turnLog: applyUpdate(state.turnLog, event),
      };
    case "permission_request":
      return addPermission(state, event);
    case "turn_end":
      return finishTurn(state, { kind: "ended", stopReason: event.stopReason });
    case "turn_error":
      return finishTurn(state, { kind: "failed", message: event.message });
    case "process_exit":
      return { ...state, permissions: expireAll(state.permissions) };
    case "rate_limit":
    case "api_retry":
      return state;
  }
}
