import { expect, it } from "vitest";

import { toSessionView } from "../backend/sessionView";
import { API_PROVIDERS, ApiProviderId } from "../domain/apiProviders";
import type { FileDiff } from "../domain/events";
import { INITIAL_SESSION_STATE, reduceSession } from "../domain/sessionReducer";

import {
  AgentViewSchema,
  ApiAccountSchema,
  FileCompletionItemSchema,
  FlowRunViewSchema,
  FlowsListSchema,
  FlowViewSchema,
  PromptViewSchema,
  SessionViewSchema,
  SettingsViewSchema,
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

const API_BASE = {
  model: "some-model",
  baseUrl: null,
  rotation: true,
};
const CONSOLE_LOGIN_PROVIDERS = ["opencode-go", "opencode-zen"];

it("api_account_without_auth_defaults_to_api_key", () => {
  const parsed = ApiAccountSchema.parse({ ...API_BASE, provider: "groq" });

  expect(parsed.auth).toBe("api_key");
});

it.each(Object.values(ApiProviderId))(
  "api_account_console_login_is_accepted_only_where_the_provider_has_it_%s",
  (provider) => {
    const parsed = ApiAccountSchema.safeParse({
      ...API_BASE,
      provider,
      auth: "console_login",
    });

    expect(parsed.success).toBe(CONSOLE_LOGIN_PROVIDERS.includes(provider));
    expect(API_PROVIDERS[provider].consoleLogin).toBe(parsed.success);
  },
);

it("api_account_with_an_unknown_auth_is_rejected", () => {
  const parsed = ApiAccountSchema.safeParse({
    ...API_BASE,
    provider: "groq",
    auth: "oauth",
  });

  expect(parsed.success).toBe(false);
});

it("settings_view_schema_requires_the_recent_folders_list", () => {
  const withoutRecent = {
    permissionProfile: "ask",
    effectLevel: "auto",
    appearance: "system",
    claudeExecutable: null,
    codexExecutable: null,
    agyExecutable: null,
    opencodeExecutable: null,
    terminalShell: null,
    updateCheck: true,
    updateChannel: "stable",
    defaultTaskClass: "standard",
    definitionLibrary: null,
    defaultWorkspace: null,
    defaultWorkspaceResolved: "/home/user",
  };
  const view = { ...withoutRecent, recentFolders: ["/work/app"] };

  expect(SettingsViewSchema.safeParse(view).success).toBe(true);
  expect(SettingsViewSchema.safeParse(withoutRecent).success).toBe(false);
  expect(
    SettingsViewSchema.safeParse({ ...view, recentFolders: [1] }).success,
  ).toBe(false);
});

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
    createdAt: 0,
    cwd: "/work",
    explicitFolder: true,
    provider: "claude",
    accounts: [],
    profile: "ask",
    phase: { phase: "halted" },
    state: reduced,
    limits: [],
    turnInFlight: false,
    flowRef: null,
    orchestrate: false,
    hiddenRequestIds: new Set(),
  });

  const parsed = SessionViewSchema.parse(view);
  expect(parsed.toolCalls[0]?.diffs).toEqual([MODIFIED]);
});

it("session_view_requires_current_model_nullable", () => {
  const named = reduceSession(INITIAL_SESSION_STATE, {
    type: "model",
    model: "claude-opus-5-5",
  });
  const input = {
    id: "s1",
    createdAt: 0,
    cwd: "/work",
    explicitFolder: true,
    provider: "claude",
    accounts: [],
    profile: "ask",
    phase: { phase: "halted" },
    limits: [],
    turnInFlight: false,
    flowRef: null,
    orchestrate: false,
    hiddenRequestIds: new Set<string>(),
  } as const;
  const namedView = toSessionView({ ...input, state: named });
  const unnamedView = toSessionView({
    ...input,
    state: INITIAL_SESSION_STATE,
  });
  const withoutModel = Object.fromEntries(
    Object.entries(namedView).filter(([key]) => key !== "currentModel"),
  );

  expect(SessionViewSchema.parse(namedView).currentModel).toBe(
    "claude-opus-5-5",
  );
  expect(SessionViewSchema.parse(unnamedView).currentModel).toBeNull();
  expect(SessionViewSchema.safeParse(withoutModel).success).toBe(false);
  expect(
    SessionViewSchema.safeParse({ ...namedView, currentModel: 5 }).success,
  ).toBe(false);
  expect(
    SessionViewSchema.safeParse({ ...namedView, extra: true }).success,
  ).toBe(false);
});

const FLOW_VIEW = {
  id: "ship",
  file: "flows/ship.md",
  source: "project",
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
  const { source: omittedSource, ...withoutSource } = FLOW_VIEW;
  expect(omittedSource).toBe("project");
  expect(FlowViewSchema.safeParse(withoutSource).success).toBe(false);
});

