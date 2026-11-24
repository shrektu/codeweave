import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PROCESS_EXITED_MESSAGE } from "../../src/backend/constants";
import type { AgentEvent } from "../../src/domain/events";
import { createRateLimitDetector } from "../../src/domain/rateLimit";
import { PermissionProfile } from "../../src/domain/types";
import {
  CODEX_RIG_EXECUTABLE,
  CODEX_RIG_GRACE_MS,
  CODEX_RIG_RATE_READ_TIMEOUT_MS,
  agentDelta,
  codexContainedOf,
  codexPermissionRequestOf,
  commandApproval,
  commandItem,
  createCodexRig,
  itemCompleted,
  itemStarted,
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  removeCodexRigDirs,
  serverOf,
  settlesWithin,
  startCodexHandle,
  type RateLimitRead,
} from "../fakes/fakeCodexAppServer";

const NOW_MS = 1_700_000_000_000;
const RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const FULL_PERCENT = 100;
const LOW_PERCENT = 10;
const SETTLE_BOUND_MS = 2000;
const LATE_READ_MARGIN_MS = 150;
const OVERLAP_STALE_DELAY_MS = 400;
const OVERLAP_FRESH_DELAY_MS = 250;
const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Try again at 3:14 PM.";

const INITIAL_RATE_LIMIT = {
  type: "rate_limit",
  status: "allowed",
  resetsAt: null,
  rateLimitType: "five_hour",
  utilization: 0.1,
  windows: [
    {
      id: "five_hour",
      scope: null,
      period: "five_hour",
      utilization: 0.1,
      resetsAt: null,
      exhausted: false,
    },
  ],
};

const REJECTED_AT_RESET = {
  type: "rate_limit",
  status: "rejected",
  resetsAt: RESET_AT,
  rateLimitType: "five_hour",
  utilization: 1,
  windows: [
    {
      id: "five_hour",
      scope: null,
      period: "five_hour",
      utilization: 1,
      resetsAt: RESET_AT,
      exhausted: true,
    },
  ],
};

const EXHAUSTED_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(
      rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
      null,
      "rate_limit_reached",
    ),
    false,
  ),
};

const INITIAL_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
  ),
};

afterEach(async () => {
  vi.restoreAllMocks();
  await removeCodexRigDirs();
});

function settleOutcome(events: readonly AgentEvent[]): unknown {
  const detector = createRateLimitDetector(() => NOW_MS);
  for (const event of events) {
    detector.observe(event);
  }
  return detector.settle();
}

describe("codex app-server adapter: start", () => {
  it("codex_start_handshake_order_and_profile_params", async () => {
    const rig = await createCodexRig();

    const result = await rig.start(PermissionProfile.ask);

    expect(result.ok).toBe(true);
    const server = serverOf(rig);
    expect(server.methods()).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
      "thread/start",
    ]);
    expect(server.paramsOf("initialize")).toEqual([
      {
        clientInfo: { name: "codeweave", title: "Codeweave", version: "0.0.0" },
      },
    ]);
    expect(server.rawLines).toContain('{"method":"initialized"}');
    expect(server.paramsOf("thread/start")).toEqual([
      {
        cwd: rig.cwd,
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      },
    ]);
    expect(rig.container.specs[0]).toMatchObject({
      command: CODEX_RIG_EXECUTABLE,
      args: ["app-server"],
      env: { CODEX_HOME: "/home/jane/.codex-main" },
    });
  });

  it("codex_logged_out_home_fails_start_needs_login", async () => {
    const rig = await createCodexRig();
    rig.container.config.loggedIn = false;

    const result = await rig.start(PermissionProfile.ask);

    expect(result).toEqual({
      ok: false,
      reason: "needs_login",
      message: "Codex login required",
    });
    expect(codexContainedOf(rig).stopCalls).toEqual([CODEX_RIG_GRACE_MS]);
    expect(serverOf(rig).methods()).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
  });
});

