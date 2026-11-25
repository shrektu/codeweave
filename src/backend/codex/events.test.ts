import { describe, expect, it } from "vitest";

import { PermissionProfile } from "../../domain/types";
import {
  commandItem,
  fileChangeItem,
  rateWindow,
} from "../../../tests/fakes/fakeCodexAppServer";

import {
  EMPTY_RATE_LIMITS,
  commandPermission,
  errorKindOf,
  fileChangeOf,
  mapAgentMessageDelta,
  mapItemCompleted,
  mapItemStarted,
  mapTurnError,
  mergeRateLimits,
  permissionsPermission,
  policyFor,
  replaceRateLimits,
  sandboxPolicyFor,
  toRateLimitEvent,
} from "./events";
import {
  RateLimitSnapshotSchema,
  ThreadItemSchema,
  type RateLimitSnapshot,
  type ThreadItem,
} from "./protocol";

function item(raw: Readonly<Record<string, unknown>>): ThreadItem {
  return ThreadItemSchema.parse(raw);
}

function snapshot(raw: Readonly<Record<string, unknown>>): RateLimitSnapshot {
  return RateLimitSnapshotSchema.parse(raw);
}

const RESET_EARLY = 1_700_000_000;
const RESET_LATE = 1_700_009_000;

describe("codex item mapping", () => {
  it("command_started_and_completed_carry_command_and_output", () => {
    expect(
      mapItemStarted(item(commandItem("c1", "ls -la", "inProgress"))),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "c1",
        title: "ls -la",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls -la" },
      },
    ]);
    expect(
      mapItemCompleted(item(commandItem("c1", "ls -la", "failed", "boom"))),
    ).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "c1",
        status: "failed",
        rawInput: { command: "ls -la" },
        output: "boom",
      },
    ]);
  });

  it("declined_command_maps_to_failed_and_empty_output_is_omitted", () => {
    expect(
      mapItemCompleted(item(commandItem("c2", "rm x", "declined", ""))),
    ).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "c2",
        status: "failed",
        rawInput: { command: "rm x" },
      },
    ]);
  });
});

