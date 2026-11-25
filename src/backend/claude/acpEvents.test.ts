import {
  RequestError,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  createAcpEventMapper,
  isAuthError,
  mapPromptError,
  mapSessionUpdate,
} from "./acpEvents";

type Update = SessionNotification["update"];

const RATE_LIMIT_KEY = "_claude/rateLimit";

function usage(meta: Record<string, unknown> | null | undefined): Update {
  return {
    sessionUpdate: "usage_update",
    used: 1,
    size: 10,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

describe("mapSessionUpdate messages", () => {
  it("text_chunk_keeps_message_id", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi" },
      messageId: "m-1",
    });

    expect(events).toEqual([{ type: "text", text: "Hi", messageId: "m-1" }]);
  });

  it("text_chunk_without_message_id_has_no_message_id_key", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi" },
      messageId: null,
    });

    expect(events).toStrictEqual([{ type: "text", text: "Hi" }]);
  });

  it("non_text_chunk_is_ignored", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AAAA", mimeType: "image/png" },
    });

    expect(events).toEqual([]);
  });
});

describe("mapSessionUpdate tool calls", () => {
  it("tool_call_defaults_kind_other_and_status_pending", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
    });

    expect(events).toStrictEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "Read file",
        kind: "other",
        status: "pending",
      },
    ]);
  });

  it("tool_call_passes_kind_status_and_raw_input", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Run ls",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" },
    });

    expect(events).toEqual([
      {
        type: "tool_call",
        toolCallId: "t2",
        title: "Run ls",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
    ]);
  });
});

describe("mapSessionUpdate tool call updates", () => {
  it("tool_call_update_joins_text_content_and_skips_other_entries", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t3",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "line one" } },
        { type: "diff", path: "/a.ts", newText: "x" },
        { type: "terminal", terminalId: "term-1" },
        { type: "content", content: { type: "text", text: "line two" } },
        {
          type: "content",
          content: { type: "image", data: "AAAA", mimeType: "image/png" },
        },
      ],
    });

    expect(events).toStrictEqual([
      {
        type: "tool_call_update",
        toolCallId: "t3",
        status: "completed",
        output: "line one\nline two",
        diffs: [
          {
            path: "/a.ts",
            change: "created",
            patch: "@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file",
          },
        ],
      },
    ]);
  });

  it("tool_output_console_fence_unwrapped", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t5",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "```console\ndeploy-side-effect\n```",
          },
        },
      ],
    });

    expect(events).toStrictEqual([
      {
        type: "tool_call_update",
        toolCallId: "t5",
        status: "completed",
        output: "deploy-side-effect",
      },
    ]);
  });

  it.each([
    [
      "unfence_longer_backtick_run_and_nested_fence",
      "````md\n```\nx\n```\n````",
      "```\nx\n```",
    ],
    [
      "unfence_leaves_plain_text",
      "just text\n```not a fence```",
      "just text\n```not a fence```",
    ],
    [
      "unfence_leaves_text_around_a_block",
      "before\n```\na\n```",
      "before\n```\na\n```",
    ],
    [
      "unfence_leaves_two_blocks",
      "```\na\n```\nb\n```\nc\n```",
      "```\na\n```\nb\n```\nc\n```",
    ],
    ["unfence_empty_block_to_empty", "```console\n```", ""],
    [
      "unfence_interior_longer_fence_kept",
      "```\na\n````\nb\n```",
      "```\na\n````\nb\n```",
    ],
    [
      "unfence_interior_indented_fence_kept",
      "```\na\n   ```\nb\n```",
      "```\na\n   ```\nb\n```",
    ],
    [
      "unfence_interior_fence_trailing_space_kept",
      "```\na\n``` \nb\n```",
      "```\na\n``` \nb\n```",
    ],
    ["unfence_trailing_space_after_final_fence", "```console\nx\n```  ", "x"],
    [
      "unfence_crlf",
      "```console\r\nline one\r\nline two\r\n```",
      "line one\r\nline two",
    ],
  ])("%s", (_name, text, expected) => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t9",
      content: [{ type: "content", content: { type: "text", text } }],
    });

    expect(events).toStrictEqual([
      { type: "tool_call_update", toolCallId: "t9", output: expected },
    ]);
  });

  it("tool_call_update_maps_title_kind_and_raw_input", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t7",
      title: "ls -la",
      kind: "execute",
      rawInput: { command: "ls -la", description: "List" },
    });

    expect(events).toStrictEqual([
      {
        type: "tool_call_update",
        toolCallId: "t7",
        title: "ls -la",
        kind: "execute",
        rawInput: { command: "ls -la", description: "List" },
      },
    ]);
  });

  it("tool_call_update_without_status_or_output_has_only_the_id", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t4",
      status: null,
    });

    expect(events).toStrictEqual([
      { type: "tool_call_update", toolCallId: "t4" },
    ]);
  });

  it("tool_call_update_uses_string_raw_output_when_no_text_content", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t5",
      rawOutput: "raw result",
    });

    expect(events).toStrictEqual([
      { type: "tool_call_update", toolCallId: "t5", output: "raw result" },
    ]);
  });

  it("tool_call_update_ignores_non_string_raw_output", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t6",
      content: [],
      rawOutput: { exitCode: 0 },
    });

    expect(events).toStrictEqual([
      { type: "tool_call_update", toolCallId: "t6" },
    ]);
  });
});