describe("codex app-server adapter: turn", () => {
  it("codex_turn_maps_text_and_command_items", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      agentDelta("m1", "Hel"),
      agentDelta("m1", "lo"),
      itemStarted(commandItem("c1", "ls", "inProgress")),
      itemCompleted(commandItem("c1", "ls", "completed", "a.txt\n")),
      { type: "complete", status: "completed" },
    ]);

    await handle.prompt("list files", { model: null });

    expect(events).toEqual([
      INITIAL_RATE_LIMIT,
      { type: "text", messageId: "m1", text: "Hel" },
      { type: "text", messageId: "m1", text: "lo" },
      {
        type: "tool_call",
        toolCallId: "c1",
        title: "ls",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
      {
        type: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        rawInput: { command: "ls" },
        output: "a.txt\n",
      },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(serverOf(rig).paramsOf("turn/start")).toEqual([
      { threadId: "thr-1", input: [{ type: "text", text: "list files" }] },
    ]);
  });
});

describe("codex app-server adapter: approval", () => {
  it("codex_command_approval_round_trip", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      commandApproval("c2", "make build"),
      { type: "complete", status: "completed" },
    ]);

    const turn = handle.prompt("build it", { model: null });
    const { requestId, ...request } = await codexPermissionRequestOf(events);

    expect(requestId).not.toBe("");
    expect(request).toEqual({
      type: "permission_request",
      toolCallId: "c2",
      title: "make build",
      kind: "execute",
      rawInput: { command: "make build" },
      locations: [],
      options: [
        { optionId: "accept", name: "Allow", kind: "allow_once" },
        {
          optionId: "acceptForSession",
          name: "Allow for session",
          kind: "allow_always",
        },
        { optionId: "decline", name: "Decline", kind: "reject_once" },
      ],
    });
    handle.answerPermission(requestId, "accept");
    await turn;
    expect(serverOf(rig).answers).toEqual([
      {
        id: 1000,
        method: "item/commandExecution/requestApproval",
        result: { decision: "accept" },
      },
    ]);
  });
});

describe("codex app-server adapter: approval cwd", () => {
  it("codex-approval-cwd-outside-root", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      commandApproval("c4", "touch x", "/elsewhere/dir"),
      { type: "complete", status: "completed" },
    ]);

    const turn = handle.prompt("touch it", { model: null });
    const request = await codexPermissionRequestOf(events);

    expect(request.rawInput).toEqual({
      command: "touch x",
      cwd: "/elsewhere/dir",
    });
    handle.answerPermission(request.requestId, "accept");
    await turn;
  });
});

describe("codex app-server adapter: limits", () => {
  it("codex_usage_limit_after_tool_is_exhausted_with_reset", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [INITIAL_READ, EXHAUSTED_READ];
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      itemStarted(commandItem("c3", "ls", "inProgress")),
      itemCompleted(commandItem("c3", "ls", "completed", "a.txt\n")),
      {
        type: "fail",
        codexErrorInfo: "usageLimitExceeded",
        message: USAGE_LIMIT_MESSAGE,
      },
    ]);

    await handle.prompt("keep going", { model: null });

    expect(events.slice(1)).toEqual([
      expect.objectContaining({ type: "tool_call", toolCallId: "c3" }),
      expect.objectContaining({
        type: "tool_call_update",
        toolCallId: "c3",
        status: "completed",
      }),
      REJECTED_AT_RESET,
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: USAGE_LIMIT_MESSAGE,
      },
    ]);
    expect(settleOutcome(events)).toEqual({
      kind: "exhausted",
      resetsAt: RESET_AT,
      rateLimitType: "five_hour",
    });
  });
});

describe("codex app-server adapter: auth", () => {
  it("codex_unauthorized_turn_needs_login", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      {
        type: "fail",
        codexErrorInfo: "unauthorized",
        message: "Your access token could not be refreshed.",
      },
    ]);

    await handle.prompt("hello", { model: null });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: "auth_required",
      rpcCode: null,
      message: "Your access token could not be refreshed.",
    });
    expect(settleOutcome(events)).toEqual({ kind: "needs_login" });
  });
});

