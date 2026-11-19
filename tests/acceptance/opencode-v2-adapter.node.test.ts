import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { UnknownPermissionError } from "../../src/backend/agentAdapter";
import { PROCESS_EXITED_MESSAGE } from "../../src/backend/constants";
import { ConsoleLoginState } from "../../src/backend/opencode/consoleLogin";
import type { OpencodeCredentials } from "../../src/backend/opencode/config";
import type { AgentEvent } from "../../src/domain/events";
import type { SpawnSpec } from "../../src/backend/process/container";
import { PermissionProfile } from "../../src/domain/types";
import type { OpencodeStartup } from "../fakes/opencodeFakeCommon";
import {
  OPENCODE_RIG_NOW_MS,
  OPENCODE_RIG_PASSWORD,
  OPENCODE_SESSION_ID,
  disposeOpencodeRigs,
  opencodePermissionRequestOf,
} from "../fakes/fakeOpencodeServer";
import {
  createOpencodeV2Rig,
  opencodeV2ServerOf,
  startOpencodeV2Handle,
  type FakeOpencodeV2Server,
  type OpencodeV2Rig,
  type OpencodeV2Step,
} from "../fakes/fakeOpencodeV2Server";
import { settled } from "../fakes/settle";

const KEY = "sk-test-A";
const MODEL = "llama-3.3-70b";
const PROVIDER = "groq";
const OTHER_MODEL = "kimi-k2.7-code";
const STOP_GRACE_MS = 100;
const SESSION_PATH = `/api/session/${OPENCODE_SESSION_ID}`;
const PROMPT_PATH = `${SESSION_PATH}/prompt`;
const AGENT_PATH = `${SESSION_PATH}/agent`;
const MODEL_PATH = `${SESSION_PATH}/model`;
const INTERRUPT_PATH = `${SESSION_PATH}/interrupt`;
const NOW_SECONDS = OPENCODE_RIG_NOW_MS / 1000;
const GO_LIMIT_RETRY_MS = 120_000;
const SHORT_RETRY_MS = 5000;
const GO_LIMIT_MESSAGE = "OpenCode Go 5 hour usage limit reached.";
const ASKED_ACTIONS = ["shell", "edit", "webfetch", "external_directory"];

const GO_LIMIT: OpencodeV2Step = {
  type: "failed",
  error: {
    type: "provider.go-limit",
    message: GO_LIMIT_MESSAGE,
    status: 429,
    retryAfterMs: GO_LIMIT_RETRY_MS,
  },
};

const SHELL_ASK: OpencodeV2Step = {
  type: "permission",
  id: "per_1",
  action: "shell",
  resources: ["ls"],
  callId: "call_1",
};

const PARTIAL_TEXT: OpencodeV2Step = {
  type: "text",
  messageId: "msg_1",
  ordinal: 0,
  delta: "partial",
};

const CANCELLED_END: AgentEvent = { type: "turn_end", stopReason: "cancelled" };

afterEach(disposeOpencodeRigs);

