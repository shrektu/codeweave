import { realpath } from "node:fs/promises";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { join } from "node:path";

import { afterEach, expect, it, vi, type MockInstance } from "vitest";

import { createConnectionRegistry } from "../../src/backend/connections";
import { ContainerUnavailableError } from "../../src/backend/process/container";
import { mergeLimitWindows } from "../../src/domain/limitWindows";
import { fromNodePort } from "../../src/shared/port";
import { IpcErrorCode, ResponseSchema } from "../../src/shared/protocol";
import { SessionViewSchema, SnapshotSchema } from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  RIG_NOW_MS,
  agentOf,
  closeRigs,
  openRig as open,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import { NO_LIMITS_USAGE_MARKDOWN } from "../fakes/fakeClaudeUsage";
import {
  AUTH_REQUIRED_CODE,
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import { settled } from "../fakes/settle";

const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const RESET_AFTER_COOLDOWN_SECONDS = 1_700_003_600;
const GIT_FALLBACK_WARNING = "not a git worktree, locking on path";

const ports: MessagePort[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) {
    port.close();
  }
  await closeRigs();
});

it("session_text_and_tool_card_reach_view", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    { type: "text", text: "Looking at it" },
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "pnpm test" },
    },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      text: "all green",
    },
    END_TURN,
  ]);

  const accepted = await rig.call("session/prompt", { text: "run tests" });
  await turnEnded(rig);

  expect(accepted).toEqual({ accepted: true });
  const view = await rig.session();
  expect(view.messages).toEqual([{ id: null, text: "Looking at it", seq: 1 }]);
  expect(view.toolCalls).toEqual([
    {
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      status: "completed",
      command: "pnpm test",
      output: "all green",
      seq: 2,
    },
  ]);
  const pushed = rig.broadcastsOf("session/changed").at(-1);
  expect(SessionViewSchema.nullable().parse(pushed)).toEqual(view);
});

it("user_turn_settles_through_controller", async () => {
  const rig = await open({ accounts: [ACCOUNT_A] });
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/prompt", { text: "go" });

  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "waiting",
      accountId: ACCOUNT_A.id,
      until: RESET_AFTER_COOLDOWN_SECONDS,
    });
  });
  expect(rig.scheduled.map((task) => task.at)).toEqual([
    RESET_AFTER_COOLDOWN_SECONDS * 1000,
  ]);
});
it("ask_permission_snapshot_and_exact_option_answer", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig, "ask"));
  agentOf(rig).enqueue([
    {
      type: "permission",
      toolCallId: "t1",
      title: "Run pnpm test",
      kind: "execute",
      rawInput: { command: "pnpm test" },
      paths: [],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    END_TURN,
  ]);

  await rig.call("session/prompt", { text: "test it" });

  const pending = await settled(async () => {
    const { permissions } = await rig.session();
    expect(permissions).toHaveLength(1);
    return permissions;
  });
  expect(pending).toEqual([
    {
      requestId: expect.any(String) as string,
      toolCallId: "t1",
      title: "Run pnpm test",
      command: "pnpm test",
      seq: 1,
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "allow-always",
          name: "Always allow",
          kind: "allow_always",
        },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  ]);

  const requestId = pending[0]?.requestId ?? "";
  await expect(
    rig.call("permission/answer", { requestId, optionId: "allow-always" }),
  ).resolves.toEqual({ ok: true });

  await turnEnded(rig);
  expect(agentOf(rig).permissionOutcomes).toEqual([
    { outcome: "selected", optionId: "allow-always" },
  ]);
  expect((await rig.session()).permissions).toEqual([]);
});