describe("codex app-server adapter: model selection", () => {
  it("model reaches codex turn/start", async () => {
    const rig = await createCodexRig();
    const { handle } = await startCodexHandle(rig);

    await handle.prompt("go", { model: "gpt-5-codex" });

    expect(serverOf(rig).paramsOf("turn/start")).toEqual([
      expect.objectContaining({ model: "gpt-5-codex" }) as unknown,
    ]);
  });

  it("null model omits turn/start model", async () => {
    const rig = await createCodexRig();
    const { handle } = await startCodexHandle(rig);

    await handle.prompt("go", { model: null });

    const [params] = serverOf(rig).paramsOf("turn/start");
    expect(params).toEqual(expect.objectContaining({ threadId: "thr-1" }));
    expect(params).not.toHaveProperty("model");
  });
});

describe("codex app-server adapter: model reporting", () => {
  it("adapter reports thread and rerouted model", async () => {
    const rig = await createCodexRig();
    rig.container.config.threadModel = "gpt-5-codex";
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      {
        type: "notify",
        method: "model/rerouted",
        params: {
          fromModel: "gpt-5-codex",
          toModel: "gpt-5-mini",
          reason: "highRiskCyberActivity",
        },
      },
      { type: "complete", status: "completed" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-mini" },
    ]);
  });

  it("thread_start_model_is_current_before_first_prompt", async () => {
    const rig = await createCodexRig();
    rig.container.config.threadModel = "gpt-5-codex";

    const { events } = await startCodexHandle(rig);

    expect(events).toEqual([{ type: "model", model: "gpt-5-codex" }]);
  });

  it("codex reports the turn model it sent", async () => {
    const rig = await createCodexRig();
    rig.container.config.threadModel = "gpt-5-codex";
    const { handle, events } = await startCodexHandle(rig);

    await handle.prompt("go", { model: "gpt-5-mini" });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-mini" },
    ]);
  });

  it("codex reroute after the turn model wins", async () => {
    const rig = await createCodexRig();
    rig.container.config.threadModel = "gpt-5-codex";
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      {
        type: "notify",
        method: "model/rerouted",
        params: {
          fromModel: "gpt-5-mini",
          toModel: "gpt-5-nano",
          reason: "highRiskCyberActivity",
        },
      },
      { type: "complete", status: "completed" },
    ]);

    await handle.prompt("go", { model: "gpt-5-mini" });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-mini" },
      { type: "model", model: "gpt-5-nano" },
    ]);
  });

  it("codex null turn model keeps the announced model", async () => {
    const rig = await createCodexRig();
    rig.container.config.threadModel = "gpt-5-codex";
    const { handle, events } = await startCodexHandle(rig);

    await handle.prompt("one", { model: "gpt-5-mini" });
    await handle.prompt("two", { model: null });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-mini" },
      { type: "model", model: "gpt-5-mini" },
    ]);
  });

  it("codex reports the model on every turn", async () => {
    const rig = await createCodexRig();
    rig.container.config.threadModel = "gpt-5-codex";
    const { handle, events } = await startCodexHandle(rig);

    await handle.prompt("one", { model: "gpt-5-mini" });
    await handle.prompt("two", { model: "gpt-5-mini" });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-mini" },
      { type: "model", model: "gpt-5-mini" },
    ]);
  });

  it("malformed rerouted notification reports no model", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      {
        type: "notify",
        method: "model/rerouted",
        params: { fromModel: "gpt-5-codex", toModel: 5 },
      },
      { type: "complete", status: "completed" },
    ]);

    await handle.prompt("go", { model: null });

    expect(events.filter((event) => event.type === "model")).toEqual([]);
  });

  it("rejected model fails the turn without a rate limit", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      {
        type: "fail",
        codexErrorInfo: "modelNotFound",
        message: "The model nonsense does not exist.",
      },
    ]);

    await handle.prompt("go", { model: "nonsense" });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: "The model nonsense does not exist.",
    });
    expect(settleOutcome(events)).toEqual({
      kind: "failed",
      message: "The model nonsense does not exist.",
    });
  });
});

