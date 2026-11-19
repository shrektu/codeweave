import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createV2EventMapper } from "./events";
import { parseOpencodeV2Event, type OpencodeV2Event } from "./protocol";

const OWN = "ses_own";
const CHILD = "ses_child";
const GRANDCHILD = "ses_grandchild";
const STRANGER = "ses_other";
const CWD = "/work/project";

const PERMISSION_OPTIONS = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

function event(type: string, data: object): OpencodeV2Event {
  const parsed = parseOpencodeV2Event({ type, data });
  if (parsed === null) {
    throw new Error(`fixture does not parse: ${type}`);
  }
  return parsed;
}

function delta(sessionID: string, text: string, ordinal = 0): OpencodeV2Event {
  return event("session.text.delta", {
    sessionID,
    assistantMessageID: "msg_1",
    ordinal,
    delta: text,
  });
}

function ended(sessionID: string, text: string): OpencodeV2Event {
  return event("session.text.ended", {
    sessionID,
    assistantMessageID: "msg_1",
    ordinal: 0,
    text,
  });
}

function asked(sessionID: string, data: object): OpencodeV2Event {
  return event("permission.asked", { id: "per_1", sessionID, ...data });
}

function stepStarted(modelId: string): OpencodeV2Event {
  return event("session.step.started", {
    sessionID: OWN,
    model: { id: modelId },
  });
}

function child(sessionID: string, parentID: string): OpencodeV2Event {
  return event("session.created", { sessionID, parentID });
}

describe("v2 text events", () => {
  it("text_deltas_become_text_events_and_ended_adds_only_the_remainder", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(mapper.map(delta(OWN, "Hel"))).toEqual([
      { type: "text", messageId: "msg_1:0", text: "Hel" },
    ]);
    expect(mapper.map(delta(OWN, "lo"))).toEqual([
      { type: "text", messageId: "msg_1:0", text: "lo" },
    ]);
    expect(mapper.map(ended(OWN, "Hello world"))).toEqual([
      { type: "text", messageId: "msg_1:0", text: " world" },
    ]);
  });

  it("text_ended_equal_to_the_deltas_emits_nothing", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(delta(OWN, "Hello"));

    expect(mapper.map(ended(OWN, "Hello"))).toEqual([]);
  });

  it("text_ended_without_deltas_emits_the_whole_text", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(mapper.map(ended(OWN, "Whole answer"))).toEqual([
      { type: "text", messageId: "msg_1:0", text: "Whole answer" },
    ]);
  });

  it("empty_deltas_and_empty_ended_text_are_skipped", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(mapper.map(delta(OWN, ""))).toEqual([]);
    expect(mapper.map(ended(OWN, ""))).toEqual([]);
  });

  it("ordinals_keep_separate_message_ids", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(delta(OWN, "first", 0));

    expect(mapper.map(delta(OWN, "second", 1))).toEqual([
      { type: "text", messageId: "msg_1:1", text: "second" },
    ]);
  });
});

describe("v2 tool events", () => {
  it("tool_call_lifecycle_maps_to_call_and_updates", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    const ids = { sessionID: OWN, id: "call_1" };

    expect(
      mapper.map(
        event("session.tool.input.started", { ...ids, name: "shell" }),
      ),
    ).toEqual([]);
    expect(
      mapper.map(
        event("session.tool.called", { ...ids, input: { command: "ls" } }),
      ),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "call_1",
        title: "shell",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      },
    ]);
    expect(mapper.map(event("session.tool.progress", ids))).toEqual([
      { type: "tool_call_update", toolCallId: "call_1", status: "in_progress" },
    ]);
    expect(
      mapper.map(
        event("session.tool.success", {
          ...ids,
          content: [
            { type: "text", text: "a.txt\n" },
            { type: "image" },
            { type: "text", text: "b.txt" },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        output: "a.txt\nb.txt",
      },
    ]);
  });
});