describe("codex item mapping: edits and searches", () => {
  it("file_change_lists_paths_in_title_and_has_no_raw_input", () => {
    const change = item(
      fileChangeItem("f1", ["/w/a.ts", "/w/b.ts"], "inProgress"),
    );

    expect(mapItemStarted(change)).toEqual([
      {
        type: "tool_call",
        toolCallId: "f1",
        title: "Edit /w/a.ts, /w/b.ts",
        kind: "edit",
        status: "in_progress",
      },
    ]);
    expect(fileChangeOf(change)).toEqual({
      itemId: "f1",
      paths: ["/w/a.ts", "/w/b.ts"],
    });
    expect(fileChangeOf(item(commandItem("c", "ls", "inProgress")))).toBeNull();
  });

  it("maps_codex_file_change_to_diffs", () => {
    const completed = item({
      type: "fileChange",
      id: "fc-1",
      status: "completed",
      changes: [
        { path: "/w/new.ts", kind: { type: "add" }, diff: "hello\n" },
        {
          path: "/w/mod.ts",
          kind: { type: "update" },
          diff: "diff --git a/w/mod.ts b/w/mod.ts\n--- a/w/mod.ts\n+++ b/w/mod.ts\n@@ -1 +1 @@\n-old\n+new",
        },
        { path: "/w/old.ts", kind: { type: "delete" }, diff: "bye\n" },
      ],
    });

    expect(mapItemCompleted(completed)).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "fc-1",
        status: "completed",
        diffs: [
          {
            path: "/w/new.ts",
            change: "created",
            patch: "@@ -0,0 +1,1 @@\n+hello",
          },
          {
            path: "/w/mod.ts",
            change: "modified",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            path: "/w/old.ts",
            change: "deleted",
            patch: "@@ -1,1 +0,0 @@\n-bye",
          },
        ],
      },
    ]);
  });

  it("codex_update_patch_drops_headers_and_uses_move_path", () => {
    const completed = item({
      type: "fileChange",
      id: "fc-move",
      status: "completed",
      changes: [
        {
          path: "/w/old.ts",
          kind: { type: "update", move_path: "/w/renamed.ts" },
          diff: "diff --git a/w/old.ts b/w/renamed.ts\nindex 111..222 100644\n--- a/w/old.ts\n+++ b/w/renamed.ts\n@@ -1,1 +1,1 @@\n-a\n+b",
        },
      ],
    });

    expect(mapItemCompleted(completed)).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "fc-move",
        status: "completed",
        diffs: [
          {
            path: "/w/renamed.ts",
            change: "modified",
            patch: "@@ -1,1 +1,1 @@\n-a\n+b",
          },
        ],
      },
    ]);
  });

  it("codex_oversized_patch_is_omitted", () => {
    const huge = `@@ -1,1 +1,1 @@\n+${"x".repeat(70_000)}`;
    const completed = item({
      type: "fileChange",
      id: "fc-big",
      status: "completed",
      changes: [{ path: "/w/big.ts", kind: { type: "update" }, diff: huge }],
    });

    expect(mapItemCompleted(completed)).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "fc-big",
        status: "completed",
        diffs: [
          {
            path: "/w/big.ts",
            change: "modified",
            omitted: "too_large",
          },
        ],
      },
    ]);
  });

  it("codex_change_without_diff_is_not_reported", () => {
    const completed = item({
      type: "fileChange",
      id: "fc-nodiff",
      status: "completed",
      changes: [{ path: "/w/no-diff.ts", kind: { type: "update" } }],
    });

    expect(mapItemCompleted(completed)).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "fc-nodiff",
        status: "completed",
        diffs: [
          {
            path: "/w/no-diff.ts",
            change: "modified",
            omitted: "not_reported",
          },
        ],
      },
    ]);
  });

  it("mcp_tool_call_uses_server_dot_tool_title", () => {
    expect(
      mapItemStarted(
        item({
          type: "mcpToolCall",
          id: "m1",
          server: "github",
          tool: "search_issues",
          status: "inProgress",
          arguments: {},
        }),
      ),
    ).toEqual([
      {
        type: "tool_call",
        toolCallId: "m1",
        title: "github.search_issues",
        kind: "other",
        status: "in_progress",
      },
    ]);
  });
});

describe("codex item mapping: searches and messages", () => {
  it("web_search_without_status_defaults_by_lifecycle_stage", () => {
    const search = item({ type: "webSearch", id: "w1", query: "zod 4 loose" });

    expect(mapItemStarted(search)).toEqual([
      {
        type: "tool_call",
        toolCallId: "w1",
        title: "zod 4 loose",
        kind: "search",
        status: "in_progress",
      },
    ]);
    expect(mapItemCompleted(search)).toEqual([
      { type: "tool_call_update", toolCallId: "w1", status: "completed" },
    ]);
  });

  it("unknown_and_message_items_produce_no_tool_events", () => {
    expect(mapItemStarted(item({ type: "reasoning", id: "r1" }))).toEqual([]);
    expect(
      mapItemCompleted(item({ type: "plan", id: "p1", text: "x" })),
    ).toEqual([]);
    expect(
      mapItemStarted(item({ type: "agentMessage", id: "a1", text: "hi" })),
    ).toEqual([]);
    expect(
      mapItemStarted(item({ type: "commandExecution", id: "broken" })),
    ).toEqual([]);
  });

  it("agent_message_delta_uses_item_id_as_message_id", () => {
    expect(mapAgentMessageDelta({ itemId: "a1", delta: "He" })).toEqual({
      type: "text",
      messageId: "a1",
      text: "He",
    });
  });
});

const FULL = snapshot({
  primary: rateWindow(40, 300, RESET_EARLY),
  secondary: rateWindow(70, 10_080, RESET_LATE),
});

