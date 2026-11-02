import { expect, it } from "vitest";

import { toSessionView } from "../backend/sessionView";
import type { FileDiff } from "../domain/events";
import { INITIAL_SESSION_STATE, reduceSession } from "../domain/sessionReducer";

import { SessionViewSchema, ToolCallViewSchema } from "./views";

const BASE_TOOL = {
  toolCallId: "t1",
  title: "Edit",
  kind: "edit",
  status: "completed",
  seq: 0,
};

const MODIFIED: FileDiff = {
  path: "src/app.ts",
  change: "modified",
  patch: "@@ -1,1 +1,1 @@\n-a\n+b",
};
const OMITTED: FileDiff = {
  path: "logo.png",
  change: "created",
  omitted: "binary",
};

it("tool_call_view_schema_accepts_diffs", () => {
  const parsed = ToolCallViewSchema.safeParse({
    ...BASE_TOOL,
    diffs: [MODIFIED, OMITTED],
  });

  expect(parsed.success).toBe(true);
});

it("tool_call_view_schema_rejects_unknown_diff_fields", () => {
  const extraField = ToolCallViewSchema.safeParse({
    ...BASE_TOOL,
    diffs: [{ ...MODIFIED, extra: 1 }],
  });
  const badChange = ToolCallViewSchema.safeParse({
    ...BASE_TOOL,
    diffs: [{ ...MODIFIED, change: "renamed" }],
  });
  const bothShapes = ToolCallViewSchema.safeParse({
    ...BASE_TOOL,
    diffs: [{ ...MODIFIED, omitted: "binary" }],
  });

  expect(extraField.success).toBe(false);
  expect(badChange.success).toBe(false);
  expect(bothShapes.success).toBe(false);
});

it("session_view_with_diffs_passes_session_view_schema", () => {
  const state = [
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
    },
    { type: "tool_call_update", toolCallId: "t1", diffs: [MODIFIED] },
  ] as const;
  const reduced = state.reduce(reduceSession, INITIAL_SESSION_STATE);

  const view = toSessionView({
    id: "s1",
    cwd: "/work",
    provider: "claude",
    accounts: [],
    profile: "ask",
    phase: { phase: "halted" },
    state: reduced,
    limits: [],
    turnInFlight: false,
    flowRef: null,
    hiddenRequestIds: new Set(),
  });

  const parsed = SessionViewSchema.parse(view);
  expect(parsed.toolCalls[0]?.diffs).toEqual([MODIFIED]);
});