describe("v2 tool event edge cases", () => {
  it("success_without_text_content_omits_the_output", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(event("session.tool.success", { sessionID: OWN, id: "c" })),
    ).toEqual([
      { type: "tool_call_update", toolCallId: "c", status: "completed" },
    ]);
  });

  it("failed_tool_reports_the_error_message", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(
        event("session.tool.failed", {
          sessionID: OWN,
          id: "c",
          error: { type: "aborted", message: "The user declined" },
        }),
      ),
    ).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "c",
        status: "failed",
        output: "The user declined",
      },
    ]);
  });
});

describe("v2 tool names", () => {
  it("tool_called_without_a_known_name_still_maps", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(
        event("session.tool.called", { sessionID: OWN, id: "c", input: 1 }),
      ),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "c",
        title: "tool",
        kind: "other",
        status: "pending",
        rawInput: 1,
      },
    ]);
  });

  it.each([
    ["edit", "edit"],
    ["write", "edit"],
    ["patch", "edit"],
    ["read", "read"],
    ["glob", "search"],
    ["grep", "search"],
    ["webfetch", "fetch"],
    ["websearch", "fetch"],
    ["subagent", "other"],
  ])("tool_%s_has_kind_%s", (name, kind) => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(
      event("session.tool.input.started", { sessionID: OWN, id: "c", name }),
    );

    expect(
      mapper.map(
        event("session.tool.called", { sessionID: OWN, id: "c", input: {} }),
      ),
    ).toMatchObject([{ title: name, kind }]);
  });
});

describe("v2 permission events", () => {
  it("shell_permission_carries_the_command", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(
        asked(OWN, {
          action: "shell",
          resources: ["echo hi"],
          source: { id: "call_1" },
        }),
      ),
    ).toEqual([
      {
        type: "permission_request",
        requestId: "per_1",
        toolCallId: "call_1",
        title: "Run command",
        kind: "execute",
        rawInput: { command: "echo hi" },
        locations: [],
        options: PERMISSION_OPTIONS,
      },
    ]);
  });

  it("piped_shell_permission_shows_the_whole_command", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(
      event("session.tool.called", {
        sessionID: OWN,
        id: "call_1",
        input: { command: "echo deploy-side-effect | tee -a effects.log" },
      }),
    );

    expect(
      mapper.map(
        asked(OWN, {
          action: "shell",
          resources: ["echo deploy-side-effect", "tee -a effects.log"],
          source: { id: "call_1" },
        }),
      ),
    ).toMatchObject([
      {
        rawInput: { command: "echo deploy-side-effect | tee -a effects.log" },
      },
    ]);
  });
});

describe("v2 permission fallbacks", () => {
  it("shell_permission_without_a_known_tool_call_lists_every_resource", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(
        asked(OWN, {
          action: "shell",
          resources: ["echo deploy-side-effect", "tee -a effects.log"],
          source: { id: "call_unknown" },
        }),
      ),
    ).toMatchObject([
      {
        rawInput: { command: "echo deploy-side-effect\ntee -a effects.log" },
      },
    ]);
  });

  it("descendant_shell_permission_finds_its_own_tool_call", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(child(CHILD, OWN));
    mapper.map(
      event("session.tool.called", {
        sessionID: CHILD,
        id: "call_1",
        input: { command: "ls | wc -l" },
      }),
    );

    expect(
      mapper.map(
        asked(CHILD, {
          action: "shell",
          resources: ["ls", "wc -l"],
          source: { id: "call_1" },
        }),
      ),
    ).toMatchObject([{ rawInput: { command: "ls | wc -l" } }]);
  });
});

describe("v2 edit permission events", () => {
  it("edit_permission_resolves_locations_against_cwd", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(
        asked(OWN, {
          action: "edit",
          resources: ["src/a.ts", "/abs/b.ts", "src/a.ts"],
        }),
      ),
    ).toEqual([
      {
        type: "permission_request",
        requestId: "per_1",
        toolCallId: "per_1",
        title: "Edit file",
        kind: "edit",
        rawInput: { file_path: resolve(CWD, "src/a.ts") },
        locations: [resolve(CWD, "src/a.ts"), resolve("/abs/b.ts")],
        options: PERMISSION_OPTIONS,
      },
    ]);
  });
});

