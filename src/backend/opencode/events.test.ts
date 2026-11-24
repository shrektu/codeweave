import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../domain/events";

import { createEventMapper } from "./events";
import { parseOpencodeEvent, type OpencodeEvent } from "./protocol";

const SESSION = "ses_1";
const CWD = "/work/repo";
const ASSISTANT_MESSAGE = "msg_a";
const USER_MESSAGE = "msg_u";
const CHILD = "ses_child";
const GRANDCHILD = "ses_grandchild";

function parsed(
  type: string,
  properties: Record<string, unknown>,
): OpencodeEvent {
  const event = parseOpencodeEvent({ type, properties });
  if (event === null) {
    expect.unreachable(`fixture does not parse: ${type}`);
  }
  return event;
}

function messageUpdated(
  id: string,
  role: string,
  sessionID = SESSION,
): OpencodeEvent {
  return parsed("message.updated", { info: { id, role, sessionID } });
}

function sessionCreated(id: string, parentID: string): OpencodeEvent {
  return parsed("session.created", { info: { id, parentID } });
}

function textPart(
  id: string,
  text: string,
  sessionID = SESSION,
  messageID = ASSISTANT_MESSAGE,
  extra: Record<string, unknown> = {},
): OpencodeEvent {
  return parsed("message.part.updated", {
    part: { type: "text", id, sessionID, messageID, text, ...extra },
  });
}

function toolPart(
  tool: string,
  state: Record<string, unknown>,
  callID = "call_1",
): OpencodeEvent {
  return parsed("message.part.updated", {
    part: {
      type: "tool",
      id: `prt_${callID}`,
      sessionID: SESSION,
      callID,
      tool,
      state,
    },
  });
}

function permission(fields: Record<string, unknown>): OpencodeEvent {
  return parsed("permission.asked", {
    id: "per_1",
    sessionID: SESSION,
    patterns: [],
    metadata: {},
    ...fields,
  });
}

function mapAll(events: readonly OpencodeEvent[]): AgentEvent[] {
  const mapper = createEventMapper(SESSION, CWD);
  return [messageUpdated(ASSISTANT_MESSAGE, "assistant"), ...events].flatMap(
    (event) => mapper.map(event),
  );
}

describe("text parts", () => {
  it("emit_only_the_new_suffix_of_each_snapshot", () => {
    expect(
      mapAll([
        textPart("p1", "Hel"),
        textPart("p1", "Hello"),
        textPart("p1", "Hello"),
        textPart("p2", "Other"),
      ]),
    ).toEqual([
      { type: "text", messageId: "p1", text: "Hel" },
      { type: "text", messageId: "p1", text: "lo" },
      { type: "text", messageId: "p2", text: "Other" },
    ]);
  });

  it("emit_the_full_text_when_it_does_not_extend_the_previous_one", () => {
    expect(mapAll([textPart("p1", "Hello"), textPart("p1", "Bye")])).toEqual([
      { type: "text", messageId: "p1", text: "Hello" },
      { type: "text", messageId: "p1", text: "Bye" },
    ]);
  });

  it("from_another_session_are_ignored", () => {
    expect(mapAll([textPart("p1", "x", "ses_other")])).toEqual([]);
  });

  it("without_a_session_id_are_accepted", () => {
    const event = parsed("message.part.updated", {
      part: { type: "text", id: "p1", messageID: ASSISTANT_MESSAGE, text: "x" },
    });

    expect(mapAll([event])).toEqual([
      { type: "text", messageId: "p1", text: "x" },
    ]);
  });

  it("user_and_synthetic_parts_are_not_agent_text", () => {
    const mapper = createEventMapper(SESSION, CWD);
    const mapped = [
      messageUpdated(USER_MESSAGE, "user"),
      textPart("p_user", "do it", SESSION, USER_MESSAGE),
      messageUpdated(ASSISTANT_MESSAGE, "assistant"),
      textPart("p_synthetic", "hint", SESSION, ASSISTANT_MESSAGE, {
        synthetic: true,
      }),
      textPart("p_unknown", "orphan", SESSION, "msg_unknown"),
      textPart("p_real", "answer"),
    ].flatMap((event) => mapper.map(event));

    expect(mapped).toEqual([
      { type: "text", messageId: "p_real", text: "answer" },
    ]);
  });
});

