import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InvalidOptionError,
  TurnInProgressError,
  UnknownPermissionError,
} from "../agentAdapter";
import type { AgentEvent } from "../../domain/events";
import { createRateLimitDetector } from "../../domain/rateLimit";
import { PermissionProfile } from "../../domain/types";
import {
  CODEX_RIG_GRACE_MS,
  agentDelta,
  codexContainedOf,
  codexPermissionRequestOf,
  commandApproval,
  createCodexRig,
  fileChangeItem,
  itemStarted,
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  removeCodexRigDirs,
  serverOf,
  startCodexHandle,
  type CodexRig,
  type Json,
} from "../../../tests/fakes/fakeCodexAppServer";

const NOW_MS = 1_700_000_000_000;
const COOLDOWN_RESET_AT = 1_700_003_600;
const RESET_AT = 1_700_001_000;
const RPC_INVALID_REQUEST = -32600;
const RPC_INTERNAL = -32603;
const UNKNOWN_REQUEST_METHOD = "item/tool/requestUserInput";
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const HIGH_PERCENT = 95;
const MID_PERCENT = 30;
const LOW_PERCENT = 20;
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;
const LATE_READ_DELAY_MS = 450;
const OVERLAP_STALE_DELAY_MS = 400;
const OVERLAP_FRESH_DELAY_MS = 250;

afterEach(async () => {
  vi.restoreAllMocks();
  await removeCodexRigDirs();
});

function permissionRequests(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "permission_request" }>[] {
  return events.filter((event) => event.type === "permission_request");
}

function settleOutcome(events: readonly AgentEvent[]): unknown {
  const detector = createRateLimitDetector(() => NOW_MS);
  for (const event of events) {
    detector.observe(event);
  }
  return detector.settle();
}

function pushUpdate(rig: CodexRig, rateLimits: Json): void {
  const line = JSON.stringify({
    method: "account/rateLimits/updated",
    params: { rateLimits },
  });
  codexContainedOf(rig).stdout.write(`${line}\n`);
}

describe("codex adapter rate limit reads", () => {
  it("rate_limits_read_failure_keeps_session", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      { kind: "error", code: RPC_INVALID_REQUEST, message: "auth required" },
      { kind: "error", code: RPC_INTERNAL, message: "backend down" },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      { type: "fail", codexErrorInfo: "usageLimitExceeded", message: "limit" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: "limit",
      },
    ]);
    expect(settleOutcome(events)).toEqual({
      kind: "exhausted",
      resetsAt: COOLDOWN_RESET_AT,
      rateLimitType: null,
    });
  });

  it("post_failure_read_that_never_answers_times_out_without_rate_limit_event", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      { kind: "ok", response: rateLimitsResponse(rateSnapshot(null, null)) },
      { kind: "hang" },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      { type: "fail", codexErrorInfo: "usageLimitExceeded", message: "limit" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events.map((event) => event.type)).toEqual(["turn_error"]);
  });

  it("forced_rejection_without_known_windows_has_no_reset", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      { kind: "ok", response: rateLimitsResponse(rateSnapshot(null, null)) },
    ];
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      { type: "fail", codexErrorInfo: "usageLimitExceeded", message: "limit" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events[0]).toEqual({
      type: "rate_limit",
      status: "rejected",
      resetsAt: null,
      rateLimitType: null,
      utilization: null,
      windows: [],
    });
  });
});