describe("mapSessionUpdate rate limit", () => {
  it("usage_update_maps_rate_limit_meta_with_raw_values", () => {
    const events = mapSessionUpdate(
      usage({
        [RATE_LIMIT_KEY]: {
          status: "rejected",
          resetsAt: 1_700_003_600,
          rateLimitType: "five_hour",
          utilization: 0.97,
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "rate_limit",
        status: "rejected",
        resetsAt: 1_700_003_600,
        rateLimitType: "five_hour",
        utilization: 0.97,
      },
      {
        type: "context_usage",
        usage: { usedTokens: 1, limitTokens: 10 },
      },
    ]);
  });

  it("usage_update_with_non_string_status_maps_unknown_status", () => {
    const events = mapSessionUpdate(
      usage({ [RATE_LIMIT_KEY]: { status: 7, resetsAt: "soon" } }),
    );

    expect(events).toEqual([
      {
        type: "rate_limit",
        status: "unknown",
        resetsAt: "soon",
        rateLimitType: undefined,
        utilization: undefined,
      },
      {
        type: "context_usage",
        usage: { usedTokens: 1, limitTokens: 10 },
      },
    ]);
  });

  it("maps_usage_update_to_context_usage", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "usage_update",
      used: 45_000,
      size: 200_000,
    });

    expect(events).toEqual([
      {
        type: "context_usage",
        usage: { usedTokens: 45_000, limitTokens: 200_000 },
      },
    ]);
  });

  it("acp_zero_size_gives_unknown_limit", () => {
    const events = mapSessionUpdate({
      sessionUpdate: "usage_update",
      used: 12_345,
      size: 0,
    });

    expect(events).toEqual([
      {
        type: "context_usage",
        usage: { usedTokens: 12_345, limitTokens: null },
      },
    ]);
  });

  it("acp_ignores_rate_limit_meta_with_wrong_type", () => {
    const contextOnly = [
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 10 } },
    ];
    expect(mapSessionUpdate(usage({ [RATE_LIMIT_KEY]: "rejected" }))).toEqual(
      contextOnly,
    );
    expect(mapSessionUpdate(usage({ [RATE_LIMIT_KEY]: null }))).toEqual(
      contextOnly,
    );
  });

  it("usage_update_without_meta_maps_nothing", () => {
    const contextOnly = [
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 10 } },
    ];
    expect(mapSessionUpdate(usage(undefined))).toEqual(contextOnly);
    expect(mapSessionUpdate(usage(null))).toEqual(contextOnly);
    expect(mapSessionUpdate(usage({ other: { status: "rejected" } }))).toEqual(
      contextOnly,
    );
  });
});

describe("mapSessionUpdate ignored updates", () => {
  it.each<[string, Update]>([
    [
      "thought",
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
    ],
    ["plan", { sessionUpdate: "plan", entries: [] }],
    [
      "commands",
      { sessionUpdate: "available_commands_update", availableCommands: [] },
    ],
    ["session_info", { sessionUpdate: "session_info_update", title: "T" }],
    [
      "user_chunk",
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "me" },
      },
    ],
  ])("known_update_%s_is_ignored", (_name, update) => {
    expect(mapSessionUpdate(update)).toEqual([]);
  });

  it("acp_ignores_unknown_session_update", () => {
    const unknown = JSON.parse(
      '{"sessionUpdate":"brand_new_kind","payload":1}',
    ) as Update;

    expect(mapSessionUpdate(unknown)).toEqual([]);
  });
});