describe("codex rate limit merging", () => {
  it("sparse_rate_limit_update_merges", () => {
    const first = mergeRateLimits(EMPTY_RATE_LIMITS, FULL, true);

    const merged = mergeRateLimits(
      first,
      snapshot({ primary: rateWindow(55, 300, RESET_EARLY), secondary: null }),
    );

    expect(merged.primary).toEqual(rateWindow(55, 300, RESET_EARLY));
    expect(merged.secondary).toEqual(rateWindow(70, 10_080, RESET_LATE));
    expect(merged.ordinaryUsageAllowed).toBe(true);
    expect(
      mergeRateLimits(first, snapshot({ rateLimitReachedType: null })).primary,
    ).toEqual(rateWindow(40, 300, RESET_EARLY));
  });

  it("full_rate_limit_read_clears_reached_type", () => {
    const stuck = mergeRateLimits(
      EMPTY_RATE_LIMITS,
      snapshot({
        primary: rateWindow(100, 300, RESET_EARLY),
        rateLimitReachedType: "rate_limit_reached",
      }),
      false,
    );

    const replaced = replaceRateLimits(
      snapshot({ primary: rateWindow(5, 300, RESET_EARLY), secondary: null }),
      true,
    );

    expect(stuck.rateLimitReachedType).toBe("rate_limit_reached");
    expect(replaced).toEqual({
      primary: rateWindow(5, 300, RESET_EARLY),
      secondary: null,
      rateLimitReachedType: null,
      ordinaryUsageAllowed: true,
      extra: [],
    });
    expect(toRateLimitEvent(replaced)?.status).toBe("allowed");
  });

  it("sparse_update_with_window_clears_reached_type", () => {
    const stuck = mergeRateLimits(
      EMPTY_RATE_LIMITS,
      snapshot({
        primary: rateWindow(100, 300, RESET_EARLY),
        rateLimitReachedType: "rate_limit_reached",
      }),
      true,
    );

    const cleared = mergeRateLimits(
      stuck,
      snapshot({ secondary: rateWindow(20, 10_080, RESET_LATE) }),
    );

    expect(cleared.rateLimitReachedType).toBeNull();
    expect(cleared.primary).toEqual(rateWindow(100, 300, RESET_EARLY));
  });

  it("sparse_update_with_only_reached_type_marks_exhausted", () => {
    const allowed = mergeRateLimits(EMPTY_RATE_LIMITS, FULL, true);

    const exhausted = mergeRateLimits(
      allowed,
      snapshot({ rateLimitReachedType: "rate_limit_reached" }),
    );

    expect(exhausted.rateLimitReachedType).toBe("rate_limit_reached");
    expect(exhausted.primary).toEqual(rateWindow(40, 300, RESET_EARLY));
    expect(toRateLimitEvent(exhausted)?.status).toBe("rejected");
  });

  it("sparse_update_without_window_keeps_reached_type", () => {
    const stuck = mergeRateLimits(
      EMPTY_RATE_LIMITS,
      snapshot({
        primary: rateWindow(100, 300, RESET_EARLY),
        rateLimitReachedType: "rate_limit_reached",
      }),
    );

    const kept = mergeRateLimits(
      stuck,
      snapshot({ primary: null, rateLimitReachedType: null }),
    );

    expect(kept.rateLimitReachedType).toBe("rate_limit_reached");
  });

  it("binding_window_is_the_highest_used_percent", () => {
    expect(toRateLimitEvent(mergeRateLimits(EMPTY_RATE_LIMITS, FULL))).toEqual({
      type: "rate_limit",
      status: "allowed",
      resetsAt: RESET_LATE,
      rateLimitType: "seven_day",
      utilization: 0.7,
      windows: [
        {
          id: "five_hour",
          scope: null,
          period: "five_hour",
          utilization: 0.4,
          resetsAt: RESET_EARLY,
          exhausted: false,
        },
        {
          id: "seven_day",
          scope: null,
          period: "seven_day",
          utilization: 0.7,
          resetsAt: RESET_LATE,
          exhausted: false,
        },
      ],
    });
  });
});

const SPARK = snapshot({
  limitId: "spark",
  limitName: "Spark",
  primary: rateWindow(100, 300, RESET_EARLY),
  secondary: null,
});

function bindingOf(
  state: ReturnType<typeof replaceRateLimits>,
): Record<string, unknown> {
  const event = toRateLimitEvent(state);
  return {
    status: event?.status,
    resetsAt: event?.resetsAt,
    rateLimitType: event?.rateLimitType,
    utilization: event?.utilization,
  };
}