describe("child sessions", () => {
  function permissionFrom(sessionID: string): OpencodeEvent {
    return permission({
      id: `per_${sessionID}`,
      sessionID,
      permission: "bash",
    });
  }

  it("child_session_permission_is_mapped", () => {
    const mapper = createEventMapper(SESSION, CWD);
    const mapped = [
      sessionCreated(CHILD, SESSION),
      sessionCreated(GRANDCHILD, CHILD),
      permissionFrom(CHILD),
      permissionFrom(GRANDCHILD),
    ].flatMap((event) => mapper.map(event));

    expect(mapped.map((event) => event.type)).toEqual([
      "permission_request",
      "permission_request",
    ]);
    expect(mapped).toMatchObject([
      { requestId: `per_${CHILD}` },
      { requestId: `per_${GRANDCHILD}` },
    ]);
  });

  it("unrelated_session_permission_is_not_mapped", () => {
    const mapper = createEventMapper(SESSION, CWD);
    const mapped = [
      sessionCreated("ses_stranger", "ses_elsewhere"),
      permissionFrom("ses_stranger"),
    ].flatMap((event) => mapper.map(event));

    expect(mapped).toEqual([]);
  });

  it("child_text_and_tool_parts_are_not_mapped", () => {
    const mapper = createEventMapper(SESSION, CWD);
    const mapped = [
      sessionCreated(CHILD, SESSION),
      messageUpdated("msg_child", "assistant", CHILD),
      textPart("p_child", "child text", CHILD, "msg_child"),
    ].flatMap((event) => mapper.map(event));

    expect(mapped).toEqual([]);
  });

  it("scope_tells_own_descendant_and_foreign_sessions_apart", () => {
    const mapper = createEventMapper(SESSION, CWD);
    mapper.map(sessionCreated(CHILD, SESSION));

    expect(
      [SESSION, CHILD, "ses_other"].map((id) =>
        mapper.scopeOf(permissionFrom(id)),
      ),
    ).toEqual(["own", "descendant", "foreign"]);
  });
});

describe("tool parts", () => {
  it.each([
    ["bash", "execute"],
    ["edit", "edit"],
    ["write", "edit"],
    ["patch", "edit"],
    ["multiedit", "edit"],
    ["read", "read"],
    ["list", "read"],
    ["glob", "search"],
    ["grep", "search"],
    ["webfetch", "fetch"],
    ["task", "other"],
  ])("tool_%s_has_kind_%s", (tool, kind) => {
    expect(mapAll([toolPart(tool, { status: "pending" })])).toEqual([
      {
        type: "tool_call",
        toolCallId: "call_1",
        title: tool,
        kind,
        status: "pending",
      },
    ]);
  });
});

describe("tool part lifecycle", () => {
  it("first_sight_is_tool_call_and_later_sightings_are_updates", () => {
    expect(
      mapAll([
        toolPart("bash", { status: "pending", input: { command: "ls" } }),
        toolPart("bash", {
          status: "running",
          input: { command: "ls" },
          title: "ls",
        }),
        toolPart("bash", {
          status: "completed",
          input: { command: "ls" },
          output: "a.txt",
        }),
      ]),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "call_1",
        title: "bash",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      },
      {
        type: "tool_call_update",
        toolCallId: "call_1",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
      {
        type: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawInput: { command: "ls" },
        output: "a.txt",
      },
    ]);
  });
});

describe("tool part titles and failures", () => {
  it("title_comes_from_state_and_error_becomes_failed_output", () => {
    expect(
      mapAll([
        toolPart("bash", { status: "running", title: "Run tests" }),
        toolPart("bash", { status: "error", error: "exit 1" }),
      ]),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "call_1",
        title: "Run tests",
        kind: "execute",
        status: "in_progress",
      },
      {
        type: "tool_call_update",
        toolCallId: "call_1",
        status: "failed",
        output: "exit 1",
      },
    ]);
  });
});