describe("mapPromptError", () => {
  it("maps_request_error_with_error_kind", () => {
    const error = new RequestError(-32603, "Rate limit reached", {
      errorKind: "rate_limit",
    });

    expect(mapPromptError(error)).toEqual({
      type: "turn_error",
      errorKind: "rate_limit",
      rpcCode: -32603,
      message: "Rate limit reached",
    });
  });

  it("maps_plain_json_rpc_object", () => {
    const error = { code: -32000, message: "Auth", data: { errorKind: "x" } };

    expect(mapPromptError(error)).toEqual({
      type: "turn_error",
      errorKind: "x",
      rpcCode: -32000,
      message: "Auth",
    });
  });

  it("non_request_error_has_null_code_and_kind", () => {
    expect(mapPromptError(new Error("socket closed"))).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: "socket closed",
    });
  });

  it("non_string_error_kind_maps_to_null", () => {
    const error = new RequestError(-32603, "boom", { errorKind: 42 });

    expect(mapPromptError(error)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: -32603,
      message: "boom",
    });
  });

  it("non_error_value_maps_to_unknown_error_message", () => {
    expect(mapPromptError("oops")).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: "unknown error",
    });
    expect(mapPromptError(undefined).rpcCode).toBeNull();
  });
});

describe("isAuthError", () => {
  it("accepts_rpc_code_32000", () => {
    expect(isAuthError(new RequestError(-32000, "Auth required"))).toBe(true);
  });

  it("accepts_auth_required_error_kind", () => {
    const error = new RequestError(-32603, "x", {
      errorKind: "auth_required",
    });

    expect(isAuthError(error)).toBe(true);
  });

  it("rejects_other_errors", () => {
    expect(isAuthError(new RequestError(-32603, "x", { errorKind: "y" }))).toBe(
      false,
    );
    expect(isAuthError(new Error("auth_required"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});

const EXPECTED_EDIT_DIFF = {
  path: "/w/a.ts",
  change: "modified",
  patch:
    "@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file",
};

describe("mapSessionUpdate diff content", () => {
  it("maps_acp_diff_content_to_file_diffs", () => {
    const diffContent = [
      { type: "diff" as const, path: "/w/a.ts", oldText: "a", newText: "b" },
    ];
    expect(
      mapSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t-edit",
        title: "Edit /w/a.ts",
        kind: "edit",
        status: "in_progress",
        content: diffContent,
      }),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "t-edit",
        title: "Edit /w/a.ts",
        kind: "edit",
        status: "in_progress",
      },
      {
        type: "tool_call_update",
        toolCallId: "t-edit",
        diffs: [EXPECTED_EDIT_DIFF],
      },
    ]);
    expect(
      mapSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t-edit",
        status: "completed",
        content: diffContent,
      }),
    ).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "t-edit",
        status: "completed",
        diffs: [EXPECTED_EDIT_DIFF],
      },
    ]);
  });
});

it("acp_write_without_old_text_is_created", () => {
  const events = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-write",
    status: "completed",
    content: [
      { type: "diff", path: "/w/new.ts", oldText: null, newText: "hello\n" },
    ],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-write",
      status: "completed",
      diffs: [
        {
          path: "/w/new.ts",
          change: "created",
          patch: "@@ -0,0 +1,1 @@\n+hello",
        },
      ],
    },
  ]);
});

it("acp_hook_hunk_keeps_real_line_numbers", () => {
  const events = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-hook-1",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "/w/a.ts",
        oldText: "c1\nc2\nc3\nold\nc4\nc5\nc6\n",
        newText: "c1\nc2\nc3\nnew1\nnew2\nc4\nc5\nc6\n",
      },
    ],
    locations: [{ path: "/w/a.ts", line: 117 }],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-hook-1",
      status: "completed",
      diffs: [
        {
          path: "/w/a.ts",
          change: "modified",
          patch:
            "@@ -117,7 +117,8 @@\n c1\n c2\n c3\n-old\n+new1\n+new2\n c4\n c5\n c6",
        },
      ],
    },
  ]);
});