describe("codex extra rate limits", () => {
  it("extra_limits_become_scoped_windows", () => {
    const state = replaceRateLimits(FULL, true, { spark: SPARK });

    expect(toRateLimitEvent(state)?.windows).toEqual([
      expect.objectContaining({ id: "five_hour", scope: null }),
      expect.objectContaining({ id: "seven_day", scope: null }),
      {
        id: "spark:five_hour",
        scope: "Spark",
        period: "five_hour",
        utilization: 1,
        resetsAt: RESET_EARLY,
        exhausted: true,
      },
    ]);
  });

  it("main_limit_is_not_duplicated_from_by_limit_id", () => {
    const main = snapshot({ ...FULL, limitId: "codex" });

    const state = replaceRateLimits(main, true, { codex: main });

    expect(state.extra).toEqual([]);
    expect(toRateLimitEvent(state)?.windows).toHaveLength(2);
  });

  it("entries_without_windows_are_skipped", () => {
    const empty = snapshot({ limitId: "none", primary: null });

    expect(replaceRateLimits(FULL, true, { none: empty }).extra).toEqual([]);
  });

  it("null_by_limit_id_yields_main_windows_only", () => {
    expect(replaceRateLimits(FULL, true, null).extra).toEqual([]);
    expect(replaceRateLimits(FULL, true).extra).toEqual([]);
  });
});

describe("codex extra rate limits merging", () => {
  it("sparse_update_keeps_extra_limits", () => {
    const first = replaceRateLimits(FULL, true, { spark: SPARK });

    const merged = mergeRateLimits(
      first,
      snapshot({ primary: rateWindow(50, 300, RESET_LATE) }),
    );

    expect(toRateLimitEvent(merged)?.windows).toHaveLength(3);
  });

  it("unknown_window_duration_gets_a_stable_id", () => {
    const state = replaceRateLimits(
      snapshot({
        primary: rateWindow(10, null, null),
        secondary: rateWindow(20, null, null),
      }),
      true,
      { odd: snapshot({ limitId: "odd", primary: rateWindow(5, null, null) }) },
    );

    expect(toRateLimitEvent(state)?.windows).toEqual([
      expect.objectContaining({ id: "primary", period: null }),
      expect.objectContaining({ id: "secondary", period: null }),
      expect.objectContaining({ id: "odd:primary", scope: "odd" }),
    ]);
  });

  it.each([
    ["allowed", FULL, true],
    ["exhausted", FULL, false],
    [
      "near_full",
      snapshot({ primary: rateWindow(100, 300, RESET_EARLY) }),
      true,
    ],
  ])("rotation_fields_ignore_extra_limits_%s", (_name, main, allowed) => {
    const without = replaceRateLimits(main, allowed);
    const withExtra = replaceRateLimits(main, allowed, {
      spark: SPARK,
      other: snapshot({
        limitId: "other",
        primary: rateWindow(99, 10_080, RESET_LATE),
      }),
    });

    expect(bindingOf(withExtra)).toEqual(bindingOf(without));
  });
});

describe("codex rate limit event", () => {
  it("exhausted_prefers_full_window_with_latest_reset", () => {
    const state = mergeRateLimits(
      EMPTY_RATE_LIMITS,
      snapshot({
        primary: rateWindow(100, 300, RESET_EARLY),
        secondary: rateWindow(100, 10_080, RESET_LATE),
        rateLimitReachedType: "rate_limit_reached",
      }),
    );

    expect(toRateLimitEvent(state)).toEqual({
      type: "rate_limit",
      status: "rejected",
      resetsAt: RESET_LATE,
      rateLimitType: "seven_day",
      utilization: 1,
      windows: [
        {
          id: "five_hour",
          scope: null,
          period: "five_hour",
          utilization: 1,
          resetsAt: RESET_EARLY,
          exhausted: true,
        },
        {
          id: "seven_day",
          scope: null,
          period: "seven_day",
          utilization: 1,
          resetsAt: RESET_LATE,
          exhausted: true,
        },
      ],
    });
  });

  it("ordinary_usage_not_allowed_means_rejected", () => {
    const state = mergeRateLimits(EMPTY_RATE_LIMITS, FULL, false);

    expect(toRateLimitEvent(state)?.status).toBe("rejected");
  });

  it.each([
    [300, "five_hour"],
    [10_080, "seven_day"],
    [45, "window_45m"],
  ])("window_of_%d_minutes_is_%s", (minutes, expected) => {
    const state = mergeRateLimits(
      EMPTY_RATE_LIMITS,
      snapshot({ primary: rateWindow(5, minutes, null) }),
    );

    expect(toRateLimitEvent(state)).toMatchObject({
      rateLimitType: expected,
      resetsAt: null,
    });
  });

  it("empty_state_yields_no_event_unless_forced", () => {
    expect(toRateLimitEvent(EMPTY_RATE_LIMITS)).toBeNull();
    expect(toRateLimitEvent(EMPTY_RATE_LIMITS, true)).toEqual({
      type: "rate_limit",
      status: "rejected",
      resetsAt: null,
      rateLimitType: null,
      utilization: null,
      windows: [],
    });
  });
});