it("agent_view_schema_requires_body", () => {
  const agent = {
    id: "coder",
    file: "agents/coder.md",
    source: "project",
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
    source: "project",
    revision: "abc",
    role: "Codes",
    provider: "claude",
    model: "opus",
    permissionProfile: "plan",
    taskClass: "standard",
    body: "Prose",
    usedBy: [{ file: "flows/ship.md", source: "project", title: "Ship" }],
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
      usedBy: [
        { file: "flows/ship.md", source: "project", title: "Ship", extra: 1 },
      ],
    }).success,
  ).toBe(false);
  expect(
    AgentViewSchema.safeParse({
      ...agent,
      usedBy: [{ file: "flows/ship.md", title: "Ship" }],
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
  nodes: [{ id: "a", status: "done", visits: 2, result: "ok", model: null }],
  decision: { reason: "rounds_exhausted", nodeId: "a" },
  decisions: [],
  failure: null,
  origin: "user",
  placement: "in_place",
  branch: null,
  ownerSessionId: null,
};

function runViewWithout(key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(FLOW_RUN_VIEW).filter(([name]) => name !== key),
  );
}

it("flow_run_node_requires_model_nullable", () => {
  const node = { id: "a", status: "done", visits: 1, result: null };
  const withModel = { ...FLOW_RUN_VIEW, nodes: [{ ...node, model: "gpt-6" }] };
  const withoutModel = { ...FLOW_RUN_VIEW, nodes: [node] };
  const numericModel = { ...FLOW_RUN_VIEW, nodes: [{ ...node, model: 6 }] };
  const extraKey = {
    ...FLOW_RUN_VIEW,
    nodes: [{ ...node, model: null, effort: "high" }],
  };

  expect(FlowRunViewSchema.safeParse(FLOW_RUN_VIEW).success).toBe(true);
  expect(FlowRunViewSchema.safeParse(withModel).success).toBe(true);
  expect(FlowRunViewSchema.safeParse(withoutModel).success).toBe(false);
  expect(FlowRunViewSchema.safeParse(numericModel).success).toBe(false);
  expect(FlowRunViewSchema.safeParse(extraKey).success).toBe(false);
});

it("flow_run_view_schema_requires_origin_placement_and_branch", () => {
  expect(FlowRunViewSchema.safeParse(runViewWithout("origin")).success).toBe(
    false,
  );
  expect(FlowRunViewSchema.safeParse(runViewWithout("placement")).success).toBe(
    false,
  );
  expect(FlowRunViewSchema.safeParse(runViewWithout("branch")).success).toBe(
    false,
  );
  expect(
    FlowRunViewSchema.safeParse({ ...FLOW_RUN_VIEW, origin: "robot" }).success,
  ).toBe(false);
  expect(
    FlowRunViewSchema.safeParse({
      ...FLOW_RUN_VIEW,
      origin: "orchestrator",
      placement: "worktree",
      branch: "feature/login",
    }).success,
  ).toBe(true);
});

it("flow_run_view_schema_requires_the_decision_log_and_the_owner", () => {
  const logged = {
    ...FLOW_RUN_VIEW,
    decisions: [
      {
        nodeId: "a",
        reason: "rounds_exhausted",
        decision: "another_round",
        note: "Tests fail",
      },
    ],
    ownerSessionId: "sess-1",
  };
  const unknownDecision = {
    ...FLOW_RUN_VIEW,
    decisions: [{ nodeId: "a", reason: "gate", decision: "shrug", note: null }],
  };

  expect(FlowRunViewSchema.safeParse(logged).success).toBe(true);
  expect(FlowRunViewSchema.safeParse(runViewWithout("decisions")).success).toBe(
    false,
  );
  expect(
    FlowRunViewSchema.safeParse(runViewWithout("ownerSessionId")).success,
  ).toBe(false);
  expect(FlowRunViewSchema.safeParse(unknownDecision).success).toBe(false);
});

it("flow_run_view_schema_accepts_a_paused_run_and_rejects_unknowns", () => {
  const unknownNodeStatus = {
    ...FLOW_RUN_VIEW,
    nodes: [
      { id: "a", status: "sleeping", visits: 1, result: null, model: null },
    ],
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

it("flows_list_schema_accepts_nullable_project_location", () => {
  const list = {
    flows: [],
    agents: [],
    errors: [],
    locations: { project: null, library: "/lib" },
  };
  expect(FlowsListSchema.safeParse(list).success).toBe(true);
  expect(
    FlowsListSchema.safeParse({
      ...list,
      locations: { project: "/proj", library: "/lib" },
    }).success,
  ).toBe(true);
});

it("session_view_schema_requires_explicit_folder", () => {
  const view = toSessionView({
    id: "s1",
    createdAt: 0,
    cwd: "/work",
    explicitFolder: false,
    provider: "claude",
    accounts: [],
    profile: "ask",
    phase: { phase: "halted" },
    state: INITIAL_SESSION_STATE,
    limits: [],
    turnInFlight: false,
    flowRef: null,
    orchestrate: false,
    hiddenRequestIds: new Set(),
  });
  const withoutExplicit = Object.fromEntries(
    Object.entries(view).filter(([key]) => key !== "explicitFolder"),
  );

  expect(SessionViewSchema.parse(view).explicitFolder).toBe(false);
  expect(SessionViewSchema.safeParse(withoutExplicit).success).toBe(false);
});

it("old_prompts_without_attachments_still_parse", () => {
  expect(PromptViewSchema.parse({ seq: 3, text: "old" })).toEqual({
    seq: 3,
    text: "old",
    attachments: [],
  });
});

it("file_completion_item_schema_accepts_files_and_dirs", () => {
  expect(
    FileCompletionItemSchema.safeParse({ path: "src/a.ts", kind: "file" })
      .success,
  ).toBe(true);
  expect(
    FileCompletionItemSchema.safeParse({ path: "src", kind: "dir" }).success,
  ).toBe(true);
  expect(
    FileCompletionItemSchema.safeParse({ path: "src", kind: "folder" }).success,
  ).toBe(false);
  expect(FileCompletionItemSchema.safeParse({ path: "src" }).success).toBe(
    false,
  );
});