describe("v2 other permission events", () => {
  it("webfetch_permission_has_no_locations_or_input", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(
        asked(OWN, { action: "webfetch", resources: ["https://x.test"] }),
      ),
    ).toEqual([
      {
        type: "permission_request",
        requestId: "per_1",
        toolCallId: "per_1",
        title: "Fetch URL",
        kind: "fetch",
        locations: [],
        options: PERMISSION_OPTIONS,
      },
    ]);
  });

  it("other_actions_use_the_action_as_title", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(asked(OWN, { action: "external_directory" })),
    ).toMatchObject([
      { title: "external_directory", kind: "other", locations: [] },
    ]);
  });

  it("shell_permission_without_resources_has_no_input", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    const [request] = mapper.map(asked(OWN, { action: "shell" }));

    expect(request).not.toHaveProperty("rawInput");
  });

  it("descendant_permission_is_surfaced", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(child(CHILD, OWN));
    mapper.map(child(GRANDCHILD, CHILD));

    expect(mapper.scopeOf(asked(GRANDCHILD, { action: "shell" }))).toBe(
      "descendant",
    );
    expect(mapper.map(asked(GRANDCHILD, { action: "shell" }))).toHaveLength(1);
  });
});

describe("v2 scoping", () => {
  it("foreign_session_events_are_dropped", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    const stranger = [
      delta(STRANGER, "hi"),
      ended(STRANGER, "hi"),
      asked(STRANGER, { action: "shell", resources: ["ls"] }),
      event("session.step.started", {
        sessionID: STRANGER,
        model: { id: "m" },
      }),
      event("session.tool.called", { sessionID: STRANGER, id: "c", input: {} }),
    ];

    expect(stranger.flatMap((item) => mapper.map(item))).toEqual([]);
    expect(mapper.scopeOf(delta(STRANGER, "hi"))).toBe("foreign");
    expect(mapper.scopeOf(delta(OWN, "hi"))).toBe("own");
  });

  it("unrelated_child_sessions_stay_foreign", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(child(CHILD, STRANGER));

    expect(mapper.scopeOf(delta(CHILD, "x"))).toBe("foreign");
  });

  it("descendant_text_and_tools_are_dropped", () => {
    const mapper = createV2EventMapper(OWN, CWD);
    mapper.map(child(CHILD, OWN));

    expect(
      [
        delta(CHILD, "hi"),
        ended(CHILD, "hi"),
        event("session.tool.called", { sessionID: CHILD, id: "c", input: {} }),
        event("session.tool.success", { sessionID: CHILD, id: "c" }),
      ].flatMap((item) => mapper.map(item)),
    ).toEqual([]);
  });

  it("terminal_and_connection_events_map_to_nothing", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(
      mapper.map(event("session.execution.succeeded", { sessionID: OWN })),
    ).toEqual([]);
    expect(mapper.map(event("server.connected", {}))).toEqual([]);
    expect(mapper.scopeOf(event("server.connected", {}))).toBe("own");
  });
});

describe("v2 model events", () => {
  it("model_is_reported_once_per_turn", () => {
    const mapper = createV2EventMapper(OWN, CWD);

    expect(mapper.map(stepStarted("llama"))).toEqual([
      { type: "model", model: "llama" },
    ]);
    expect(mapper.map(stepStarted("llama"))).toEqual([]);
    expect(mapper.map(stepStarted("glm"))).toEqual([
      { type: "model", model: "glm" },
    ]);

    mapper.beginTurn();

    expect(mapper.map(stepStarted("glm"))).toEqual([
      { type: "model", model: "glm" },
    ]);
  });
});
