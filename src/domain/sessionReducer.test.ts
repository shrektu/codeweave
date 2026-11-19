import { describe, expect, it } from "vitest";

import type { AgentEvent, FileDiff } from "./events";
import {
  createPermissionRecord,
  type PermissionRecord,
} from "./permissionRecords";
import {
  INITIAL_SESSION_STATE,
  recordTurnRoute,
  reduceSession,
  reservePromptSeq,
  type SessionState,
  type TurnRouteEntry,
} from "./sessionReducer";

function reduceAll(events: readonly AgentEvent[]): SessionState {
  return events.reduce(reduceSession, INITIAL_SESSION_STATE);
}

const BASH_CALL: AgentEvent = {
  type: "tool_call",
  toolCallId: "t1",
  title: "Run tests",
  kind: "execute",
  status: "in_progress",
  rawInput: { command: "pnpm test" },
};

describe("session reducer: text", () => {
  it("concatenates chunks of one message in arrival order", () => {
    const state = reduceAll([
      { type: "text", messageId: "m1", text: "Hel" },
      { type: "text", messageId: "m1", text: "lo " },
      { type: "text", messageId: "m1", text: "world" },
    ]);

    expect(state.messages).toEqual([{ id: "m1", text: "Hello world", seq: 0 }]);
  });

  it("keeps separate messages apart and appends to the right one", () => {
    const state = reduceAll([
      { type: "text", messageId: "m1", text: "a" },
      { type: "text", messageId: "m2", text: "b" },
      { type: "text", messageId: "m1", text: "c" },
    ]);

    expect(state.messages).toEqual([
      { id: "m1", text: "ac", seq: 0 },
      { id: "m2", text: "b", seq: 1 },
    ]);
  });

  it("joins chunks without a message id into one message", () => {
    const state = reduceAll([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ]);

    expect(state.messages).toEqual([{ id: null, text: "xy", seq: 0 }]);
  });

  it("does not mutate the previous state", () => {
    const first = reduceAll([{ type: "text", messageId: "m1", text: "a" }]);
    reduceSession(first, { type: "text", messageId: "m1", text: "b" });

    expect(first.messages).toEqual([{ id: "m1", text: "a", seq: 0 }]);
  });
});

describe("session reducer: tool calls", () => {
  it("merges tool_call_update into the call by toolCallId", () => {
    const state = reduceAll([
      BASH_CALL,
      {
        type: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        output: "42 passed",
      },
    ]);

    expect(state.toolCalls).toEqual([
      {
        toolCallId: "t1",
        title: "Run tests",
        kind: "execute",
        command: "pnpm test",
        status: "completed",
        output: "42 passed",
        seq: 0,
      },
    ]);
  });

  it("reducer_assigns_increasing_seq", () => {
    const state = reduceAll([
      { type: "text", messageId: "m1", text: "a" },
      BASH_CALL,
      {
        type: "permission_request",
        requestId: "r1",
        toolCallId: "t1",
        title: "Run tests",
        kind: "execute",
        locations: [],
        options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
      },
      { type: "text", messageId: "m1", text: "b" },
      BASH_CALL,
      { type: "tool_call_update", toolCallId: "t1", status: "completed" },
      { type: "text", messageId: "m2", text: "c" },
    ]);

    expect(state.messages.map((message) => message.seq)).toEqual([0, 3]);
    expect(state.toolCalls.map((tool) => tool.seq)).toEqual([1]);
    expect(state.permissions.map((record) => record.seq)).toEqual([2]);
    expect(state.nextSeq).toBe(4);
  });

  it("keeps the previous output when an update has only a status", () => {
    const state = reduceAll([
      BASH_CALL,
      { type: "tool_call_update", toolCallId: "t1", output: "partial" },
      { type: "tool_call_update", toolCallId: "t1", status: "failed" },
    ]);

    expect(state.toolCalls[0]).toMatchObject({
      status: "failed",
      output: "partial",
    });
  });

  it("tool_call_update_sets_title_and_command", () => {
    const state = reduceAll([
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {},
      },
      {
        type: "tool_call_update",
        toolCallId: "t1",
        title: "ls -la",
        kind: "read",
        rawInput: { command: "ls -la", description: "List" },
      },
    ]);

    expect(state.toolCalls).toEqual([
      {
        toolCallId: "t1",
        title: "ls -la",
        kind: "read",
        command: "ls -la",
        status: "pending",
        seq: 0,
      },
    ]);
    expect(state.turnLog).toEqual([
      {
        toolCallId: "t1",
        title: "ls -la",
        command: "ls -la",
        status: "pending",
      },
    ]);
  });

  it("tool_call_update_without_fields_keeps_title_and_command", () => {
    const state = reduceAll([
      BASH_CALL,
      { type: "tool_call_update", toolCallId: "t1", status: "completed" },
      { type: "tool_call_update", toolCallId: "t1", rawInput: {} },
    ]);

    expect(state.toolCalls[0]).toMatchObject({
      title: "Run tests",
      kind: "execute",
      command: "pnpm test",
    });
    expect(state.turnLog[0]).toMatchObject({
      title: "Run tests",
      command: "pnpm test",
    });
  });

  it("ignores an update for an unknown tool call", () => {
    const state = reduceAll([
      { type: "tool_call_update", toolCallId: "ghost", status: "completed" },
    ]);

    expect(state.toolCalls).toEqual([]);
  });
});