describe("codex app-server adapter: cancel and exit", () => {
  it("codex_cancel_sends_turn_interrupt", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([{ type: "await_interrupt" }]);

    const turn = handle.prompt("long task", { model: null });
    await vi.waitFor(() => {
      expect(serverOf(rig).methods()).toContain("turn/start");
    });
    await handle.cancel();
    await turn;

    expect(serverOf(rig).paramsOf("turn/interrupt")).toEqual([
      { threadId: "thr-1", turnId: "turn-1" },
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "cancelled",
    });
  });

  it("codex_process_exit_mid_turn_ends_turn", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([agentDelta("m2", "partial"), { type: "exit" }]);

    await handle.prompt("crash please", { model: null });

    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({ type: "process_exit" });
    });
    expect(events.slice(-3)).toEqual([
      { type: "text", messageId: "m2", text: "partial" },
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: PROCESS_EXITED_MESSAGE,
      },
      { type: "process_exit" },
    ]);
  });
});

const REACHED_TYPE_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(
      rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
      null,
      "rate_limit_reached",
    ),
  ),
};

function pushRateLimitUpdate(
  rig: Awaited<ReturnType<typeof createCodexRig>>,
  rateLimits: Readonly<Record<string, unknown>>,
): void {
  const line = JSON.stringify({
    method: "account/rateLimits/updated",
    params: { rateLimits },
  });
  codexContainedOf(rig).stdout.write(`${line}\n`);
}

describe("codex app-server adapter: start and close regressions", () => {
  it("initial_rate_limit_read_timeout_does_not_block_start", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [{ kind: "hang" }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const started = rig.start();

    expect(
      await settlesWithin(
        started,
        CODEX_RIG_RATE_READ_TIMEOUT_MS + SETTLE_BOUND_MS,
      ),
    ).toBe(true);
    expect(await started).toMatchObject({ ok: true });
    expect(serverOf(rig).methods()).toContain("thread/start");
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

    expect(await settlesWithin(turn, SETTLE_BOUND_MS)).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: PROCESS_EXITED_MESSAGE,
    });
  });
});

describe("codex app-server adapter: reached type regressions", () => {
  it("full_rate_limit_read_clears_reached_type", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      EXHAUSTED_READ,
      {
        kind: "ok",
        response: rateLimitsResponse(
          rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
          null,
        ),
      },
    ];
    const { handle, events } = await startCodexHandle(rig);
    serverOf(rig).enqueue([
      { type: "fail", codexErrorInfo: "usageLimitExceeded", message: "limit" },
    ]);
    await handle.prompt("hit the limit", { model: null });

    pushRateLimitUpdate(rig, rateSnapshot(null, null));

    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({
        ...INITIAL_RATE_LIMIT,
        utilization: LOW_PERCENT / FULL_PERCENT,
      });
    });
  });

  it("sparse_update_with_window_clears_reached_type", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [REACHED_TYPE_READ];
    const { events } = await startCodexHandle(rig);

    pushRateLimitUpdate(
      rig,
      rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
    );

    await vi.waitFor(() => {
      expect(events).toEqual([INITIAL_RATE_LIMIT]);
    });
  });
});

describe("codex app-server adapter: profile regressions", () => {
  it("profile_switch_back_resends_start_policy", async () => {
    const rig = await createCodexRig();
    const { handle } = await startCodexHandle(rig, PermissionProfile.ask);

    await handle.prompt("one", { model: null });
    await handle.setProfile(PermissionProfile.bypass);
    await handle.prompt("two", { model: null });
    await handle.prompt("three", { model: null });
    await handle.setProfile(PermissionProfile.ask);
    await handle.prompt("four", { model: null });
    await handle.prompt("five", { model: null });

    const overrides = serverOf(rig)
      .paramsOf("turn/start")
      .map((params) =>
        z
          .looseObject({
            approvalPolicy: z.string().optional(),
            sandboxPolicy: z.looseObject({ type: z.string() }).optional(),
          })
          .parse(params),
      )
      .map(({ approvalPolicy, sandboxPolicy }) => ({
        approvalPolicy,
        sandboxPolicy,
      }));
    expect(overrides).toEqual([
      { approvalPolicy: undefined, sandboxPolicy: undefined },
      {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      { approvalPolicy: undefined, sandboxPolicy: undefined },
      {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "workspaceWrite" },
      },
      { approvalPolicy: undefined, sandboxPolicy: undefined },
    ]);
  });
});

