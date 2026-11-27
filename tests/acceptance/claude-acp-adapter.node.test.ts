import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InvalidOptionError,
  TurnInProgressError,
  UnknownPermissionError,
} from "../../src/backend/agentAdapter";
import { ImageMimeType } from "../../src/domain/attachments";
import type { StopResult } from "../../src/backend/process/container";
import { createRateLimitDetector } from "../../src/domain/rateLimit";
import { PermissionProfile } from "../../src/domain/types";
import {
  AUTH_REQUIRED_CODE,
  DEFAULT_PERMISSION_OPTIONS,
  RIG_ADAPTER_ENTRY,
  RIG_EXEC_PATH,
  RIG_GRACE_MS,
  agentOf,
  containedOf,
  createRig,
  permissionRequestOf,
  removeRigDirs,
  startHandle,
} from "../fakes/fakeAcpAgent";

const FAILED_STOP: StopResult = {
  ok: false,
  reason: "not_empty_after_timeout",
  survivors: [777],
};

const RATE_LIMIT_META = {
  "_claude/rateLimit": {
    status: "rejected",
    resetsAt: 1_700_003_600,
    rateLimitType: "five_hour",
    utilization: 1,
  },
};

afterEach(removeRigDirs);

describe("acp adapter: streaming", () => {
  it("acp_streams_text_and_tool_cards", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "text", text: "Hello" },
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "Run ls",
        kind: "execute",
        rawInput: { command: "ls" },
      },
      {
        type: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        text: "a.txt",
      },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("list files", { model: null });

    expect(events).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "Run ls",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      },
      {
        type: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        output: "a.txt",
      },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(agentOf(rig).prompts).toEqual(["list files"]);
  });

  it("adapter_forwards_tool_call_update_command", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "tool_call",
        toolCallId: "t9",
        title: "Terminal",
        kind: "execute",
        rawInput: {},
      },
      {
        type: "tool_call_update",
        toolCallId: "t9",
        status: "in_progress",
        title: "echo deploy | tee -a x",
        rawInput: { command: "echo deploy | tee -a x", description: "Deploy" },
      },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("deploy it", { model: null });

    expect(events[1]).toEqual({
      type: "tool_call_update",
      toolCallId: "t9",
      status: "in_progress",
      title: "echo deploy | tee -a x",
      rawInput: { command: "echo deploy | tee -a x", description: "Deploy" },
    });
  });
});

describe("acp adapter: permission answer", () => {
  it("acp_permission_answer_sends_exact_option_id", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t2",
        title: "Edit a.ts",
        kind: "edit",
        rawInput: { path: "/w/a.ts" },
        paths: ["/w/a.ts"],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
      { type: "end", stopReason: "end_turn" },
    ]);

    const turn = handle.prompt("edit it", { model: null });
    const request = await permissionRequestOf(events);

    expect(request).toEqual({
      type: "permission_request",
      requestId: expect.any(String) as string,
      toolCallId: "t2",
      title: "Edit a.ts",
      kind: "edit",
      rawInput: { path: "/w/a.ts" },
      locations: ["/w/a.ts"],
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "allow-always",
          name: "Always allow",
          kind: "allow_always",
        },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });

    handle.answerPermission(request.requestId, "allow-always");
    await turn;

    expect(agentOf(rig).permissionOutcomes).toEqual([
      { outcome: "selected", optionId: "allow-always" },
    ]);
  });
});

describe("acp adapter: permission validation", () => {
  it("acp_permission_rejects_unknown_option", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t3",
        title: "Run rm",
        kind: "execute",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
    ]);

    const turn = handle.prompt("remove it", { model: null });
    const request = await permissionRequestOf(events);

    expect(() => {
      handle.answerPermission(request.requestId, "allow-forever");
    }).toThrow(InvalidOptionError);
    expect(() => {
      handle.answerPermission("no-such-request", "allow-once");
    }).toThrow(UnknownPermissionError);

    await handle.stop(RIG_GRACE_MS);
    await turn;

    expect(agentOf(rig).permissionOutcomes).toEqual([{ outcome: "cancelled" }]);
  });
});