describe("session reducer: turn log", () => {
  it("resets the turn log on turn_end and keeps it as previousTurnLog", () => {
    const state = reduceAll([
      BASH_CALL,
      { type: "turn_end", stopReason: "end_turn" },
    ]);

    expect(state.turnLog).toEqual([]);
    expect(state.previousTurnLog.map((entry) => entry.toolCallId)).toEqual([
      "t1",
    ]);
    expect(state.lastTurn).toEqual({ kind: "ended", stopReason: "end_turn" });
  });

  it("resets the turn log on turn_error", () => {
    const state = reduceAll([
      BASH_CALL,
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: "limit",
      },
    ]);

    expect(state.turnLog).toEqual([]);
    expect(state.previousTurnLog).toHaveLength(1);
    expect(state.lastTurn).toEqual({ kind: "failed", message: "limit" });
  });
});

describe("session reducer: permissions", () => {
  const request: AgentEvent = {
    type: "permission_request",
    requestId: "r1",
    toolCallId: "t1",
    title: "Run ls",
    kind: "execute",
    locations: [],
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };

  it("records a pending permission request once", () => {
    const state = reduceAll([request, request]);

    expect(state.permissions.map((p) => [p.requestId, p.state])).toEqual([
      ["r1", "pending"],
    ]);
  });

  it("session_marks_permissions_expired_on_exit", () => {
    const state = reduceAll([request, { type: "process_exit" }]);

    expect(state.permissions.map((p) => p.state)).toEqual(["expired"]);
  });

  const secondRequest: AgentEvent = { ...request, requestId: "r2" };

  it("permission_settled_resolves_pending_record", () => {
    const state = reduceAll([
      request,
      secondRequest,
      { type: "permission_settled", requestId: "r1", optionId: "allow" },
    ]);

    expect(state.permissions.map((p) => [p.requestId, p.state])).toEqual([
      ["r1", "resolved"],
      ["r2", "pending"],
    ]);
    expect(state.permissions[0]).toMatchObject({ optionId: "allow" });
  });

  it("permission_settled_for_unknown_request_changes_nothing", () => {
    const before = reduceAll([request]);

    const after = reduceSession(before, {
      type: "permission_settled",
      requestId: "ghost",
      optionId: "allow",
    });

    expect(after).toEqual(before);
  });

  it("turn_end_expires_pending_permissions", () => {
    const state = reduceAll([
      request,
      secondRequest,
      { type: "turn_end", stopReason: "cancelled" },
    ]);

    expect(state.permissions.map((p) => [p.requestId, p.state])).toEqual([
      ["r1", "expired"],
      ["r2", "expired"],
    ]);
  });

  it("turn_error_expires_pending_permissions", () => {
    const state = reduceAll([
      request,
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "boom",
      },
    ]);

    expect(state.permissions.map((p) => p.state)).toEqual(["expired"]);
  });

  it("turn_end_keeps_resolved_permissions", () => {
    const resolved: PermissionRecord = {
      ...createPermissionRecord({
        requestId: "r0",
        toolCallId: "t0",
        title: "Read file",
        seq: 0,
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      }),
      state: "resolved",
      optionId: "allow",
    };
    const state = reduceSession(
      {
        ...reduceAll([]),
        permissions: [resolved],
      },
      { type: "turn_end", stopReason: "end_turn" },
    );

    expect(state.permissions.map((p) => [p.requestId, p.state])).toEqual([
      ["r0", "resolved"],
    ]);
  });
});