describe("permission.asked", () => {
  it("bash_carries_the_command_from_metadata", () => {
    const [request] = mapAll([
      permission({
        permission: "bash",
        patterns: ["git status*"],
        metadata: { command: "git status --short" },
        tool: { callID: "call_7" },
      }),
    ]);

    expect(request).toMatchObject({
      type: "permission_request",
      requestId: "per_1",
      toolCallId: "call_7",
      title: "Run command",
      kind: "execute",
      rawInput: { command: "git status --short" },
      locations: [],
    });
  });

  it("bash_falls_back_to_the_first_pattern_and_the_request_id", () => {
    const [request] = mapAll([
      permission({ permission: "bash", patterns: ["make build"] }),
    ]);

    expect(request).toMatchObject({
      toolCallId: "per_1",
      rawInput: { command: "make build" },
    });
  });

  it("bash_workdir_of_the_tool_input_becomes_the_cwd", () => {
    const requests = mapAll([
      toolPart(
        "bash",
        { status: "pending", input: { command: "touch x", workdir: "sub" } },
        "call_7",
      ),
      toolPart(
        "bash",
        {
          status: "pending",
          input: { command: "touch y", workdir: "/tmp/out" },
        },
        "call_8",
      ),
      permission({
        permission: "bash",
        metadata: { command: "touch x" },
        tool: { callID: "call_7" },
      }),
      permission({
        id: "per_2",
        permission: "bash",
        metadata: { command: "touch y" },
        tool: { callID: "call_8" },
      }),
    ]).filter((event) => event.type === "permission_request");

    expect(requests.map((request) => request.rawInput)).toEqual([
      { command: "touch x", cwd: resolve("/work/repo", "sub") },
      { command: "touch y", cwd: resolve("/tmp/out") },
    ]);
  });

  it("bash_without_a_workdir_has_no_cwd", () => {
    const requests = mapAll([
      toolPart(
        "bash",
        { status: "pending", input: { command: "touch x", workdir: "" } },
        "call_7",
      ),
      permission({
        permission: "bash",
        metadata: { command: "touch x" },
        tool: { callID: "call_7" },
      }),
    ]).filter((event) => event.type === "permission_request");

    expect(requests.map((request) => request.rawInput)).toEqual([
      { command: "touch x" },
    ]);
  });
});

describe("permission.asked for edits", () => {
  it("edit_resolves_relative_patterns_against_cwd_and_dedupes", () => {
    const [request] = mapAll([
      permission({
        permission: "edit",
        patterns: ["src/a.ts", "/work/repo/src/a.ts", "docs/b.md"],
        metadata: { filepath: "/work/repo/src/a.ts" },
      }),
    ]);

    expect(request).toMatchObject({
      kind: "edit",
      title: "Edit file",
      rawInput: { file_path: resolve(CWD, "src/a.ts") },
      locations: [resolve(CWD, "src/a.ts"), resolve(CWD, "docs/b.md")],
    });
  });

  it("edit_without_filepath_uses_the_first_pattern", () => {
    const [request] = mapAll([
      permission({ permission: "edit", patterns: ["lib/x.ts"] }),
    ]);

    expect(request).toMatchObject({
      rawInput: { file_path: resolve(CWD, "lib/x.ts") },
      locations: [resolve(CWD, "lib/x.ts")],
    });
  });
});

describe("permission.asked for other tools", () => {
  it("webfetch_and_unknown_permissions_have_no_raw_input", () => {
    const [fetch, other] = mapAll([
      permission({ permission: "webfetch", patterns: ["https://x.dev"] }),
      permission({ id: "per_2", permission: "external_directory" }),
    ]);

    expect(fetch).toMatchObject({ kind: "fetch", title: "Fetch URL" });
    expect(fetch).not.toHaveProperty("rawInput");
    expect(other).toMatchObject({
      kind: "other",
      title: "external_directory",
    });
  });

  it("offers_once_always_and_reject", () => {
    const [request] = mapAll([permission({ permission: "bash" })]);

    expect(request).toMatchObject({
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
  });

  it("from_another_session_is_ignored", () => {
    expect(
      mapAll([permission({ permission: "bash", sessionID: "ses_other" })]),
    ).toEqual([]);
  });
});

describe("session events", () => {
  it("are_not_mapped_to_agent_events", () => {
    expect(
      mapAll([
        parsed("session.idle", { sessionID: SESSION }),
        parsed("session.error", { sessionID: SESSION }),
        parsed("session.status", {
          sessionID: SESSION,
          status: { type: "busy" },
        }),
      ]),
    ).toEqual([]);
  });
});