describe("acp adapter: cancelled turn", () => {
  it("permission_request_expires_when_turn_cancelled", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t6",
        title: "Run make",
        kind: "execute",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
    ]);

    const turn = handle.prompt("build", { model: null });
    const request = await permissionRequestOf(events);
    await handle.cancel();
    await turn;

    expect(events.filter((event) => event.type === "turn_end")).toEqual([
      { type: "turn_end", stopReason: "cancelled" },
    ]);
    expect(() => {
      handle.answerPermission(request.requestId, "allow-once");
    }).toThrow(UnknownPermissionError);
    await vi.waitFor(() => {
      expect(agentOf(rig).permissionOutcomes).toEqual([
        { outcome: "cancelled" },
      ]);
    });
  });
});

describe("acp adapter: overlapping prompts", () => {
  it("overlapping_prompt_rejected_while_turn_running", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t7",
        title: "Run make",
        kind: "execute",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
    ]);

    const turn = handle.prompt("first", { model: null });
    const request = await permissionRequestOf(events);

    await expect(handle.prompt("second", { model: null })).rejects.toThrow(
      TurnInProgressError,
    );
    handle.answerPermission(request.requestId, "allow-once");
    await turn;

    expect(agentOf(rig).prompts).toEqual(["first"]);
    await vi.waitFor(() => {
      expect(agentOf(rig).permissionOutcomes).toEqual([
        { outcome: "selected", optionId: "allow-once" },
      ]);
    });
  });
});

describe("acp adapter: prompt from terminal event", () => {
  it("prompt_from_turn_end_listener_starts_next_turn", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([{ type: "end", stopReason: "end_turn" }]);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t8",
        title: "Run make",
        kind: "execute",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
    ]);
    const chained: Promise<void>[] = [];
    handle.subscribe((event) => {
      if (event.type === "turn_end" && chained.length === 0) {
        chained.push(handle.prompt("next", { model: null }));
      }
    });

    await handle.prompt("first", { model: null });
    const request = await permissionRequestOf(events);

    await expect(handle.prompt("third", { model: null })).rejects.toThrow(
      TurnInProgressError,
    );
    handle.answerPermission(request.requestId, "allow-once");
    await Promise.all(chained);

    expect(agentOf(rig).prompts).toEqual(["first", "next"]);
  });
});

describe("acp adapter: profile", () => {
  it("acp_bypass_sets_mode_ask_does_not", async () => {
    const bypassRig = await createRig();
    await startHandle(bypassRig, PermissionProfile.bypass);
    const askRig = await createRig();
    const { handle } = await startHandle(askRig, PermissionProfile.ask);

    expect(agentOf(bypassRig).modeCalls).toEqual(["bypassPermissions"]);
    expect(agentOf(askRig).modeCalls).toEqual([]);

    await handle.setProfile(PermissionProfile.ask);
    await handle.setProfile(PermissionProfile.bypass);

    expect(agentOf(askRig).modeCalls).toEqual(["default", "bypassPermissions"]);
  });
});

describe("acp adapter: rate limits", () => {
  it("acp_rate_limit_prompt_error_maps_to_turn_error", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "fail",
        code: -32603,
        message: "Rate limit reached",
        data: { errorKind: "rate_limit" },
      },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: -32603,
        message: expect.stringContaining("Rate limit reached") as string,
      },
    ]);
  });

  it("acp_usage_update_maps_rate_limit", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "usage_update", meta: RATE_LIMIT_META },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      {
        type: "rate_limit",
        status: "rejected",
        resetsAt: 1_700_003_600,
        rateLimitType: "five_hour",
        utilization: 1,
      },
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 100 } },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("acp adapter: authentication", () => {
  it("acp_auth_error_on_initialize_returns_needs_login_and_releases_lock", async () => {
    const rig = await createRig();
    rig.container.config.initializeError = {
      code: AUTH_REQUIRED_CODE,
      message: "Authentication required",
    };

    const result = await rig.start();

    expect(result).toEqual({
      ok: false,
      reason: "needs_login",
      message: "Authentication required",
    });
    expect(containedOf(rig).stopCalls).toEqual([RIG_GRACE_MS]);

    delete rig.container.config.initializeError;
    const retry = await rig.start(PermissionProfile.ask, "run-2");

    expect(retry.ok).toBe(true);
  });

  it("acp_auth_error_on_new_session_returns_needs_login", async () => {
    const rig = await createRig();
    rig.container.config.newSessionError = {
      code: AUTH_REQUIRED_CODE,
      message: "Authentication required",
    };

    const result = await rig.start();

    expect(result).toEqual({
      ok: false,
      reason: "needs_login",
      message: "Authentication required",
    });
    expect(containedOf(rig).stopCalls).toEqual([RIG_GRACE_MS]);
  });
});