describe("codex adapter rate limit updates", () => {
  it("update_between_turns_is_emitted_and_merged_sparsely", async () => {
    const rig = await createCodexRig();
    const { events } = await startCodexHandle(rig);

    pushUpdate(
      rig,
      rateSnapshot(
        rateWindow(HIGH_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
        rateWindow(LOW_PERCENT, SEVEN_DAY_MINUTES, null),
      ),
    );
    pushUpdate(
      rig,
      rateSnapshot(null, rateWindow(MID_PERCENT, SEVEN_DAY_MINUTES, null)),
    );

    await vi.waitFor(() => {
      expect(events).toHaveLength(2);
    });
    const expected = {
      type: "rate_limit",
      status: "allowed",
      resetsAt: RESET_AT,
      rateLimitType: "five_hour",
      utilization: 0.95,
    };
    const fiveHour = {
      id: "five_hour",
      scope: null,
      period: "five_hour",
      utilization: 0.95,
      resetsAt: RESET_AT,
      exhausted: false,
    };
    const weekly = {
      id: "seven_day",
      scope: null,
      period: "seven_day",
      resetsAt: null,
      exhausted: false,
    };
    expect(events).toEqual([
      { ...expected, windows: [fiveHour, { ...weekly, utilization: 0.2 }] },
      { ...expected, windows: [fiveHour, { ...weekly, utilization: 0.3 }] },
    ]);
  });

  it("initial_snapshot_is_announced_once_at_first_prompt", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);

    await handle.prompt("one", { model: null });
    await handle.prompt("two", { model: null });

    expect(events.map((event) => event.type)).toEqual([
      "rate_limit",
      "turn_end",
      "turn_end",
    ]);
  });
});

describe("codex adapter stop handling", () => {
  it("approval_after_stop_is_declined", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    const server = serverOf(rig);
    server.enqueue([commandApproval("c1", "make"), { type: "hang" }]);
    const turn = handle.prompt("build", { model: null });
    await codexPermissionRequestOf(events);
    codexContainedOf(rig).holdStops();

    const stopped = handle.stop(CODEX_RIG_GRACE_MS);
    await vi.waitFor(() => {
      expect(server.answers).toHaveLength(1);
    });
    await server.askServerRequest(COMMAND_APPROVAL_METHOD, {
      itemId: "c2",
      command: "rm -rf /",
    });
    await vi.waitFor(() => {
      expect(codexContainedOf(rig).stopCalls).toHaveLength(1);
    });
    codexContainedOf(rig).resolveHeldStops();
    await stopped;
    await turn;

    expect(server.answers.map((answer) => answer.result)).toEqual([
      { decision: "decline" },
      { decision: "decline" },
    ]);
    expect(permissionRequests(events)).toHaveLength(1);
  });

  it("approval_after_exit_is_dropped_without_throwing", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    const server = serverOf(rig);
    server.enqueue([commandApproval("c1", "make"), { type: "hang" }]);
    const turn = handle.prompt("build", { model: null });
    const request = await codexPermissionRequestOf(events);

    codexContainedOf(rig).emitExit(1);
    await turn;

    expect(() => {
      handle.answerPermission(request.requestId, "accept");
    }).toThrow(UnknownPermissionError);
    expect(server.answers).toEqual([]);
  });
});

describe("codex adapter tolerance", () => {
  it("unknown_item_and_request_are_tolerated", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      itemStarted({ type: "reasoning", id: "r1", summary: [], content: [] }),
      {
        type: "approval",
        method: UNKNOWN_REQUEST_METHOD,
        params: { itemId: "u1" },
      },
      agentDelta("m1", "still here"),
      { type: "complete", status: "completed" },
    ]);

    await handle.prompt("hello", { model: null });

    expect(serverOf(rig).answers).toEqual([
      {
        id: 1000,
        method: UNKNOWN_REQUEST_METHOD,
        error: { code: -32601, message: "Method not found" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "rate_limit",
      "text",
      "turn_end",
    ]);
  });

  it("retry_error_notification_emits_api_retry_and_terminal_one_does_not", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    const error = { message: "stream error", codexErrorInfo: "other" };
    serverOf(rig).enqueue([
      { type: "notify", method: "error", params: { error, willRetry: true } },
      { type: "notify", method: "error", params: { error, willRetry: false } },
      { type: "complete", status: "completed" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events.map((event) => event.type)).toEqual([
      "rate_limit",
      "api_retry",
      "turn_end",
    ]);
  });
});