describe("codex error mapping", () => {
  it.each([
    ["usageLimitExceeded", "rate_limit"],
    ["unauthorized", "auth_required"],
    ["rateLimitExceeded", null],
    ["serverOverloaded", null],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, "auth_required"],
    [{ httpConnectionFailed: { httpStatusCode: 500 } }, null],
    [{ httpConnectionFailed: { httpStatusCode: null } }, null],
    [{ somethingNew: { x: 1 } }, null],
    [null, null],
  ])("error_info_%j_maps_to_%s", (info, expected) => {
    expect(errorKindOf(info)).toBe(expected);
  });

  it("turn_error_keeps_message_and_has_no_rpc_code", () => {
    expect(
      mapTurnError({ message: "limit", codexErrorInfo: "usageLimitExceeded" }),
    ).toEqual({
      type: "turn_error",
      errorKind: "rate_limit",
      rpcCode: null,
      message: "limit",
    });
  });
});

describe("codex profile and permission mapping", () => {
  it.each([
    [PermissionProfile.bypass, "never", "danger-full-access"],
    [PermissionProfile.unattended, "untrusted", "workspace-write"],
    [PermissionProfile.acceptEdits, "untrusted", "workspace-write"],
    [PermissionProfile.ask, "untrusted", "workspace-write"],
    [PermissionProfile.plan, "untrusted", "read-only"],
  ])("profile_%s_maps_to_%s_and_%s", (profile, approvalPolicy, sandbox) => {
    expect(policyFor(profile)).toEqual({ approvalPolicy, sandbox });
  });

  it("sandbox_policy_objects_follow_the_wire_contract", () => {
    expect(sandboxPolicyFor("danger-full-access")).toEqual({
      type: "dangerFullAccess",
    });
    expect(sandboxPolicyFor("workspace-write")).toEqual({
      type: "workspaceWrite",
    });
    expect(sandboxPolicyFor("read-only")).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
  });

  it("command_permission_without_command_has_default_title_and_no_raw_input", () => {
    const event = commandPermission("r1", { itemId: "c1" });

    expect(event).toMatchObject({
      toolCallId: "c1",
      title: "Run command",
      kind: "execute",
    });
    expect(event).not.toHaveProperty("rawInput");
  });

  it("command_permission_carries_the_cwd_next_to_the_command", () => {
    const event = commandPermission("r1", {
      itemId: "c1",
      command: "touch x",
      cwd: "/elsewhere",
    });

    expect(event).toMatchObject({
      rawInput: { command: "touch x", cwd: "/elsewhere" },
    });
  });

  it("command_permission_without_a_cwd_keeps_only_the_command", () => {
    for (const cwd of [undefined, null]) {
      const event = commandPermission("r1", {
        itemId: "c1",
        command: "touch x",
        cwd,
      });

      expect(event).toMatchObject({ rawInput: { command: "touch x" } });
      expect(Reflect.get(event, "rawInput")).not.toHaveProperty("cwd");
    }
  });

  it("permissions_request_offers_grant_and_deny", () => {
    const event = permissionsPermission("r2", {
      itemId: "p1",
      permissions: { network: { enabled: true } },
    });

    expect(event.kind).toBe("other");
    expect(event.options).toEqual([
      { optionId: "grant", name: "Grant", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
  });
});
