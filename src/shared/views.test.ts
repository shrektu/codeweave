import { expect, it } from "vitest";

import { toSessionView } from "../backend/sessionView";
import type { FileDiff } from "../domain/events";
import { INITIAL_SESSION_STATE, reduceSession } from "../domain/sessionReducer";

import {
  AgentViewSchema,
  FlowRunViewSchema,
  FlowViewSchema,
  SessionViewSchema,
  ToolCallViewSchema,
} from "./views";

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

const FLOW_VIEW = {
  id: "ship",
  file: "flows/ship.md",
  revision: "abc",
  title: "Ship",
  maxRounds: 2,
  nodes: [{ id: "a", agent: "coder", provider: null, taskClass: null }],
  edges: [{ from: "a", to: "a", kind: "reviews", gate: false }],
};

it("flow_view_schema_requires_resolved_defaults", () => {
  const { maxRounds: omitted, ...withoutRounds } = FLOW_VIEW;
  const withoutProvider = {
    ...FLOW_VIEW,
    nodes: [{ id: "a", agent: "coder", taskClass: null }],
  };
  const withoutTaskClass = {
    ...FLOW_VIEW,
    nodes: [{ id: "a", agent: "coder", provider: null }],
  };

  expect(omitted).toBe(2);
  expect(FlowViewSchema.safeParse(FLOW_VIEW).success).toBe(true);
  expect(FlowViewSchema.safeParse(withoutRounds).success).toBe(false);
  expect(FlowViewSchema.safeParse(withoutProvider).success).toBe(false);
  expect(FlowViewSchema.safeParse(withoutTaskClass).success).toBe(false);
});

it("agent_view_schema_requires_body", () => {
  const agent = {
    id: "coder",
    file: "agents/coder.md",
    revision: "abc",
    role: "Codes",
    provider: "claude",
    model: null,
    permissionProfile: "plan",
    taskClass: null,
    usedBy: [],
  };

  expect(AgentViewSchema.safeParse(agent).success).toBe(false);
  expect(AgentViewSchema.safeParse({ ...agent, body: "Prose" }).success).toBe(
    true,
  );
});

it("agent_view_schema_requires_file_revision_model_task_class_and_used_by", () => {
  const agent = {
    id: "coder",
    file: "agents/coder.md",
    revision: "abc",
    role: "Codes",
    provider: "claude",
    model: "opus",
    permissionProfile: "plan",
    taskClass: "standard",
    body: "Prose",
    usedBy: [{ file: "flows/ship.md", title: "Ship" }],
  };

  expect(AgentViewSchema.safeParse(agent).success).toBe(true);
  for (const key of Object.keys(agent)) {
    const rest = Object.fromEntries(
      Object.entries(agent).filter(([name]) => name !== key),
    );
    expect(AgentViewSchema.safeParse(rest).success).toBe(false);
  }
  expect(
    AgentViewSchema.safeParse({
      ...agent,
      usedBy: [{ file: "flows/ship.md", title: "Ship", extra: 1 }],
    }).success,
  ).toBe(false);
});

const FLOW_RUN_VIEW = {
  runId: "run-1",
  flowId: "ship",
  flowTitle: "Ship",
  cwd: "/work",
  task: "Go",
  status: "awaiting_decision",
  round: 2,
  maxRounds: 2,
  currentNodeId: null,
  nodes: [{ id: "a", status: "done", visits: 2, result: "ok" }],
  decision: { reason: "rounds_exhausted", nodeId: "a" },
  failure: null,
};

it("flow_run_view_schema_accepts_a_paused_run_and_rejects_unknowns", () => {
  const unknownNodeStatus = {
    ...FLOW_RUN_VIEW,
    nodes: [{ id: "a", status: "sleeping", visits: 1, result: null }],
  };
  const extraDecisionField = {
    ...FLOW_RUN_VIEW,
    decision: { reason: "gate", nodeId: "a", reviewerId: "b" },
  };

  expect(FlowRunViewSchema.safeParse(FLOW_RUN_VIEW).success).toBe(true);
  expect(
    FlowRunViewSchema.safeParse({ ...FLOW_RUN_VIEW, decision: null }).success,
  ).toBe(true);
  expect(FlowRunViewSchema.safeParse(unknownNodeStatus).success).toBe(false);
  expect(FlowRunViewSchema.safeParse(extraDecisionField).success).toBe(false);
  expect(
    FlowRunViewSchema.safeParse({ ...FLOW_RUN_VIEW, round: 1.5 }).success,
  ).toBe(false);
});