describe("codex adapter profiles", () => {
  it.each([
    [PermissionProfile.bypass, "never", "danger-full-access"],
    [PermissionProfile.plan, "untrusted", "read-only"],
    [PermissionProfile.acceptEdits, "untrusted", "workspace-write"],
  ])(
    "start_with_profile_%s_sends_%s_and_%s",
    async (profile, policy, sandbox) => {
      const rig = await createCodexRig();

      await rig.start(profile);

      expect(serverOf(rig).paramsOf("thread/start")).toEqual([
        {
          cwd: rig.cwd,
          approvalPolicy: policy,
          sandbox,
          approvalsReviewer: "user",
        },
      ]);
    },
  );

  it("set_profile_overrides_policy_on_next_turn_only_when_changed", async () => {
    const rig = await createCodexRig();
    const { handle } = await startCodexHandle(rig, PermissionProfile.ask);

    await handle.prompt("one", { model: null });
    await handle.setProfile(PermissionProfile.bypass);
    await handle.prompt("two", { model: null });

    expect(serverOf(rig).paramsOf("turn/start")).toEqual([
      { threadId: "thr-1", input: [{ type: "text", text: "one" }] },
      {
        threadId: "thr-1",
        input: [{ type: "text", text: "two" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    ]);
  });
});

describe("codex adapter turn lifecycle", () => {
  it("second_prompt_during_turn_is_rejected", async () => {
    const rig = await createCodexRig();
    const { handle } = await startCodexHandle(rig);
    serverOf(rig).enqueue([{ type: "await_interrupt" }]);

    const turn = handle.prompt("first", { model: null });
    await expect(
      handle.prompt("second", { model: null }),
    ).rejects.toBeInstanceOf(TurnInProgressError);
    await handle.cancel();
    await turn;
  });

  it("turn_start_rpc_error_ends_turn_with_rpc_code", async () => {
    const rig = await createCodexRig();
    rig.container.config.turnStartError = {
      code: RPC_INVALID_REQUEST,
      message: "thread not found",
    };
    const { handle, events } = await startCodexHandle(rig);

    await handle.prompt("go", { model: null });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: RPC_INVALID_REQUEST,
      message: "thread not found",
    });
  });

  it("start_failure_includes_stderr_tail_and_stops_process", async () => {
    const rig = await createCodexRig();
    rig.container.config.stderrText = "panic: bad config";
    rig.container.config.threadStartError = {
      code: RPC_INTERNAL,
      message: "cannot start thread",
    };

    const result = await rig.start(PermissionProfile.ask);

    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: "cannot start thread\npanic: bad config",
    });
    expect(codexContainedOf(rig).stopCalls).toEqual([CODEX_RIG_GRACE_MS]);
  });
});

describe("codex adapter approvals", () => {
  it("answer_permission_validates_request_and_option", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      commandApproval("c1", "make"),
      { type: "complete", status: "completed" },
    ]);

    const turn = handle.prompt("build", { model: null });
    const request = await codexPermissionRequestOf(events);

    expect(() => {
      handle.answerPermission("missing", "accept");
    }).toThrow(UnknownPermissionError);
    expect(() => {
      handle.answerPermission(request.requestId, "allow");
    }).toThrow(InvalidOptionError);
    handle.answerPermission(request.requestId, "acceptForSession");
    await turn;
    expect(serverOf(rig).answers[0]?.result).toEqual({
      decision: "acceptForSession",
    });
  });

  it("file_change_approval_uses_paths_from_started_item", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      itemStarted(fileChangeItem("f1", ["/w/a.ts"], "inProgress")),
      {
        type: "approval",
        method: "item/fileChange/requestApproval",
        params: { itemId: "f1" },
      },
      { type: "complete", status: "completed" },
    ]);

    const turn = handle.prompt("edit", { model: null });
    const request = await codexPermissionRequestOf(events);
    handle.answerPermission(request.requestId, "decline");
    await turn;

    expect(request).toMatchObject({
      toolCallId: "f1",
      title: "Edit files",
      kind: "edit",
      locations: ["/w/a.ts"],
    });
    expect(serverOf(rig).answers[0]?.result).toEqual({ decision: "decline" });
  });
});