function typesOf(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function pathsOf(server: FakeOpencodeV2Server): string[] {
  return server.requests.map((request) => `${request.method} ${request.path}`);
}

function rateLimitEvents(message: string, retryAfterMs: number): AgentEvent[] {
  return [
    {
      type: "rate_limit",
      status: "rejected",
      resetsAt: NOW_SECONDS + retryAfterMs / 1000,
      rateLimitType: null,
      utilization: null,
    },
    { type: "turn_error", errorKind: "rate_limit", rpcCode: null, message },
  ];
}

function turnError(errorKind: string | null, message: string): AgentEvent {
  return { type: "turn_error", errorKind, rpcCode: null, message };
}

async function startedRig(profile?: PermissionProfile): Promise<{
  rig: OpencodeV2Rig;
  server: FakeOpencodeV2Server;
  handle: Awaited<ReturnType<typeof startOpencodeV2Handle>>["handle"];
  events: AgentEvent[];
}> {
  const rig = await createOpencodeV2Rig();
  const started = await startOpencodeV2Handle(rig, profile);
  return { rig, server: opencodeV2ServerOf(rig), ...started };
}

async function runScript(
  steps: readonly OpencodeV2Step[],
): Promise<{ events: AgentEvent[]; server: FakeOpencodeV2Server }> {
  const { server, handle, events } = await startedRig();
  server.enqueue(steps);
  await handle.prompt("go", { model: null });
  return { events, server };
}

function launchOf(
  rig: OpencodeV2Rig,
): Pick<SpawnSpec, "command" | "args" | "env"> &
  Pick<OpencodeStartup, "configPath" | "config"> {
  const [spec] = rig.container.specs;
  const [startup] = rig.container.startups;
  if (spec === undefined || startup === undefined) {
    throw new Error("no opencode process was started");
  }
  return { ...spec, ...startup };
}

it("starts_a_2x_server_with_the_2x_launch_and_config", async () => {
  const rig = await createOpencodeV2Rig();

  await startOpencodeV2Handle(rig);

  const launch = launchOf(rig);
  const keyFile = join(dirname(launch.configPath), "api-key");
  expect(launch.command).toBe("/usr/bin/opencode");
  expect(launch.args.slice(0, 4)).toEqual([
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
  ]);
  expect(launch.args).toHaveLength(5);
  expect(launch.env).toMatchObject({
    OPENCODE_CONFIG: launch.configPath,
    OPENCODE_PASSWORD: OPENCODE_RIG_PASSWORD,
  });
  expect(launch.env).not.toHaveProperty("OPENCODE_SERVER_PASSWORD");
  expect(launch.config).toEqual({
    model: `${PROVIDER}/${MODEL}`,
    update: "disable",
    share: "disabled",
    agents: { title: { model: `${PROVIDER}/${MODEL}` } },
    permissions: ASKED_ACTIONS.map((action) => ({
      action,
      resource: "*",
      effect: "ask",
    })),
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: PROVIDER, effect: "allow" },
    ],
    providers: { [PROVIDER]: { settings: { apiKey: `{file:${keyFile}}` } } },
  });
});

it("creates_the_session_after_the_event_stream_and_warm_up", async () => {
  const rig = await createOpencodeV2Rig();

  await startOpencodeV2Handle(rig);

  const server = opencodeV2ServerOf(rig);
  expect(pathsOf(server)).toEqual([
    "GET /api/event",
    "GET /api/provider",
    "POST /api/session",
  ]);
  expect(server.requests.every((request) => request.authorized)).toBe(true);
  expect(server.requests[2]?.body).toEqual({
    location: { directory: rig.cwd },
    agent: "build",
  });
});

it("warms_up_before_deleting_the_key_file", async () => {
  const rig = await createOpencodeV2Rig();

  await startOpencodeV2Handle(rig);

  expect(opencodeV2ServerOf(rig).warmUps).toEqual([
    { directory: rig.cwd, keyFileContent: KEY },
  ]);
  expect(await readdir(dirname(launchOf(rig).configPath))).toEqual([
    "opencode.json",
  ]);
});

it("text_turn_ends_with_end_turn", async () => {
  const { events } = await runScript([
    { type: "started" },
    { type: "step", model: MODEL },
    { type: "text", messageId: "msg_1", ordinal: 0, delta: "Hel" },
    { type: "text_ended", messageId: "msg_1", ordinal: 0, text: "Hello" },
    { type: "succeeded" },
  ]);

  expect(events).toEqual([
    { type: "model", model: MODEL },
    { type: "text", messageId: "msg_1:0", text: "Hel" },
    { type: "text", messageId: "msg_1:0", text: "lo" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);
});

it("tool_call_asks_permission_and_reports_the_tool", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    { type: "tool_input", callId: "call_1", name: "shell" },
    { type: "tool_called", callId: "call_1", input: { command: "ls" } },
    SHELL_ASK,
    { type: "tool_progress", callId: "call_1" },
    { type: "tool_success", callId: "call_1", text: "a.ts" },
    { type: "succeeded" },
  ]);
  const turn = handle.prompt("go", { model: null });

  const request = await opencodePermissionRequestOf(events);
  handle.answerPermission(request.requestId, "once");
  await turn;

  expect(request).toMatchObject({
    requestId: "per_1",
    toolCallId: "call_1",
    title: "Run command",
    kind: "execute",
    rawInput: { command: "ls" },
  });
  expect(server.replies).toEqual([
    { sessionId: OPENCODE_SESSION_ID, requestId: "per_1", decision: "once" },
  ]);
  expect(events.filter((event) => event.type !== "permission_request")).toEqual(
    [
      {
        type: "tool_call",
        toolCallId: "call_1",
        title: "shell",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      },
      { type: "tool_call_update", toolCallId: "call_1", status: "in_progress" },
      {
        type: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        output: "a.ts",
      },
      { type: "turn_end", stopReason: "end_turn" },
    ],
  );
});