it("unattended_auto_answers_read_edit_and_denies_sudo", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig, "unattended"));
  const file = join(rig.cwd, "notes.txt");
  agentOf(rig).enqueue([
    {
      type: "permission",
      toolCallId: "r1",
      title: "Read notes",
      kind: "read",
      paths: [file],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    {
      type: "permission",
      toolCallId: "e1",
      title: "Edit notes",
      kind: "edit",
      rawInput: { file_path: file },
      paths: [file],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    {
      type: "permission",
      toolCallId: "x1",
      title: "Run sudo",
      kind: "execute",
      rawInput: { command: "sudo ls" },
      paths: [],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    END_TURN,
  ]);

  await rig.call("session/prompt", { text: "tidy up" });
  await turnEnded(rig);

  expect(agentOf(rig).permissionOutcomes).toEqual([
    { outcome: "selected", optionId: "allow-once" },
    { outcome: "selected", optionId: "allow-once" },
    { outcome: "selected", optionId: "reject-once" },
  ]);
  expect((await rig.session()).permissions).toEqual([]);
});

it("ui_reconnect_restores_pending_permission", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig, "ask"));
  agentOf(rig).enqueue([
    {
      type: "permission",
      toolCallId: "t1",
      title: "Run ls",
      kind: "execute",
      rawInput: { command: "ls" },
      paths: [],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    END_TURN,
  ]);
  await rig.call("session/prompt", { text: "list" });
  await settled(async () => {
    expect((await rig.session()).permissions).toHaveLength(1);
  });
  const registry = createConnectionRegistry(rig.backend.handlers);
  const first = new MessageChannel();
  ports.push(first.port1, first.port2);
  registry.connect(fromNodePort(first.port1));
  first.port2.close();
  await settled(() => {
    expect(registry.size()).toBe(0);
  });

  const second = new MessageChannel();
  ports.push(second.port1, second.port2);
  registry.connect(fromNodePort(second.port1));
  const reply = new Promise<unknown>((resolve) => {
    second.port2.once("message", resolve);
  });
  second.port2.postMessage({
    v: 6,
    id: "snap",
    method: "sessions/snapshot",
    params: {},
  });

  const response = ResponseSchema.parse(await reply);
  expect(response.ok).toBe(true);
  const snapshot = SnapshotSchema.parse(response.ok ? response.result : null);
  expect(snapshot.session?.permissions.map((item) => item.title)).toEqual([
    "Run ls",
  ]);
});
it("rotation_stops_a_before_spawning_b_with_context_package", async () => {
  const rig = await open();
  const started = await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "pnpm test" },
    },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      text: "12 passed",
    },
    RATE_LIMIT_FAILURE,
  ]);

  await rig.call("session/prompt", { text: "make the tests pass" });

  await settled(() => {
    expect(rig.container.agents).toHaveLength(2);
    expect(agentOf(rig, 1).prompts).toHaveLength(1);
  });
  expect(rig.order.slice(0, 3)).toEqual([
    "spawn:run-1",
    "stop-confirmed:run-1",
    "spawn:run-2",
  ]);
  const handoff = agentOf(rig, 1).prompts[0] ?? "";
  expect(handoff).toContain("1. make the tests pass");
  expect(handoff).toContain("- Run tests\n  Status: completed");
  expect(handoff).toContain("Result: 12 passed");
  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toEqual({ phase: "running", accountId: ACCOUNT_B.id });
    expect(view.turnInFlight).toBe(false);
  });
  const entry = {
    at: RIG_NOW_MS,
    sessionId: started.id,
    from: ACCOUNT_A.id,
    to: ACCOUNT_B.id,
    reason: "rate_limit",
    resetsAt: RESET_AFTER_COOLDOWN_SECONDS,
    contextPackageChars: handoff.length,
  };
  expect(await rig.store.readSwitchLog(10)).toEqual([entry]);
  expect(rig.broadcastsOf("switchLog/appended")).toEqual([entry]);
});
async function openProbed(): Promise<BackendRig> {
  const rig = await open({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    claudeProbeText: NO_LIMITS_USAGE_MARKDOWN,
  });
  await settled(() => {
    expect(rig.probeTasks).toHaveLength(1);
  });
  return rig;
}

it("accounts_changed_broadcast_marks_exhausted_account", async () => {
  const rig = await openProbed();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/prompt", { text: "go" });

  await settled(() => {
    expect(rig.broadcastsOf("accounts/changed").at(-1)).toEqual({
      accounts: [
        {
          ...ACCOUNT_A,
          api: null,
          hasKey: false,
          keyHint: null,
          runtime: {
            status: "exhausted",
            resetsAt: RESET_AFTER_COOLDOWN_SECONDS,
          },
          limit: null,
          limitAvailability: "unsupported",
        },
        {
          ...ACCOUNT_B,
          api: null,
          hasKey: false,
          keyHint: null,
          runtime: { status: "ready" },
          limit: null,
          limitAvailability: "unsupported",
        },
      ],
    });
  });
});