describe("acp adapter: stop", () => {
  it("acp_stop_during_permission_sends_cancelled_and_emits_exit_once", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      {
        type: "permission",
        toolCallId: "t4",
        title: "Run make",
        kind: "execute",
        paths: [],
        options: DEFAULT_PERMISSION_OPTIONS,
      },
      { type: "end", stopReason: "cancelled" },
    ]);

    const turn = handle.prompt("build", { model: null });
    await permissionRequestOf(events);
    const stopped = await handle.stop(RIG_GRACE_MS);
    containedOf(rig).emitExit(0);
    await turn;

    expect(stopped).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(agentOf(rig).permissionOutcomes).toEqual([
        { outcome: "cancelled" },
      ]);
      expect(agentOf(rig).cancelCalls).toBe(1);
    });
    expect(events.filter((event) => event.type === "process_exit")).toEqual([
      { type: "process_exit" },
    ]);
  });

  it("acp_stop_passes_through_failed_stop_result", async () => {
    const rig = await createRig([FAILED_STOP]);
    const { handle } = await startHandle(rig);

    const stopped = await handle.stop(RIG_GRACE_MS);

    expect(stopped).toEqual(FAILED_STOP);
  });
});

const SETTLE_TIMEOUT_MS = 1000;
const METHOD_NOT_FOUND_CODE = -32601;

describe("acp adapter: unexpected peer messages", () => {
  it("acp_ext_notification_is_ignored", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "ext_notification", method: "_claude/test" },
      { type: "text", text: "after ext" },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      { type: "text", text: "after ext" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("acp_unknown_session_update_does_not_break_stream", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "unknown_update" },
      { type: "text", text: "after unknown" },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      { type: "text", text: "after unknown" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("acp_unhandled_client_request_gets_method_not_found", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "client_request", method: "fs/read_text_file" },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(agentOf(rig).clientRequestErrorCodes).toEqual([
      METHOD_NOT_FOUND_CODE,
    ]);
    expect(events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });
});

describe("acp adapter: after process exit", () => {
  it("set_profile_after_exit_does_not_hang", async () => {
    const rig = await createRig();
    const { handle } = await startHandle(rig);
    containedOf(rig).emitExit(1);
    containedOf(rig).stdout.end();

    const outcome = await Promise.race([
      Promise.allSettled([handle.setProfile(PermissionProfile.bypass)]).then(
        () => "settled",
      ),
      new Promise<string>((resolve) =>
        setTimeout(resolve, SETTLE_TIMEOUT_MS, "hung"),
      ),
    ]);

    expect(outcome).toBe("settled");
  });
});

describe("acp adapter: usage and ordering", () => {
  it("acp_usage_update_without_meta_emits_only_context_usage", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "usage_update" },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 100 } },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("acp_turn_end_follows_all_session_updates", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      {
        type: "tool_call",
        toolCallId: "t10",
        title: "Run ls",
        kind: "execute",
        rawInput: { command: "ls" },
      },
      { type: "text", text: "three" },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events.map((event) => event.type)).toEqual([
      "text",
      "text",
      "tool_call",
      "text",
      "turn_end",
    ]);
  });
});