it("always_reply_settles_sibling_permissions_without_replying_again", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    {
      type: "permissions",
      requests: [
        { ...SHELL_ASK, id: "per_1", callId: "call_1" },
        { ...SHELL_ASK, id: "per_2", callId: "call_2" },
        { ...SHELL_ASK, id: "per_3", callId: "call_3" },
      ],
    },
    { type: "succeeded" },
  ]);
  const turn = handle.prompt("go", { model: null });
  await settled(() => {
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(
      3,
    );
  });

  handle.answerPermission("per_1", "always");
  await turn;

  expect(events.filter((e) => e.type === "permission_settled")).toEqual([
    { type: "permission_settled", requestId: "per_2", optionId: "always" },
    { type: "permission_settled", requestId: "per_3", optionId: "always" },
  ]);
  expect(() => {
    handle.answerPermission("per_2", "once");
  }).toThrow(UnknownPermissionError);
  expect(() => {
    handle.answerPermission("per_3", "once");
  }).toThrow(UnknownPermissionError);
  await handle.stop(STOP_GRACE_MS);
  expect(server.replies).toEqual([
    { sessionId: OPENCODE_SESSION_ID, requestId: "per_1", decision: "always" },
  ]);
  expect(server.staleReplies).toEqual([]);
});

it("piped_shell_permission_shows_the_whole_command", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    { type: "tool_input", callId: "call_1", name: "shell" },
    {
      type: "tool_called",
      callId: "call_1",
      input: { command: "echo deploy-side-effect | tee -a effects.log" },
    },
    {
      type: "permission",
      id: "per_1",
      action: "shell",
      resources: ["echo deploy-side-effect", "tee -a effects.log"],
      callId: "call_1",
    },
    { type: "succeeded" },
  ]);
  const turn = handle.prompt("go", { model: null });

  const request = await opencodePermissionRequestOf(events);
  handle.answerPermission(request.requestId, "once");
  await turn;

  expect(request).toMatchObject({
    toolCallId: "call_1",
    rawInput: { command: "echo deploy-side-effect | tee -a effects.log" },
  });
});

it("go_limit_reports_the_reset_time", async () => {
  const { events } = await runScript([{ type: "started" }, GO_LIMIT]);

  expect(events).toEqual(rateLimitEvents(GO_LIMIT_MESSAGE, GO_LIMIT_RETRY_MS));
});

it("long_retry_ends_the_turn_as_rate_limited_and_interrupts", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    {
      type: "retry",
      at: OPENCODE_RIG_NOW_MS + GO_LIMIT_RETRY_MS,
      error: {
        type: "provider.rate-limit",
        message: "Rate limit exceeded",
        status: 429,
        retryAfterMs: GO_LIMIT_RETRY_MS,
      },
    },
    { type: "wait_interrupt" },
  ]);

  await handle.prompt("go", { model: null });

  expect(events).toEqual(
    rateLimitEvents("Rate limit exceeded", GO_LIMIT_RETRY_MS),
  );
  expect(server.requestsTo("POST", INTERRUPT_PATH)).toHaveLength(1);
});