it("exhausted_turn_records_rejected_limit", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/prompt", { text: "go" });

  await settled(async () => {
    expect((await rig.session()).limits).toEqual([
      {
        accountId: ACCOUNT_A.id,
        status: "rejected",
        resetsAt: RESET_AFTER_COOLDOWN_SECONDS,
        rateLimitType: null,
        utilization: null,
        windows: [],
        observedAt: RIG_NOW_MS,
      },
    ]);
  });
});

const WEEK_RESET_SECONDS = 1_700_600_000;

function claudeLimitMeta(
  rateLimitType: string,
  utilization: number,
  resetsAt: number,
): ScriptStep {
  return {
    type: "usage_update",
    meta: {
      "_claude/rateLimit": {
        status: "allowed",
        resetsAt,
        rateLimitType,
        utilization,
      },
    },
  };
}

it("claude_live_windows_accumulate", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    claudeLimitMeta("five_hour", 0.3, RESET_AFTER_COOLDOWN_SECONDS),
    claudeLimitMeta("seven_day", 0.6, WEEK_RESET_SECONDS),
    END_TURN,
  ]);

  await rig.call("session/prompt", { text: "go" });
  await turnEnded(rig);

  expect((await rig.session()).limits).toEqual([
    {
      accountId: ACCOUNT_A.id,
      status: "allowed",
      resetsAt: WEEK_RESET_SECONDS,
      rateLimitType: "seven_day",
      utilization: 0.6,
      windows: [
        {
          id: "five_hour",
          scope: null,
          period: "five_hour",
          utilization: 0.3,
          resetsAt: RESET_AFTER_COOLDOWN_SECONDS,
          exhausted: false,
        },
        {
          id: "seven_day",
          scope: null,
          period: "seven_day",
          utilization: 0.6,
          resetsAt: WEEK_RESET_SECONDS,
          exhausted: false,
        },
      ],
      observedAt: RIG_NOW_MS,
    },
  ]);
});

it("probe_and_live_opus_windows_merge", async () => {
  const rig = await open();
  await settled(() => {
    expect(rig.probeTasks).toHaveLength(1);
  });
  const probed = (await rig.call("accounts/list", {})).accounts.find(
    (account) => account.id === ACCOUNT_A.id,
  );
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    claudeLimitMeta("seven_day_opus", 0.5, WEEK_RESET_SECONDS),
    END_TURN,
  ]);

  await rig.call("session/prompt", { text: "go" });
  await turnEnded(rig);

  const live = (await rig.session()).limits.flatMap((limit) => limit.windows);
  const merged = mergeLimitWindows(probed?.limit?.windows ?? [], live);
  expect(live.map((window) => window.id)).toEqual(["seven_day:opus"]);
  expect(
    merged
      .filter((window) => window.scope === "Opus")
      .map((window) => window.id),
  ).toEqual(["seven_day:opus"]);
  expect(merged.find((window) => window.id === "five_hour")).toBeDefined();
});

it("runtime_broadcast_only_on_change", async () => {
  const rig = await openProbed();
  const broadcastsBefore = rig.broadcastsOf("accounts/changed").length;
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([{ type: "text", text: "hello" }, END_TURN]);

  await rig.call("session/prompt", { text: "hi" });
  await turnEnded(rig);

  expect(rig.broadcastsOf("session/changed").length).toBeGreaterThan(2);
  expect(rig.broadcastsOf("accounts/changed")).toHaveLength(broadcastsBefore);
});

it("runtime_broadcast_on_needs_login", async () => {
  const rig = await openProbed();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    { type: "fail", code: AUTH_REQUIRED_CODE, message: "Auth required" },
  ]);

  await rig.call("session/prompt", { text: "go" });

  await settled(() => {
    expect(rig.broadcastsOf("accounts/changed").at(-1)).toEqual({
      accounts: [
        {
          ...ACCOUNT_A,
          api: null,
          hasKey: false,
          keyHint: null,
          runtime: { status: "needs_login" },
          limit: null,
          limitAvailability: "unsupported",
        },
        {
          ...ACCOUNT_B,
          api: null,
          hasKey: false,
          keyHint: null,
          runtime: { status: "ready" },
          limit: null,
          limitAvailability: "unsupported",
        },
      ],
    });
  });
});