it("acp_hook_hunks_of_one_file_join_into_one_diff", () => {
  const events = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-hook-2",
    status: "completed",
    content: [
      { type: "diff", path: "/w/a.ts", oldText: "a\n", newText: "a1\na2\n" },
      { type: "diff", path: "/w/a.ts", oldText: "b\n", newText: "B\n" },
    ],
    locations: [
      { path: "/w/a.ts", line: 10 },
      { path: "/w/a.ts", line: 50 },
    ],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-hook-2",
      status: "completed",
      diffs: [
        {
          path: "/w/a.ts",
          change: "modified",
          patch: "@@ -10,1 +10,2 @@\n-a\n+a1\n+a2\n@@ -49,1 +50,1 @@\n-b\n+B",
        },
      ],
    },
  ]);
});

it("acp_write_same_content_clears_creation_diff", () => {
  const events = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-same",
    status: "completed",
    content: [
      { type: "diff", path: "/w/a.ts", oldText: "same\n", newText: "same\n" },
    ],
    locations: [{ path: "/w/a.ts" }],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-same",
      status: "completed",
      diffs: [],
    },
  ]);
});

it("acp_write_large_existing_file_reports_too_large_not_created", () => {
  const mapper = createAcpEventMapper();
  mapper.map({
    sessionUpdate: "tool_call",
    toolCallId: "t-large",
    title: "Write /w/big.ts",
    kind: "edit",
    status: "pending",
    content: [{ type: "diff", path: "/w/big.ts", oldText: null, newText: "x" }],
  });

  const events = mapper.map({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-large",
    status: "completed",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "Updated `/w/big.ts` (previous content too large to diff)",
        },
      },
    ],
    locations: [{ path: "/w/big.ts" }],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-large",
      status: "completed",
      output: "Updated `/w/big.ts` (previous content too large to diff)",
      diffs: [{ path: "/w/big.ts", change: "modified", omitted: "too_large" }],
    },
  ]);
});

it("acp_read_update_with_text_is_not_an_edit", () => {
  const mapper = createAcpEventMapper();
  mapper.map({
    sessionUpdate: "tool_call",
    toolCallId: "t-read",
    title: "Read /w/a.ts",
    kind: "read",
    status: "pending",
  });

  const events = mapper.map({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-read",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "file body" } },
    ],
    locations: [{ path: "/w/a.ts" }],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-read",
      status: "completed",
      output: "file body",
    },
  ]);
});

it("acp_too_large_write_uses_held_locations", () => {
  const mapper = createAcpEventMapper();
  mapper.map({
    sessionUpdate: "tool_call",
    toolCallId: "t-held-large",
    title: "Write /w/big.ts",
    kind: "edit",
    status: "pending",
    content: [{ type: "diff", path: "/w/big.ts", oldText: null, newText: "x" }],
    locations: [{ path: "/w/big.ts" }],
  });

  const events = mapper.map({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-held-large",
    status: "completed",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "Updated `/w/big.ts` (previous content too large to diff)",
        },
      },
    ],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-held-large",
      status: "completed",
      output: "Updated `/w/big.ts` (previous content too large to diff)",
      diffs: [{ path: "/w/big.ts", change: "modified", omitted: "too_large" }],
    },
  ]);
});

it("acp_hook_hunks_pair_with_held_locations", () => {
  const mapper = createAcpEventMapper();
  mapper.map({
    sessionUpdate: "tool_call",
    toolCallId: "t-held-hunk",
    title: "Edit /w/a.ts",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/w/a.ts", line: 120 }],
  });

  const events = mapper.map({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-held-hunk",
    status: "completed",
    content: [
      { type: "diff", path: "/w/a.ts", oldText: "old\n", newText: "new\n" },
    ],
  });

  expect(events).toEqual([
    {
      type: "tool_call_update",
      toolCallId: "t-held-hunk",
      status: "completed",
      diffs: [
        {
          path: "/w/a.ts",
          change: "modified",
          patch: "@@ -120,1 +120,1 @@\n-old\n+new",
        },
      ],
    },
  ]);
});