describe("codex adapter permissions request", () => {
  it("permissions_request_grant_and_deny_replies", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    const requested = { network: { enabled: true } };
    const ask = (itemId: string): Json => ({ itemId, permissions: requested });
    const method = "item/permissions/requestApproval";
    serverOf(rig).enqueue([
      { type: "approval", method, params: ask("p1") },
      { type: "approval", method, params: ask("p2") },
      { type: "complete", status: "completed" },
    ]);

    const turn = handle.prompt("net", { model: null });
    const first = await codexPermissionRequestOf(events);
    handle.answerPermission(first.requestId, "grant");
    await vi.waitFor(() => {
      expect(permissionRequests(events)).toHaveLength(2);
    });
    handle.answerPermission(
      permissionRequests(events)[1]?.requestId ?? "",
      "deny",
    );
    await turn;

    expect(serverOf(rig).answers.map((answer) => answer.result)).toEqual([
      { permissions: requested, scope: "turn" },
      { permissions: {}, scope: "turn" },
    ]);
  });
});

describe("codex adapter review regressions", () => {
  it("initial_rate_limit_read_timeout_does_not_block_start", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [{ kind: "hang" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { handle, events } = await startCodexHandle(rig);
    await handle.prompt("go", { model: null });

    const warned = warn.mock.calls.map(([message]) => String(message));
    expect(warned.some((text) => text.includes("rate limit read failed"))).toBe(
      true,
    );
    expect(serverOf(rig).methods()).toContain("thread/start");
    expect(events.map((event) => event.type)).toEqual(["turn_end"]);
  });

  it("rpc_close_mid_turn_ends_turn", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([{ type: "hang" }]);

    const turn = handle.prompt("stall", { model: null });
    await vi.waitFor(() => {
      expect(serverOf(rig).methods()).toContain("turn/start");
    });
    codexContainedOf(rig).stdout.end();
    await turn;

    expect(events.map((event) => event.type)).toEqual([
      "rate_limit",
      "turn_error",
    ]);
    expect(codexContainedOf(rig).stopCalls).toEqual([]);
  });

  it("profile_switch_back_resends_start_policy", async () => {
    const rig = await createCodexRig();
    const { handle } = await startCodexHandle(rig, PermissionProfile.plan);

    await handle.setProfile(PermissionProfile.bypass);
    await handle.prompt("wide", { model: null });
    await handle.setProfile(PermissionProfile.plan);
    await handle.prompt("narrow", { model: null });

    expect(serverOf(rig).paramsOf("turn/start")).toEqual([
      {
        threadId: "thr-1",
        input: [{ type: "text", text: "wide" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      {
        threadId: "thr-1",
        input: [{ type: "text", text: "narrow" }],
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    ]);
  });
});

describe("codex adapter late read regressions", () => {
  it("late_rate_limit_read_does_not_overwrite_newer_update", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      { kind: "ok", response: rateLimitsResponse(rateSnapshot(null, null)) },
      {
        kind: "delayed",
        delayMs: LATE_READ_DELAY_MS,
        response: rateLimitsResponse(
          rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
        ),
      },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      { type: "fail", codexErrorInfo: "usageLimitExceeded", message: "limit" },
    ]);
    await handle.prompt("go", { model: null });

    pushUpdate(
      rig,
      rateSnapshot(
        rateWindow(HIGH_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
        null,
        "rate_limit_reached",
      ),
    );
    await Promise.all(serverOf(rig).delayedReplies);
    pushUpdate(rig, rateSnapshot(null, null));

    await vi.waitFor(() => {
      expect(events).toHaveLength(3);
    });
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ status: "rejected", resetsAt: RESET_AT }),
      expect.objectContaining({ status: "rejected", resetsAt: RESET_AT }),
    ]);
  });

  it("overlapping_rate_limit_reads_keep_newest_response", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      {
        kind: "delayed",
        delayMs: OVERLAP_STALE_DELAY_MS,
        response: rateLimitsResponse(
          rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
        ),
      },
      {
        kind: "delayed",
        delayMs: OVERLAP_FRESH_DELAY_MS,
        response: rateLimitsResponse(
          rateSnapshot(
            rateWindow(HIGH_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
            null,
            "rate_limit_reached",
          ),
          false,
        ),
      },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      { type: "fail", codexErrorInfo: "usageLimitExceeded", message: "limit" },
    ]);
    await handle.prompt("go", { model: null });
    await Promise.all(serverOf(rig).delayedReplies);

    expect(events.filter((event) => event.type === "rate_limit")).toEqual([
      expect.objectContaining({ status: "rejected", resetsAt: RESET_AT }),
    ]);
  });
});

