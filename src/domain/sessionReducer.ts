import type { ApiProviderId } from "./apiProviders";
import { SYNTHETIC_MODEL_NAME } from "./constants";
import type { AgentEvent, FileDiff, ToolCallStatus } from "./events";
import {
  createPermissionRecord,
  expireAll,
  settle,
  type PermissionRecord,
} from "./permissionRecords";
import type { RouteSource } from "./routing";
import type { TaskClass } from "./taskClass";

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
  readonly diffs?: readonly FileDiff[];
}

export interface AssistantMessage {
  readonly id: string | null;
  readonly text: string;
  readonly seq: number;
}

export type LastTurn =
  | { readonly kind: "ended"; readonly stopReason: string }
  | { readonly kind: "failed"; readonly message: string };

export interface TurnRouteEntry {
  readonly promptSeq: number;
  readonly accountId: string;
  readonly model: string | null;
  readonly effectiveModel: string | null;
  readonly apiProvider: ApiProviderId | null;
  readonly requestedClass: TaskClass;
  readonly servedClass: TaskClass | null;
  readonly source: RouteSource;
}

export interface SessionState {
  readonly messages: readonly AssistantMessage[];
  readonly turns: readonly TurnRouteEntry[];
  readonly toolCalls: readonly ToolCallEntry[];
  readonly turnLog: readonly TurnLogEntry[];
  readonly previousTurnLog: readonly TurnLogEntry[];
  readonly permissions: readonly PermissionRecord[];
  readonly lastTurn: LastTurn | null;
  readonly currentModel: string | null;
  readonly nextSeq: number;
}

export const INITIAL_SESSION_STATE: SessionState = {
  messages: [],
  turns: [],
  toolCalls: [],
  turnLog: [],
  previousTurnLog: [],
  permissions: [],
  lastTurn: null,
  currentModel: null,
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

function entryPatch(
  event: Extract<AgentEvent, { type: "tool_call_update" }>,
): Partial<TurnLogEntry> {
  const command = extractCommand(event.rawInput);
  return {
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(command === undefined ? {} : { command }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.output === undefined ? {} : { output: event.output }),
  };
}

function applyUpdate<T extends TurnLogEntry>(
  entries: readonly T[],
  toolCallId: string,
  patch: Partial<T>,
): readonly T[] {
  const index = entries.findIndex((item) => item.toolCallId === toolCallId);
  const existing = entries[index];
  if (existing === undefined) {
    return entries;
  }
  return entries.with(index, { ...existing, ...patch });
}

function settlePermission(
  state: SessionState,
  event: Extract<AgentEvent, { type: "permission_settled" }>,
): SessionState {
  if (!state.permissions.some((item) => item.requestId === event.requestId)) {
    return state;
  }
  return {
    ...state,
    permissions: state.permissions.map((record) =>
      record.requestId === event.requestId
        ? settle(record, event.optionId)
        : record,
    ),
  };
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

export function reservePromptSeq(state: SessionState): {
  readonly state: SessionState;
  readonly seq: number;
} {
  return {
    state: { ...state, nextSeq: state.nextSeq + 1 },
    seq: state.nextSeq,
  };
}

export function recordTurnRoute(
  state: SessionState,
  entry: TurnRouteEntry,
): SessionState {
  const index = state.turns.findIndex(
    (turn) => turn.promptSeq === entry.promptSeq,
  );
  return {
    ...state,
    turns:
      index === -1 ? [...state.turns, entry] : state.turns.with(index, entry),
  };
}

function withCurrentModel(state: SessionState, model: string): SessionState {
  return model === "" || model === SYNTHETIC_MODEL_NAME
    ? state
    : { ...state, currentModel: model };
}

export function applyServedModel(
  state: SessionState,
  model: string,
  accountId: string,
): SessionState {
  const named = withCurrentModel(state, model);
  const last = named.turns.at(-1);
  return named === state || last?.accountId !== accountId
    ? named
    : {
        ...named,
        turns: named.turns.with(-1, { ...last, effectiveModel: model }),
      };
}

export function resetCurrentModel(state: SessionState): SessionState {
  return { ...state, currentModel: null };
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
    case "tool_call_update": {
      const patch = entryPatch(event);
      return {
        ...state,
        toolCalls: applyUpdate(state.toolCalls, event.toolCallId, {
          ...patch,
          ...(event.kind === undefined ? {} : { kind: event.kind }),
          ...(event.diffs === undefined ? {} : { diffs: event.diffs }),
        }),
        turnLog: applyUpdate(state.turnLog, event.toolCallId, patch),
      };
    }
    case "permission_request":
      return addPermission(state, event);
    case "turn_end":
      return finishTurn(state, { kind: "ended", stopReason: event.stopReason });
    case "turn_error":
      return finishTurn(state, { kind: "failed", message: event.message });
    case "process_exit":
      return { ...state, permissions: expireAll(state.permissions) };
    case "model":
      return withCurrentModel(state, event.model);
    case "permission_settled":
      return settlePermission(state, event);
    case "rate_limit":
    case "api_retry":
      return state;
  }
}