describe("codex app-server adapter: cancel regressions", () => {
  it("cancel_on_silent_server_times_out_and_stop_kills", async () => {
    const rig = await createCodexRig();
    rig.container.config.turnStartHang = true;
    const { handle } = await startCodexHandle(rig);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const turn = handle.prompt("never answered", { model: null });
    await vi.waitFor(() => {
      expect(serverOf(rig).methods()).toContain("turn/start");
    });

    expect(await settlesWithin(handle.cancel(), SETTLE_BOUND_MS)).toBe(true);
    expect(
      await settlesWithin(handle.stop(CODEX_RIG_GRACE_MS), SETTLE_BOUND_MS),
    ).toBe(true);

    expect(codexContainedOf(rig).stopCalls).toEqual([CODEX_RIG_GRACE_MS]);
    expect(await settlesWithin(turn, SETTLE_BOUND_MS)).toBe(true);
  });

  it("cancel_with_silent_interrupt_reply_times_out", async () => {
    const rig = await createCodexRig();
    rig.container.config.interruptHang = true;
    const { handle } = await startCodexHandle(rig);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    serverOf(rig).enqueue([{ type: "hang" }]);
    const turn = handle.prompt("long", { model: null });
    await vi.waitFor(() => {
      expect(serverOf(rig).methods()).toContain("turn/start");
    });

    expect(await settlesWithin(handle.cancel(), SETTLE_BOUND_MS)).toBe(true);
    expect(serverOf(rig).methods()).toContain("turn/interrupt");
    await handle.stop(CODEX_RIG_GRACE_MS);
    await turn;
  });
});

describe("codex app-server adapter: round two regressions", () => {
  it("sparse_update_with_only_reached_type_marks_exhausted", async () => {
    const rig = await createCodexRig();
    const { events } = await startCodexHandle(rig);

    pushRateLimitUpdate(rig, rateSnapshot(null, null, "rate_limit_reached"));

    await vi.waitFor(() => {
      expect(events).toEqual([{ ...INITIAL_RATE_LIMIT, status: "rejected" }]);
    });
  });

  it("late_rate_limit_read_does_not_overwrite_newer_update", async () => {
    const rig = await createCodexRig();
    rig.container.config.rateLimitReads = [
      {
        kind: "delayed",
        delayMs: CODEX_RIG_RATE_READ_TIMEOUT_MS + LATE_READ_MARGIN_MS,
        response: rateLimitsResponse(
          rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
        ),
      },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { events } = await startCodexHandle(rig);
    const rejected = REJECTED_AT_RESET;

    pushRateLimitUpdate(
      rig,
      rateSnapshot(
        rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
        null,
        "rate_limit_reached",
      ),
    );
    await Promise.all(serverOf(rig).delayedReplies);
    pushRateLimitUpdate(rig, rateSnapshot(null, null));

    await vi.waitFor(() => {
      expect(events).toEqual([rejected, rejected]);
    });
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
            rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
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
      REJECTED_AT_RESET,
    ]);
  });
});

describe("codex app-server adapter: windows launch", () => {
  it("verbatim_arguments_reach_spawn_options", async () => {
    const executable = "C:\\Program Files (x86)\\nodejs\\codex.cmd";
    const rig = await createCodexRig([], { platform: "win32", executable });

    const result = await rig.start();

    expect(result.ok).toBe(true);
    expect(rig.container.specs[0]).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${executable}" app-server"`],
      windowsVerbatimArguments: true,
    });
  });

  it("posix_launch_carries_no_verbatim_flag", async () => {
    const rig = await createCodexRig();

    await rig.start();

    expect(rig.container.specs[0]).not.toHaveProperty(
      "windowsVerbatimArguments",
    );
  });
});

describe("codex app-server adapter: stream regressions", () => {
  it("stdout_stream_error_closes_peer_without_crash", async () => {
    const rig = await createCodexRig();
    const { handle, events } = await startCodexHandle(rig);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    serverOf(rig).enqueue([{ type: "hang" }]);
    const turn = handle.prompt("stall", { model: null });
    await vi.waitFor(() => {
      expect(serverOf(rig).methods()).toContain("turn/start");
    });

    codexContainedOf(rig).stdout.destroy(new Error("EPIPE"));

    expect(await settlesWithin(turn, SETTLE_BOUND_MS)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      message: PROCESS_EXITED_MESSAGE,
    });
  });
});