describe("codex adapter cancel regressions", () => {
  it("cancel_on_silent_server_times_out_and_stop_kills", async () => {
    const rig = await createCodexRig();
    rig.container.config.turnStartHang = true;
    const { handle } = await startCodexHandle(rig);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const turn = handle.prompt("silent", { model: null });
    await vi.waitFor(() => {
      expect(serverOf(rig).methods()).toContain("turn/start");
    });

    await handle.cancel();
    await handle.stop(CODEX_RIG_GRACE_MS);
    await turn;

    expect(warn).toHaveBeenCalled();
    expect(codexContainedOf(rig).stopCalls).toEqual([CODEX_RIG_GRACE_MS]);
  });
});

function pushTokenUsage(rig: CodexRig, params: Json): void {
  const line = JSON.stringify({
    method: "thread/tokenUsage/updated",
    params,
  });
  codexContainedOf(rig).stdout.write(`${line}\n`);
}

describe("codex adapter context usage", () => {
  it("emits_context_usage_from_token_usage_notification", async () => {
    const rig = await createCodexRig();
    const { events } = await startCodexHandle(rig);
    pushTokenUsage(rig, {
      threadId: "thr-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 60_000 },
        last: { totalTokens: 30_000 },
        modelContextWindow: 258_400,
      },
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "context_usage",
        usage: { usedTokens: 30_000, limitTokens: 258_400 },
      });
    });
  });

  it("codex_null_context_window_gives_unknown_limit", async () => {
    const rig = await createCodexRig();
    const { events } = await startCodexHandle(rig);
    pushTokenUsage(rig, {
      threadId: "thr-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 12_000 },
        last: { totalTokens: 8_000 },
        modelContextWindow: null,
      },
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "context_usage",
        usage: { usedTokens: 8_000, limitTokens: null },
      });
    });
  });
});

describe("codex adapter context usage filtering", () => {
  it("codex_ignores_other_thread_usage", async () => {
    const rig = await createCodexRig();
    const { events } = await startCodexHandle(rig);
    pushTokenUsage(rig, {
      threadId: "thr-other",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 99_000 },
        last: { totalTokens: 99_000 },
        modelContextWindow: 258_400,
      },
    });
    pushTokenUsage(rig, {
      threadId: "thr-1",
      turnId: "turn-2",
      tokenUsage: {
        total: { totalTokens: 15_000 },
        last: { totalTokens: 5_000 },
        modelContextWindow: 258_400,
      },
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "context_usage",
        usage: { usedTokens: 5_000, limitTokens: 258_400 },
      });
    });
    expect(events.filter((event) => event.type === "context_usage")).toEqual([
      {
        type: "context_usage",
        usage: { usedTokens: 5_000, limitTokens: 258_400 },
      },
    ]);
  });
});