const EDIT_DIFFS: readonly FileDiff[] = [
  { path: "src/app.ts", change: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
];

it("diffs_are_stored_on_tool_calls_only", () => {
  const state = reduceAll([
    BASH_CALL,
    { type: "tool_call_update", toolCallId: "t1", diffs: EDIT_DIFFS },
  ]);

  expect(state.toolCalls[0]?.diffs).toEqual(EDIT_DIFFS);
  expect(state.turnLog[0]).not.toHaveProperty("diffs");
});

it("update_without_diffs_keeps_diffs", () => {
  const state = reduceAll([
    BASH_CALL,
    { type: "tool_call_update", toolCallId: "t1", diffs: EDIT_DIFFS },
    { type: "tool_call_update", toolCallId: "t1", status: "completed" },
  ]);

  expect(state.toolCalls[0]).toMatchObject({
    status: "completed",
    diffs: EDIT_DIFFS,
  });
});

const GROQ_TURN: TurnRouteEntry = {
  promptSeq: 3,
  accountId: "acc-groq",
  model: "openai/gpt-oss-20b",
  effectiveModel: null,
  apiProvider: "groq",
  requestedClass: "light",
  servedClass: "light",
  source: "routed",
};
const CEREBRAS_TURN: TurnRouteEntry = {
  ...GROQ_TURN,
  accountId: "acc-cerebras",
  model: "qwen-3.8-27b",
  apiProvider: "cerebras",
  requestedClass: "heavy",
  servedClass: "heavy",
};

describe("session reducer: turn routes", () => {
  it("reserves the next seq for a prompt", () => {
    const first = reservePromptSeq(INITIAL_SESSION_STATE);
    const second = reservePromptSeq(first.state);

    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect(second.state.nextSeq).toBe(2);
  });

  it("records one entry per prompt", () => {
    const state = recordTurnRoute(INITIAL_SESSION_STATE, GROQ_TURN);

    expect(state.turns).toEqual([GROQ_TURN]);
  });

  it("a resend replaces the entry of the same prompt", () => {
    const first = recordTurnRoute(INITIAL_SESSION_STATE, GROQ_TURN);
    const next = recordTurnRoute(first, {
      ...CEREBRAS_TURN,
      promptSeq: GROQ_TURN.promptSeq,
    });

    expect(next.turns).toEqual([
      { ...CEREBRAS_TURN, promptSeq: GROQ_TURN.promptSeq },
    ]);
  });

  it("a later prompt appends after earlier entries", () => {
    const first = recordTurnRoute(INITIAL_SESSION_STATE, GROQ_TURN);
    const next = recordTurnRoute(first, { ...CEREBRAS_TURN, promptSeq: 4 });

    expect(next.turns.map((turn) => turn.promptSeq)).toEqual([3, 4]);
  });

  it("a model event fills the effective model of the latest turn", () => {
    const withTurns = recordTurnRoute(
      recordTurnRoute(INITIAL_SESSION_STATE, GROQ_TURN),
      { ...CEREBRAS_TURN, promptSeq: 4 },
    );

    const state = reduceSession(withTurns, {
      type: "model",
      model: "qwen-3.8-27b-0925",
    });

    expect(state.turns.map((turn) => turn.effectiveModel)).toEqual([
      null,
      "qwen-3.8-27b-0925",
    ]);
  });

  it("a model event without a turn changes nothing", () => {
    const state = reduceSession(INITIAL_SESSION_STATE, {
      type: "model",
      model: "any",
    });

    expect(state).toEqual(INITIAL_SESSION_STATE);
  });
});