it("stale_long_retry_does_not_rate_limit_the_next_turn", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([{ type: "started" }, { type: "succeeded" }]);
  await handle.prompt("first", { model: null });
  events.length = 0;
  server.enqueue([
    {
      type: "retry",
      at: OPENCODE_RIG_NOW_MS + GO_LIMIT_RETRY_MS,
      error: {
        type: "provider.rate-limit",
        message: "Rate limit exceeded",
        status: 429,
        retryAfterMs: GO_LIMIT_RETRY_MS,
      },
    },
    { type: "started" },
    { type: "step", model: MODEL },
    { type: "text", messageId: "msg_1", ordinal: 0, delta: "Hi" },
    { type: "succeeded" },
  ]);

  await handle.prompt("second", { model: null });

  expect(events).toEqual([
    { type: "model", model: MODEL },
    { type: "text", messageId: "msg_1:0", text: "Hi" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);
  expect(server.requestsTo("POST", INTERRUPT_PATH)).toHaveLength(0);
});

it("short_retry_reports_api_retry_and_continues", async () => {
  const { events } = await runScript([
    { type: "started" },
    {
      type: "retry",
      at: OPENCODE_RIG_NOW_MS + SHORT_RETRY_MS,
      error: {
        type: "provider.rate-limit",
        message: "Rate limit exceeded",
        status: 429,
        retryAfterMs: SHORT_RETRY_MS,
      },
    },
    { type: "succeeded" },
  ]);

  expect(events).toEqual([
    { type: "api_retry" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);
});

it("provider_auth_needs_login", async () => {
  const { events } = await runScript([
    { type: "started" },
    {
      type: "failed",
      error: { type: "provider.auth", message: "Invalid API key", status: 401 },
    },
  ]);

  expect(events).toEqual([turnError("auth_required", "Invalid API key")]);
});

it("provider_message_with_the_key_is_redacted", async () => {
  const { events } = await runScript([
    { type: "started" },
    {
      type: "failed",
      error: {
        type: "provider.unknown",
        message: `bad key ${KEY} for ${OPENCODE_RIG_PASSWORD}`,
      },
    },
  ]);

  expect(events).toEqual([
    turnError(null, "bad key [redacted] for [redacted]"),
  ]);
});

it("cancel_interrupts_and_ends_cancelled", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    PARTIAL_TEXT,
    { type: "wait_interrupt" },
  ]);
  const turn = handle.prompt("go", { model: null });
  await settled(() => {
    expect(typesOf(events)).toContain("text");
  });

  await handle.cancel();
  await turn;

  expect(server.requestsTo("POST", INTERRUPT_PATH)).toHaveLength(1);
  expect(events.at(-1)).toEqual(CANCELLED_END);
});

it("rejected_permission_ends_cancelled", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    SHELL_ASK,
    { type: "interrupted", reason: "shutdown" },
  ]);
  const turn = handle.prompt("go", { model: null });

  const request = await opencodePermissionRequestOf(events);
  handle.answerPermission(request.requestId, "reject");
  await turn;

  expect(server.replies[0]?.decision).toBe("reject");
  expect(events.at(-1)).toEqual(CANCELLED_END);
});

it("stale_terminal_event_does_not_end_the_next_turn", async () => {
  const { handle, events, server } = await startedRig();
  await handle.prompt("first", { model: null });
  server.enqueue([
    { type: "succeeded" },
    { type: "hold" },
    { type: "started" },
    { type: "text", messageId: "msg_2", ordinal: 0, delta: "fresh" },
    { type: "succeeded" },
  ]);

  const second = handle.prompt("second", { model: null });
  await server.untilHeld();
  expect(typesOf(events)).toEqual(["turn_end"]);
  server.release();
  await second;

  expect(typesOf(events)).toEqual(["turn_end", "text", "turn_end"]);
});

it("child_session_permission_is_answered_on_the_child", async () => {
  const { handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    { type: "child_session", id: "ses_child" },
    { ...SHELL_ASK, id: "per_child", sessionId: "ses_child" },
    { type: "succeeded" },
  ]);
  const turn = handle.prompt("go", { model: null });

  const request = await opencodePermissionRequestOf(events);
  handle.answerPermission(request.requestId, "once");
  await turn;

  expect(request.requestId).toBe("per_child");
  expect(server.replies).toEqual([
    { sessionId: "ses_child", requestId: "per_child", decision: "once" },
  ]);
});

it("stream_loss_fails_the_turn", async () => {
  const { events } = await runScript([
    { type: "started" },
    PARTIAL_TEXT,
    { type: "close_stream" },
  ]);

  expect(events).toEqual([
    { type: "text", messageId: "msg_1:0", text: "partial" },
    turnError(null, "Event stream closed"),
  ]);
});

it("process_exit_fails_the_turn", async () => {
  const { rig, handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    PARTIAL_TEXT,
    { type: "wait_interrupt" },
  ]);
  const turn = handle.prompt("go", { model: null });
  await settled(() => {
    expect(typesOf(events)).toContain("text");
  });

  rig.container.contained[0]?.emitExit(1);
  await turn;

  await settled(async () => {
    expect(await readdir(rig.runtimeRoot)).toEqual([]);
  });
  expect(events.slice(1)).toEqual([
    turnError(null, PROCESS_EXITED_MESSAGE),
    { type: "process_exit" },
  ]);
});