describe("acp adapter: launch environment", () => {
  it("acp_spawn_env_has_launcher_flags", async () => {
    const rig = await createRig();
    await startHandle(rig);

    const spec = rig.container.specs[0];

    expect(spec?.command).toBe(RIG_EXEC_PATH);
    expect(spec?.args.at(-1)).toBe(RIG_ADAPTER_ENTRY);
    expect(spec?.cwd).toBe(rig.cwd);
    expect(spec?.runId).toBe("run-1");
    expect(spec?.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(spec?.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(spec?.env.CLAUDE_CODE_EXECUTABLE).toBe("/usr/bin/claude");
  });
});

describe("acp adapter: model selection", () => {
  it("model reaches claude-agent-acp via set_config_option", async () => {
    const rig = await createRig();
    const { handle } = await startHandle(rig);

    await handle.prompt("go", { model: "claude-sonnet-4-5" });

    expect(agentOf(rig).configCalls).toEqual([
      { configId: "model", value: "claude-sonnet-4-5" },
    ]);
    expect(agentOf(rig).callOrder).toEqual(["set_config_option", "prompt"]);
  });

  it("unchanged model is not set again", async () => {
    const rig = await createRig();
    const { handle } = await startHandle(rig);

    await handle.prompt("one", { model: "claude-sonnet-4-5" });
    await handle.prompt("two", { model: "claude-sonnet-4-5" });
    await handle.prompt("three", { model: "claude-opus-4-1" });

    expect(agentOf(rig).configCalls).toEqual([
      { configId: "model", value: "claude-sonnet-4-5" },
      { configId: "model", value: "claude-opus-4-1" },
    ]);
    expect(agentOf(rig).callOrder).toEqual([
      "set_config_option",
      "prompt",
      "prompt",
      "set_config_option",
      "prompt",
    ]);
  });

  it("model equal to the session model is not set", async () => {
    const rig = await createRig();
    rig.container.config.sessionModel = "claude-sonnet-4-5";
    const { handle } = await startHandle(rig);

    await handle.prompt("go", { model: "claude-sonnet-4-5" });

    expect(agentOf(rig).configCalls).toEqual([]);
  });

  it("null model leaves the session model alone", async () => {
    const rig = await createRig();
    const { handle } = await startHandle(rig);

    await handle.prompt("go", { model: null });

    expect(agentOf(rig).configCalls).toEqual([]);
    expect(agentOf(rig).prompts).toEqual(["go"]);
  });
});

describe("acp adapter: model reporting", () => {
  it("adapter reports the session model", async () => {
    const rig = await createRig();
    rig.container.config.sessionModel = "claude-sonnet-4-5";
    const { handle, events } = await startHandle(rig);

    await handle.prompt("one", { model: null });
    await handle.prompt("two", { model: "claude-opus-4-1" });

    expect(events).toEqual([
      { type: "model", model: "claude-sonnet-4-5" },
      { type: "model", model: "claude-sonnet-4-5" },
      { type: "turn_end", stopReason: "end_turn" },
      { type: "model", model: "claude-opus-4-1" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("claude reports the model on every turn", async () => {
    const rig = await createRig();
    rig.container.config.sessionModel = "claude-sonnet-4-5";
    const { handle, events } = await startHandle(rig);

    await handle.prompt("one", { model: null });
    await handle.prompt("two", { model: null });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "claude-sonnet-4-5" },
      { type: "model", model: "claude-sonnet-4-5" },
      { type: "model", model: "claude-sonnet-4-5" },
    ]);
  });

  it("served_model_from_usage_meta_sets_turn_and_session_model", async () => {
    const rig = await createRig();
    rig.container.config.sessionModel = "default";
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "usage_update", meta: { "_claude/model": "claude-opus-5-5" } },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      { type: "model", model: "claude-opus-5-5" },
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 100 } },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("default_alias_resolves_to_option_description", async () => {
    const rig = await createRig();
    rig.container.config.sessionModel = "default";
    rig.container.config.defaultModelDescription = "Opus 5.5";

    const { events } = await startHandle(rig);

    expect(events).toEqual([{ type: "model", model: "Opus 5.5" }]);
  });

  it("usage_update_without_model_meta_is_ignored", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue([
      { type: "usage_update" },
      { type: "usage_update", meta: { "_claude/model": 7 } },
      { type: "usage_update", meta: { "_claude/model": "" } },
      { type: "end", stopReason: "end_turn" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 100 } },
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 100 } },
      { type: "context_usage", usage: { usedTokens: 1, limitTokens: 100 } },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("rejected model fails the turn without a rate limit", async () => {
    const rig = await createRig();
    rig.container.config.setConfigOptionError = {
      code: -32602,
      message: "Unknown model: nonsense",
    };
    const { handle, events } = await startHandle(rig);
    const detector = createRateLimitDetector(() => 0);
    handle.subscribe((event) => {
      detector.observe(event);
    });

    await handle.prompt("go", { model: "nonsense" });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: -32602,
        message: expect.stringContaining("Unknown model: nonsense") as string,
      },
    ]);
    expect(agentOf(rig).prompts).toEqual([]);
    expect(detector.settle()).toEqual({
      kind: "failed",
      message: expect.stringContaining("Unknown model: nonsense") as string,
    });
  });

  const HOOK_EDIT_STEPS = [
    {
      type: "tool_call" as const,
      toolCallId: "t-edit",
      title: "Edit /w/a.ts",
      kind: "edit" as const,
      content: [
        {
          type: "diff" as const,
          path: "/w/a.ts",
          oldText: null,
          newText: "full",
        },
      ],
    },
    {
      type: "tool_call_update" as const,
      toolCallId: "t-edit",
      status: "completed" as const,
      content: [
        {
          type: "diff" as const,
          path: "/w/a.ts",
          oldText: "old\n",
          newText: "new\n",
        },
      ],
      locations: [{ path: "/w/a.ts", line: 120 }],
    },
    {
      type: "tool_call" as const,
      toolCallId: "t-large",
      title: "Write /w/big.ts",
      kind: "edit" as const,
      content: [
        {
          type: "diff" as const,
          path: "/w/big.ts",
          oldText: null,
          newText: "big",
        },
      ],
    },
    {
      type: "tool_call_update" as const,
      toolCallId: "t-large",
      status: "completed" as const,
      content: [
        {
          type: "content" as const,
          content: {
            type: "text" as const,
            text: "Updated `/w/big.ts` (previous content too large to diff)",
          },
        },
      ],
      locations: [{ path: "/w/big.ts" }],
    },
    { type: "end" as const, stopReason: "end_turn" as const },
  ];

  it("acp_adapter_hook_hunks_and_write_fallback", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue(HOOK_EDIT_STEPS);

    await handle.prompt("edit files", { model: null });

    expect(events).toContainEqual({
      type: "tool_call_update",
      toolCallId: "t-edit",
      status: "completed",
      diffs: [
        {
          path: "/w/a.ts",
          change: "modified",
          patch: "@@ -120,1 +120,1 @@\n-old\n+new",
        },
      ],
    });
    expect(events).toContainEqual({
      type: "tool_call_update",
      toolCallId: "t-large",
      status: "completed",
      output: "Updated `/w/big.ts` (previous content too large to diff)",
      diffs: [{ path: "/w/big.ts", change: "modified", omitted: "too_large" }],
    });
  });

  const SPLIT_HOOK_BEFORE = [
    "L1",
    "u1",
    "u2",
    "u3",
    "u4",
    "u5",
    "u6",
    "u7",
    "u8",
    "old",
    "",
  ].join("\n");
  const SPLIT_HOOK_AFTER = [
    "L1",
    "ins",
    "u1",
    "u2",
    "u3",
    "u4",
    "u5",
    "u6",
    "u7",
    "u8",
    "new",
    "",
  ].join("\n");
  const SPLIT_HOOK_STEPS = [
    {
      type: "tool_call" as const,
      toolCallId: "t-split",
      title: "Edit /w/split.ts",
      kind: "edit" as const,
      content: [
        {
          type: "diff" as const,
          path: "/w/split.ts",
          oldText: SPLIT_HOOK_BEFORE,
          newText: SPLIT_HOOK_AFTER,
        },
      ],
    },
    {
      type: "tool_call_update" as const,
      toolCallId: "t-split",
      status: "completed" as const,
      content: [
        {
          type: "diff" as const,
          path: "/w/split.ts",
          oldText: SPLIT_HOOK_BEFORE,
          newText: SPLIT_HOOK_AFTER,
        },
      ],
      locations: [{ path: "/w/split.ts", line: 50 }],
    },
    { type: "end" as const, stopReason: "end_turn" as const },
  ];

  it("acp_adapter_split_hook_hunk_keeps_old_start", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue(SPLIT_HOOK_STEPS);

    await handle.prompt("split hunk", { model: null });

    expect(events).toContainEqual({
      type: "tool_call_update",
      toolCallId: "t-split",
      status: "completed",
      diffs: [
        {
          path: "/w/split.ts",
          change: "modified",
          patch: [
            "@@ -50,4 +50,5 @@",
            " L1",
            "+ins",
            " u1",
            " u2",
            " u3",
            "@@ -56,4 +57,4 @@",
            " u6",
            " u7",
            " u8",
            "-old",
            "+new",
          ].join("\n"),
        },
      ],
    });
  });

  const HELD_LOCATIONS_STEPS = [
    {
      type: "tool_call" as const,
      toolCallId: "t-held-large",
      title: "Write /w/big.ts",
      kind: "edit" as const,
      content: [
        {
          type: "diff" as const,
          path: "/w/big.ts",
          oldText: null,
          newText: "big",
        },
      ],
      locations: [{ path: "/w/big.ts" }],
    },
    {
      type: "tool_call_update" as const,
      toolCallId: "t-held-large",
      status: "completed" as const,
      content: [
        {
          type: "content" as const,
          content: {
            type: "text" as const,
            text: "Updated `/w/big.ts` (previous content too large to diff)",
          },
        },
      ],
    },
    { type: "end" as const, stopReason: "end_turn" as const },
  ];

  it("acp_adapter_too_large_write_without_repeated_locations", async () => {
    const rig = await createRig();
    const { handle, events } = await startHandle(rig);
    agentOf(rig).enqueue(HELD_LOCATIONS_STEPS);

    await handle.prompt("write big file", { model: null });

    expect(events).toContainEqual({
      type: "tool_call_update",
      toolCallId: "t-held-large",
      status: "completed",
      output: "Updated `/w/big.ts` (previous content too large to diff)",
      diffs: [{ path: "/w/big.ts", change: "modified", omitted: "too_large" }],
    });
  });
});

describe("acp adapter: images", () => {
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("acp_prompt_carries_image_blocks", async () => {
    const rig = await createRig();
    rig.container.config.imageInput = true;
    const { handle } = await startHandle(rig);
    const path = join(rig.cwd, "photo.png");
    await writeFile(path, Buffer.from(PNG_BASE64, "base64"));
    agentOf(rig).enqueue([{ type: "end", stopReason: "end_turn" }]);

    await handle.prompt("look", {
      model: null,
      images: [{ path, mimeType: ImageMimeType.png, name: "photo.png" }],
    });

    expect(agentOf(rig).prompts).toEqual(["look"]);
    expect(agentOf(rig).promptImages).toEqual([
      { data: PNG_BASE64, mimeType: ImageMimeType.png },
    ]);
  });

  it("acp_rejects_images_without_agent_image_input", async () => {
    const rig = await createRig();
    const { handle } = await startHandle(rig);
    const path = join(rig.cwd, "photo.png");
    await writeFile(path, Buffer.from(PNG_BASE64, "base64"));

    await expect(
      handle.prompt("look", {
        model: null,
        images: [{ path, mimeType: ImageMimeType.png, name: "photo.png" }],
      }),
    ).rejects.toThrow("This Claude agent does not accept images");
  });
});
