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

export interface ToolCallEntry extends TurnLogEntry {
  readonly kind: string;
  readonly seq: number;
}

export interface AssistantMessage {
  readonly id: string | null;
  readonly text: string;
  readonly seq: number;
}

export type LastTurn =
  | { readonly kind: "ended"; readonly stopReason: string }
  | { readonly kind: "failed"; readonly message: string };

export interface SessionState {
  readonly messages: readonly AssistantMessage[];
  readonly toolCalls: readonly ToolCallEntry[];
  readonly turnLog: readonly TurnLogEntry[];
  readonly previousTurnLog: readonly TurnLogEntry[];
  readonly permissions: readonly PermissionRecord[];
  readonly lastTurn: LastTurn | null;
  readonly nextSeq: number;
}

export const INITIAL_SESSION_STATE: SessionState = {
  messages: [],
  toolCalls: [],
  turnLog: [],
  previousTurnLog: [],
  permissions: [],
  lastTurn: null,
  nextSeq: 0,
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
  state: SessionState,
  messageId: string | undefined,
  text: string,
): SessionState {
  const { messages } = state;
  const id = messageId ?? null;
  const index =
    id === null
      ? messages.length - 1
      : messages.findIndex((message) => message.id === id);
  const target = messages[index];
  if (target?.id === id) {
    return {
      ...state,
      messages: messages.with(index, { ...target, text: target.text + text }),
    };
  }
  return {
    ...state,
    messages: [...messages, { id, text, seq: state.nextSeq }],
    nextSeq: state.nextSeq + 1,
  };
}

function upsert<T extends TurnLogEntry>(
  entries: readonly T[],
  entry: T,
): readonly T[] {
  const index = entries.findIndex(
    (item) => item.toolCallId === entry.toolCallId,
  );
  return index === -1
    ? [...entries, entry]
    : entries.with(index, { ...entries[index], ...entry });
}

function addToolCall(
  state: SessionState,
  event: Extract<AgentEvent, { type: "tool_call" }>,
): SessionState {
  const known = state.toolCalls.find(
    (item) => item.toolCallId === event.toolCallId,
  );
  const seq = known?.seq ?? state.nextSeq;
  const entry = toEntry(event);
  return {
    ...state,
    toolCalls: upsert(state.toolCalls, { ...entry, kind: event.kind, seq }),
    turnLog: upsert(state.turnLog, entry),
    nextSeq: known === undefined ? state.nextSeq + 1 : state.nextSeq,
  };
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

function applyUpdate<T extends TurnLogEntry>(
  entries: readonly T[],
  event: Extract<AgentEvent, { type: "tool_call_update" }>,
): readonly T[] {
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
  const command = extractCommand(event.rawInput);
  const record = createPermissionRecord({
    requestId: event.requestId,
    toolCallId: event.toolCallId,
    title: event.title,
    ...(command === undefined ? {} : { command }),
    seq: state.nextSeq,
    options: event.options,
  });
  return {
    ...state,
    permissions: [...state.permissions, record],
    nextSeq: state.nextSeq + 1,
  };
}

function finishTurn(state: SessionState, lastTurn: LastTurn): SessionState {
  return {
    ...state,
    turnLog: [],
    previousTurnLog: state.turnLog,
    lastTurn,
    permissions: expireAll(state.permissions),
  };
}

export function reduceSession(
  state: SessionState,
  event: AgentEvent,
): SessionState {
  switch (event.type) {
    case "text":
      return appendText(state, event.messageId, event.text);
    case "tool_call":
      return addToolCall(state, event);
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