it("stop_rejects_pending_permissions_and_removes_run_files", async () => {
  const { rig, handle, events, server } = await startedRig();
  server.enqueue([
    { type: "started" },
    { ...SHELL_ASK, id: "per_3" },
    { type: "wait_interrupt" },
  ]);
  const turn = handle.prompt("go", { model: null });
  await opencodePermissionRequestOf(events);

  await handle.stop(STOP_GRACE_MS);
  await turn;

  expect(server.replies).toEqual([
    { sessionId: OPENCODE_SESSION_ID, requestId: "per_3", decision: "reject" },
  ]);
  expect(server.requestsTo("POST", INTERRUPT_PATH)).toHaveLength(1);
  expect(await readdir(rig.runtimeRoot)).toEqual([]);
  expect(events.at(-1)).toEqual({ type: "process_exit" });
});

it("profile_change_switches_the_agent", async () => {
  const { handle, server } = await startedRig(PermissionProfile.ask);

  await handle.prompt("one", { model: null });
  await handle.setProfile(PermissionProfile.plan);
  await handle.prompt("two", { model: null });
  await handle.setProfile(PermissionProfile.ask);
  await handle.prompt("three", { model: null });

  expect(
    pathsOf(server).filter((path) => path !== "GET /api/session/active"),
  ).toEqual([
    "GET /api/event",
    "GET /api/provider",
    "POST /api/session",
    `POST ${PROMPT_PATH}`,
    `POST ${AGENT_PATH}`,
    `POST ${PROMPT_PATH}`,
    `POST ${AGENT_PATH}`,
    `POST ${PROMPT_PATH}`,
  ]);
  expect(server.requestsTo("POST", AGENT_PATH).map((r) => r.body)).toEqual([
    { agent: "plan" },
    { agent: "build" },
  ]);
});

it("model_override_switches_and_restores_the_model", async () => {
  const { handle, server } = await startedRig();

  await handle.prompt("one", { model: OTHER_MODEL });
  await handle.prompt("two", { model: null });
  await handle.prompt("three", { model: null });

  expect(server.requestsTo("POST", MODEL_PATH).map((r) => r.body)).toEqual([
    { model: { id: OTHER_MODEL, providerID: PROVIDER } },
    { model: { id: MODEL, providerID: PROVIDER } },
  ]);
});

it("busy_session_is_interrupted_before_the_prompt", async () => {
  const { handle, events, server } = await startedRig();
  server.setActive(true);

  await handle.prompt("go", { model: null });

  const paths = pathsOf(server);
  expect(paths.indexOf(`POST ${INTERRUPT_PATH}`)).toBeGreaterThan(-1);
  expect(paths.indexOf(`POST ${INTERRUPT_PATH}`)).toBeLessThan(
    paths.indexOf(`POST ${PROMPT_PATH}`),
  );
  expect(events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
});

const CONSOLE_CREDENTIALS: OpencodeCredentials = {
  auth: "console_login",
  providerId: "opencode-go",
  model: OTHER_MODEL,
  baseUrl: null,
};

it("console_login_logged_out_start_is_refused_with_needs_login_and_no_process", async () => {
  const rig = await createOpencodeV2Rig({
    credentials: CONSOLE_CREDENTIALS,
    consoleLoginFor: () => Promise.resolve(ConsoleLoginState.needsLogin),
  });

  const result = await rig.start();

  expect(result).toEqual({
    ok: false,
    reason: "needs_login",
    message: "OpenCode Console login required",
  });
  expect(rig.container.specs).toEqual([]);
});

it("console_login_probe_failure_still_starts_the_run", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await createOpencodeV2Rig({
    credentials: CONSOLE_CREDENTIALS,
    consoleLoginFor: () => Promise.resolve(ConsoleLoginState.failed),
  });

  const result = await rig.start();

  expect(result.ok).toBe(true);
  expect(rig.container.specs).toHaveLength(1);
});

it("session_that_stays_busy_fails_the_turn", async () => {
  const { handle, events, server } = await startedRig();
  server.setActive(true);
  server.interruptOutcome = [];

  await handle.prompt("go", { model: null });

  expect(server.requestsTo("POST", PROMPT_PATH)).toEqual([]);
  expect(events).toEqual([turnError(null, "OpenCode session is still busy")]);
});