it("runtime_broadcast_on_new_session_resets", async () => {
  const rig = await openProbed();
  const broadcastsBefore = rig.broadcastsOf("accounts/changed").length;
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { text: "go" });
  await settled(() => {
    expect(rig.broadcastsOf("accounts/changed")).toHaveLength(
      broadcastsBefore + 1,
    );
  });

  await rig.call("session/stop", {});
  expect(rig.broadcastsOf("accounts/changed")).toHaveLength(
    broadcastsBefore + 1,
  );
  await rig.call("session/start", startParams(rig));

  await settled(() => {
    expect(rig.broadcastsOf("accounts/changed").at(-1)).toEqual({
      accounts: [
        {
          ...ACCOUNT_A,
          api: null,
          hasKey: false,
          keyHint: null,
          runtime: { status: "ready" },
          limit: null,
          limitAvailability: "unsupported",
        },
        {
          ...ACCOUNT_B,
          api: null,
          hasKey: false,
          keyHint: null,
          runtime: { status: "ready" },
          limit: null,
          limitAvailability: "unsupported",
        },
      ],
    });
  });
});

it("context_package_names_command_from_tool_call_update", async () => {
  const rig = await open();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Terminal",
      kind: "execute",
      rawInput: {},
    },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      title: "echo deploy | tee -a x",
      rawInput: { command: "echo deploy | tee -a x" },
      text: "deploy",
    },
    RATE_LIMIT_FAILURE,
  ]);

  await rig.call("session/prompt", { text: "ship it" });

  await settled(() => {
    expect(agentOf(rig, 1).prompts).toHaveLength(1);
  });
  const handoff = agentOf(rig, 1).prompts[0] ?? "";
  expect(handoff).toContain("- echo deploy | tee -a x\n  Status: completed");
  expect(handoff).toContain("do not re-run automatically");
  expect(handoff).not.toContain("- Terminal");
});

it("backend_start_sweeps_orphans_of_previous_instances", async () => {
  const first = await open();
  const second = await open({ userData: first.userData });

  expect(first.sweeps).toEqual([[]]);
  expect(second.sweeps).toEqual([first.instanceIds]);
  expect(second.instanceIds).toHaveLength(1);
  expect(second.instanceIds).not.toEqual(first.instanceIds);
});

it("session_start_unavailable_without_container", async () => {
  const rig = await open({
    accounts: [ACCOUNT_A],
    containerError: new ContainerUnavailableError("No container here"),
  });

  await expect(
    rig.call("session/start", startParams(rig)),
  ).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: "No container here",
  });
  const snapshot = await rig.call("sessions/snapshot", {});
  expect(snapshot.container).toEqual({
    available: false,
    message: "No container here",
  });
});

function gitFallbackWarnings(spy: MockInstance<typeof console.warn>): number {
  return spy.mock.calls.filter(
    ([first]) =>
      typeof first === "string" && first.includes(GIT_FALLBACK_WARNING),
  ).length;
}

it("session_launch_uses_the_lock_resolver_from_backend_deps", async () => {
  const recorded: string[] = [];
  const rig = await open({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    resolveLockKey: (cwd) => {
      recorded.push(cwd);
      return realpath(cwd);
    },
  });

  await rig.call("session/start", startParams(rig));

  expect(recorded).toEqual([rig.cwd]);
});

it("rig_session_start_makes_no_git_lock_lookup", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await open();

  await rig.call("session/start", startParams(rig));

  expect(gitFallbackWarnings(warn)).toBe(0);
});

it("backend_without_lock_resolver_falls_back_to_git_lookup", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await open({ accounts: [ACCOUNT_A], backendLockKeys: true });

  await rig.call("session/start", startParams(rig));

  expect(gitFallbackWarnings(warn)).toBe(1);
});
