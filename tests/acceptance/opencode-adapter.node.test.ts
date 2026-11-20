import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InvalidOptionError,
  TurnInProgressError,
  UnknownPermissionError,
  type AgentHandle,
} from "../../src/backend/agentAdapter";
import { PROCESS_EXITED_MESSAGE } from "../../src/backend/constants";
import type { AgentEvent } from "../../src/domain/events";
import { createRateLimitDetector } from "../../src/domain/rateLimit";
import { ApiProviderId } from "../../src/domain/apiProviders";
import { PermissionProfile, type ApiAccount } from "../../src/domain/types";
import {
  OPENCODE_RIG_NOW_MS,
  OPENCODE_RIG_PASSWORD,
  OPENCODE_SESSION_ID,
  createOpencodeRig,
  disposeOpencodeRigs,
  opencodePermissionRequestOf,
  opencodeServerOf,
  startOpencodeHandle,
  type OpencodeRig,
  type OpencodeStep,
} from "../fakes/fakeOpencodeServer";

const NOW_SECONDS = 1_700_000_000;
const COOLDOWN_SECONDS = 3600;
const TWO_HOURS_MS = 7_200_000;
const SHORT_RETRY_MS = 5000;
const SHORT_READY_TIMEOUT_MS = 50;
const STOP_GRACE_MS = 100;
const PROMPT_PATH = `/session/${OPENCODE_SESSION_ID}/prompt_async`;
const ABORT_PATH = `/session/${OPENCODE_SESSION_ID}/abort`;
const KEY = "sk-test-A";

const RATE_LIMITED: OpencodeStep = {
  type: "error",
  name: "APIError",
  message: "Rate limit exceeded",
  statusCode: 429,
  headers: { "retry-after": "120" },
};

afterEach(disposeOpencodeRigs);

function typesOf(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function isRequest(type: string): boolean {
  return type === "permission_request";
}

const BASH_TOOL = {
  type: "tool",
  callId: "call_1",
  tool: "bash",
  input: { command: "ls" },
} as const;

function rateLimitedBy(headers: Record<string, string>): OpencodeStep {
  return {
    type: "error",
    name: "APIError",
    message: "Rate limit exceeded",
    statusCode: 429,
    headers,
  };
}

async function runScript(
  rig: OpencodeRig,
  steps: readonly OpencodeStep[],
  profile: PermissionProfile = PermissionProfile.ask,
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const started = await startOpencodeHandle(rig, profile);
  opencodeServerOf(rig).enqueue(steps);
  await started.handle.prompt("go", { model: null });
  return started;
}

function settleWithDetector(events: readonly AgentEvent[]): unknown {
  const detector = createRateLimitDetector(() => OPENCODE_RIG_NOW_MS);
  events.forEach((event) => {
    detector.observe(event);
  });
  return detector.settle();
}

async function runDirEntries(rig: OpencodeRig): Promise<string[]> {
  return readdir(rig.runtimeRoot);
}

describe("opencode adapter: launch and secrets", () => {
  it("spawn_env_has_isolation_flags_and_no_key", async () => {
    const rig = await createOpencodeRig();

    await startOpencodeHandle(rig);

    const spec = rig.container.specs[0];
    const startup = rig.container.startups[0];
    expect(spec?.command).toBe("/usr/bin/opencode");
    expect(spec?.args.slice(0, 3)).toEqual([
      "serve",
      "--hostname",
      "127.0.0.1",
    ]);
    expect(spec?.args[3]).toBe("--port");
    expect(spec?.args.slice(5)).toEqual(["--pure"]);
    expect(spec?.env).toEqual({
      PATH: "/usr/bin",
      OPENCODE_TEST_HOME: join(rig.accountDir, "home"),
      XDG_CONFIG_HOME: join(rig.accountDir, "config"),
      XDG_DATA_HOME: join(rig.accountDir, "data"),
      XDG_CACHE_HOME: join(rig.accountDir, "cache"),
      XDG_STATE_HOME: join(rig.accountDir, "state"),
      OPENCODE_CONFIG: startup?.configPath,
      OPENCODE_SERVER_PASSWORD: OPENCODE_RIG_PASSWORD,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    });
    expect(Object.values(spec?.env ?? {}).join("\n")).not.toContain(KEY);
    expect((await stat(join(rig.accountDir, "home"))).isDirectory()).toBe(true);
  });
});

describe("opencode adapter: console login on 1.x", () => {
  it("v1 console refusal is a needs-login failure", async () => {
    const rig = await createOpencodeRig({
      credentials: {
        auth: "console_login",
        providerId: "opencode-go",
        model: "kimi-k2.7-code",
        baseUrl: null,
      },
    });

    const result = await rig.start();

    expect(result).toEqual({
      ok: false,
      reason: "needs_login",
      message:
        "OpenCode Console login needs opencode 2.2.5 or newer. Update opencode or use an API key.",
    });
    expect(rig.container.specs).toEqual([]);
  });
});

describe("opencode adapter: run files", () => {
  it("config_and_key_file_lifecycle", async () => {
    const rig = await createOpencodeRig();

    const { handle } = await startOpencodeHandle(rig);

    const startup = rig.container.startups[0];
    const runDir = dirname(startup?.configPath ?? "");
    expect(startup?.config).toEqual({
      enabled_providers: ["groq"],
      model: "groq/llama-3.3-70b",
      small_model: "groq/llama-3.3-70b",
      autoupdate: false,
      share: "disabled",
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        external_directory: "ask",
      },
      provider: {
        groq: {
          options: { apiKey: `{file:${join(runDir, "api-key")}}` },
        },
      },
    });
    expect(startup?.keyFileContent).toBe(KEY);
    expect(await readdir(runDir)).toEqual(["opencode.json"]);

    await handle.stop(STOP_GRACE_MS);

    expect(await runDirEntries(rig)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "key_file_is_0600_in_0700_dir",
    async () => {
      const rig = await createOpencodeRig();

      await startOpencodeHandle(rig);

      expect(rig.container.startups[0]?.keyFileMode).toBe(0o600);
      expect(rig.container.startups[0]?.runDirMode).toBe(0o700);
    },
  );
});

describe("opencode adapter: start protocol", () => {
  it("start_requests_are_ordered_authorized_and_scoped_to_cwd", async () => {
    const rig = await createOpencodeRig();

    await startOpencodeHandle(rig);

    const { requests } = opencodeServerOf(rig);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /event",
      "GET /config",
      "POST /session",
    ]);
    expect(requests.every((r) => r.authorized)).toBe(true);
    expect(requests.every((r) => r.query.directory === rig.cwd)).toBe(true);
  });

  it("missing_credentials_fail_needs_login_without_spawning", async () => {
    const rig = await createOpencodeRig({ credentials: null });

    const result = await rig.start();

    expect(result).toMatchObject({ ok: false, reason: "needs_login" });
    expect(rig.container.specs).toEqual([]);
    expect(await runDirEntries(rig)).toEqual([]);
  });
});

describe("opencode adapter: start failures", () => {
  it("early_exit_cleans_key_file", async () => {
    const rig = await createOpencodeRig();
    rig.container.config.exitBeforeListening = true;
    rig.container.config.stderrText = `fatal: bad key ${KEY} and ${OPENCODE_RIG_PASSWORD}`;

    const result = await rig.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.message).toContain(PROCESS_EXITED_MESSAGE);
      expect(result.message).toContain(
        "fatal: bad key [redacted] and [redacted]",
      );
      expect(result.message).not.toContain(KEY);
    }
    expect(await runDirEntries(rig)).toEqual([]);
    expect(rig.container.contained[0]?.stopCalls.length).toBeGreaterThan(0);
    expect(await rig.container.contained[0]?.isEmpty()).toBe(true);
  });

  it("missing_listening_line_times_out_and_cleans_up", async () => {
    const rig = await createOpencodeRig({
      readyTimeoutMs: SHORT_READY_TIMEOUT_MS,
    });
    rig.container.config.silent = true;

    const result = await rig.start();

    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: "opencode server did not start in time",
    });
    expect(rig.container.contained[0]?.stopCalls.length).toBeGreaterThan(0);
    expect(await runDirEntries(rig)).toEqual([]);
  });
});

describe("opencode adapter: event mapping", () => {
  it("text_and_tool_events_map_with_call_id", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      { type: "text", partId: "prt_a", text: "Hel" },
      { type: "text", partId: "prt_a", text: "Hello" },
      { ...BASH_TOOL, status: "pending" },
      { ...BASH_TOOL, status: "running", title: "ls" },
      { ...BASH_TOOL, status: "completed", output: "a.txt", title: "ls" },
      { type: "idle" },
    ]);

    expect(events).toEqual([
      { type: "text", messageId: "prt_a", text: "Hel" },
      { type: "text", messageId: "prt_a", text: "lo" },
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
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("opencode adapter: stream filtering", () => {
  it("foreign_and_unknown_events_ignored", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      {
        type: "raw",
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              id: "prt_x",
              sessionID: "ses_other",
              text: "leak",
            },
          },
        },
      },
      { type: "raw", event: { type: "totally.unknown", properties: {} } },
      {
        type: "raw",
        event: {
          type: "session.idle",
          properties: { sessionID: "ses_other" },
        },
      },
      { type: "text", partId: "prt_b", text: "mine" },
      { type: "idle" },
    ]);

    expect(events).toEqual([
      { type: "text", messageId: "prt_b", text: "mine" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("opencode adapter: permissions", () => {
  it("bash_permission_round_trips_the_chosen_response", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      {
        type: "permission",
        id: "per_1",
        permission: "bash",
        patterns: ["rm -rf build"],
        metadata: { command: "rm -rf build" },
        callId: "call_9",
      },
      { type: "idle" },
    ]);

    const turn = handle.prompt("go", { model: null });
    const request = await opencodePermissionRequestOf(events);

    expect(request).toEqual({
      type: "permission_request",
      requestId: "per_1",
      toolCallId: "call_9",
      title: "Run command",
      kind: "execute",
      rawInput: { command: "rm -rf build" },
      locations: [],
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(() => {
      handle.answerPermission("per_1", "bogus");
    }).toThrow(InvalidOptionError);
    expect(() => {
      handle.answerPermission("per_missing", "once");
    }).toThrow(UnknownPermissionError);
    handle.answerPermission("per_1", "always");
    await turn;
    expect(server.replies).toEqual([
      {
        sessionId: OPENCODE_SESSION_ID,
        permissionId: "per_1",
        response: "always",
      },
    ]);
    expect(
      server.requestsTo(
        "POST",
        `/session/${OPENCODE_SESSION_ID}/permissions/per_1`,
      )[0]?.body,
    ).toEqual({ response: "always" });
  });
});

describe("opencode adapter: edit permissions", () => {
  it("edit_permission_carries_absolute_path", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    opencodeServerOf(rig).enqueue([
      {
        type: "permission",
        id: "per_2",
        permission: "edit",
        patterns: ["src/a.ts", "docs/b.md"],
        metadata: { filepath: join(rig.cwd, "src/a.ts") },
      },
      { type: "idle" },
    ]);

    const turn = handle.prompt("go", { model: null });
    const request = await opencodePermissionRequestOf(events);
    handle.answerPermission("per_2", "once");
    await turn;

    expect(request).toMatchObject({
      title: "Edit file",
      kind: "edit",
      rawInput: { file_path: join(rig.cwd, "src/a.ts") },
      locations: [join(rig.cwd, "src/a.ts"), join(rig.cwd, "docs/b.md")],
    });
  });
});

describe("opencode adapter: permissions settled by opencode", () => {
  it("always_reply_settles_sibling_permissions_without_replying_again", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    const ask = (
      id: string,
    ): Extract<OpencodeStep, { type: "permission" }> => ({
      type: "permission",
      id,
      permission: "bash",
      patterns: ["ls"],
      metadata: { command: "ls" },
    });
    server.enqueue([
      {
        type: "permissions",
        requests: [ask("per_1"), ask("per_2"), ask("per_3")],
      },
      { type: "idle" },
    ]);
    const turn = handle.prompt("go", { model: null });
    await vi.waitFor(() => {
      expect(typesOf(events).filter(isRequest)).toHaveLength(3);
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
      {
        sessionId: OPENCODE_SESSION_ID,
        permissionId: "per_1",
        response: "always",
      },
    ]);
    expect(server.staleReplies).toEqual([]);
  });
});

describe("opencode adapter: permissions during stop", () => {
  it("permission_after_stop_is_rejected", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([{ type: "wait_abort" }, { type: "idle" }]);
    server.onAbort(async () => {
      server.emitPermissionAsked({
        type: "permission",
        id: "per_late",
        permission: "bash",
        patterns: ["ls"],
        metadata: { command: "ls" },
      });
      await server.nextReply();
    });
    const turn = handle.prompt("go", { model: null });
    await vi.waitFor(() => {
      expect(server.requestsTo("POST", PROMPT_PATH)).toHaveLength(1);
    });

    await handle.stop(STOP_GRACE_MS);
    await turn;

    expect(server.replies).toEqual([
      {
        sessionId: OPENCODE_SESSION_ID,
        permissionId: "per_late",
        response: "reject",
      },
    ]);
    expect(typesOf(events)).not.toContain("permission_request");
  });
});

describe("opencode adapter: pending permissions at stop", () => {
  it("stop_rejects_pending_permissions", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      {
        type: "permission",
        id: "per_3",
        permission: "bash",
        patterns: ["ls"],
        metadata: { command: "ls" },
      },
      { type: "idle" },
    ]);
    const turn = handle.prompt("go", { model: null });
    await opencodePermissionRequestOf(events);

    await handle.stop(STOP_GRACE_MS);
    await turn;

    expect(server.replies).toEqual([
      {
        sessionId: OPENCODE_SESSION_ID,
        permissionId: "per_3",
        response: "reject",
      },
    ]);
  });
});

describe("opencode adapter: exhaustion", () => {
  it("terminal_429_after_tool_is_rate_limit_then_turn_error", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      {
        type: "tool",
        callId: "call_1",
        tool: "read",
        status: "completed",
        input: { filePath: "a.ts" },
        output: "x",
      },
      RATE_LIMITED,
      { type: "idle" },
    ]);

    expect(events.slice(1)).toEqual([
      {
        type: "rate_limit",
        status: "rejected",
        resetsAt: NOW_SECONDS + 120,
        rateLimitType: null,
        utilization: null,
      },
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: "Rate limit exceeded",
      },
    ]);
    expect(settleWithDetector(events)).toEqual({
      kind: "exhausted",
      resetsAt: NOW_SECONDS + 120,
      rateLimitType: null,
    });
  });
});

describe("opencode adapter: reset headers", () => {
  it.each([
    ["retry_after_seconds", { "retry-after": "30" }, NOW_SECONDS + 30],
    [
      "retry_after_http_date",
      { "retry-after": "Tue, 14 Nov 2023 22:15:20 GMT" },
      NOW_SECONDS + 120,
    ],
    [
      "ratelimit_reset_epoch_millis",
      { "x-ratelimit-reset-requests": "1700000300000" },
      NOW_SECONDS + 300,
    ],
    [
      "ratelimit_reset_go_duration",
      { "x-ratelimit-reset-tokens": "2m59.5s" },
      NOW_SECONDS + 180,
    ],
    ["no_reset_header", {}, null],
  ])(
    "reset_header_variants_%s",
    async (_name, headers: Record<string, string>, resetsAt: number | null) => {
      const rig = await createOpencodeRig();

      const { events } = await runScript(rig, [
        rateLimitedBy(headers),
        { type: "idle" },
      ]);

      expect(events[0]).toMatchObject({ type: "rate_limit", resetsAt });
      expect(settleWithDetector(events)).toMatchObject({
        kind: "exhausted",
        resetsAt: resetsAt ?? NOW_SECONDS + COOLDOWN_SECONDS,
      });
    },
  );
});

describe("opencode adapter: long retry", () => {
  it("long_retry_wait_is_exhaustion", async () => {
    const rig = await createOpencodeRig();
    const next = OPENCODE_RIG_NOW_MS + TWO_HOURS_MS;

    const { events } = await runScript(rig, [
      { type: "retry", next, message: "Rate limit exceeded" },
      { type: "wait_abort" },
      {
        type: "error",
        name: "MessageAbortedError",
        message: "The operation was aborted",
      },
      { type: "idle" },
    ]);

    expect(opencodeServerOf(rig).requestsTo("POST", ABORT_PATH)).toHaveLength(
      1,
    );
    expect(events).toEqual([
      {
        type: "rate_limit",
        status: "rejected",
        resetsAt: NOW_SECONDS + TWO_HOURS_MS / 1000,
        rateLimitType: null,
        utilization: null,
      },
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: "Rate limit exceeded",
      },
    ]);
  });
});

describe("opencode adapter: other failures", () => {
  it("short_retry_wait_is_only_api_retry", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      {
        type: "retry",
        next: OPENCODE_RIG_NOW_MS + SHORT_RETRY_MS,
        message: "Rate limit exceeded",
      },
      { type: "idle" },
    ]);

    expect(events).toEqual([
      { type: "api_retry" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(opencodeServerOf(rig).requestsTo("POST", ABORT_PATH)).toEqual([]);
  });

  it("unauthorized_is_auth_required_and_needs_login", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      {
        type: "error",
        name: "APIError",
        message: "Invalid API key",
        statusCode: 401,
      },
      { type: "idle" },
    ]);

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: "auth_required",
        rpcCode: null,
        message: "Invalid API key",
      },
    ]);
    expect(settleWithDetector(events)).toEqual({ kind: "needs_login" });
  });

  it("provider_error_message_never_carries_the_key", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      {
        type: "error",
        name: "APIError",
        message: `upstream said ${KEY} is bad`,
        statusCode: 500,
      },
      { type: "idle" },
    ]);

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "upstream said [redacted] is bad",
      },
    ]);
  });
});

const GROQ_API: ApiAccount = {
  provider: ApiProviderId.groq,
  model: "llama-3.3-70b-versatile",
  baseUrl: null,
  rotation: true,
  auth: "api_key",
};

describe("opencode adapter: model selection", () => {
  it("model reaches opencode prompt body", async () => {
    const rig = await createOpencodeRig({ api: GROQ_API });
    const { handle } = await startOpencodeHandle(rig);

    await handle.prompt("go", { model: "openai/gpt-oss-20b" });

    const [request] = opencodeServerOf(rig).requestsTo("POST", PROMPT_PATH);
    expect(request?.body).toEqual({
      parts: [{ type: "text", text: "go" }],
      agent: expect.any(String) as string,
      model: { providerID: "groq", modelID: "openai/gpt-oss-20b" },
    });
  });

  it("null model omits the prompt model", async () => {
    const rig = await createOpencodeRig({ api: GROQ_API });
    const { handle } = await startOpencodeHandle(rig);

    await handle.prompt("go", { model: null });

    const [request] = opencodeServerOf(rig).requestsTo("POST", PROMPT_PATH);
    expect(request?.body).toEqual({
      parts: [{ type: "text", text: "go" }],
      agent: expect.any(String) as string,
    });
  });

  it("rejected model fails the turn without a rate limit", async () => {
    const rig = await createOpencodeRig({ api: GROQ_API });
    const { handle, events } = await startOpencodeHandle(rig);
    opencodeServerOf(rig).enqueue([
      {
        type: "error",
        name: "ProviderModelNotFoundError",
        message: "Model not found: groq/nonsense",
      },
      { type: "idle" },
    ]);

    await handle.prompt("go", { model: "nonsense" });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: "Model not found: groq/nonsense",
    });
    expect(settleWithDetector(events)).toEqual({
      kind: "failed",
      message: "Model not found: groq/nonsense",
    });
  });
});

describe("opencode adapter: model reporting", () => {
  it("adapter reports the assistant model", async () => {
    const rig = await createOpencodeRig({ api: GROQ_API });
    const { handle, events } = await startOpencodeHandle(rig);
    opencodeServerOf(rig).assistantModel = {
      providerID: "groq",
      modelID: "openai/gpt-oss-20b",
    };

    await handle.prompt("one", { model: null });
    await handle.prompt("two", { model: null });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "openai/gpt-oss-20b" },
      { type: "model", model: "openai/gpt-oss-20b" },
    ]);
  });

  it("opencode reports the model on every turn", async () => {
    const rig = await createOpencodeRig({ api: GROQ_API });
    const { handle, events } = await startOpencodeHandle(rig);
    opencodeServerOf(rig).assistantModel = {
      providerID: "groq",
      modelID: "openai/gpt-oss-20b",
    };

    await handle.prompt("one", { model: null });
    await handle.prompt("two", { model: null });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "openai/gpt-oss-20b" },
      { type: "model", model: "openai/gpt-oss-20b" },
    ]);
  });
});

describe("opencode adapter: stale model reports", () => {
  it("late model event from a cancelled turn is not reported on the next turn", async () => {
    const rig = await createOpencodeRig({ api: GROQ_API });
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.assistantModel = { providerID: "groq", modelID: "model-a" };
    server.enqueue([{ type: "wait_abort" }, { type: "idle" }]);
    const first = handle.prompt("one", { model: null });
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "model", model: "model-a" });
    });
    await handle.cancel();
    await first;
    const seen = events.length;
    server.assistantModel = { providerID: "groq", modelID: "model-b" };
    server.enqueue([
      { type: "slow_user_message", ms: SLOW_USER_MESSAGE_MS },
      {
        type: "raw",
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_1",
              role: "assistant",
              sessionID: OPENCODE_SESSION_ID,
              providerID: "groq",
              modelID: "model-a",
            },
          },
        },
      },
      { type: "wait", ms: SLOW_USER_MESSAGE_MS * 2 },
      { type: "idle" },
    ]);

    await handle.prompt("two", { model: null });

    expect(
      events.slice(seen).filter((event) => event.type === "model"),
    ).toEqual([{ type: "model", model: "model-b" }]);
  });
});

describe("opencode adapter: turn lifecycle", () => {
  it("cancel_aborts_and_ends_turn_cancelled", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      { type: "text", partId: "prt_a", text: "working" },
      { type: "wait_abort" },
      { type: "idle" },
    ]);
    const turn = handle.prompt("go", { model: null });
    await vi.waitFor(() => {
      expect(typesOf(events)).toContain("text");
    });

    await handle.cancel();
    await turn;

    expect(server.requestsTo("POST", ABORT_PATH)).toHaveLength(1);
    expect(events.slice(1)).toEqual([
      { type: "turn_end", stopReason: "cancelled" },
    ]);
  });

  it("second_prompt_during_turn_is_rejected", async () => {
    const rig = await createOpencodeRig();
    const { handle } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([{ type: "wait_abort" }, { type: "idle" }]);
    const turn = handle.prompt("first", { model: null });

    await expect(
      handle.prompt("second", { model: null }),
    ).rejects.toBeInstanceOf(TurnInProgressError);

    await handle.cancel();
    await turn;
  });
});

describe("opencode adapter: process lifecycle", () => {
  it("process_exit_mid_turn_is_turn_error_then_process_exit", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    opencodeServerOf(rig).enqueue([
      { type: "text", partId: "prt_a", text: "partial" },
      { type: "hang" },
    ]);
    const turn = handle.prompt("go", { model: null });
    await vi.waitFor(() => {
      expect(typesOf(events)).toContain("text");
    });

    rig.container.contained[0]?.emitExit(1);
    await turn;

    await vi.waitFor(async () => {
      expect(await runDirEntries(rig)).toEqual([]);
    });
    expect(events.slice(1)).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: PROCESS_EXITED_MESSAGE,
      },
      { type: "process_exit" },
    ]);
  });

  it("stop_emits_process_exit_once_after_cleanup", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);

    await handle.stop(STOP_GRACE_MS);
    await handle.stop(STOP_GRACE_MS);

    expect(events).toEqual([{ type: "process_exit" }]);
    expect(await runDirEntries(rig)).toEqual([]);
  });
});

describe("opencode adapter: profiles", () => {
  it.each([
    [PermissionProfile.plan, "plan"],
    [PermissionProfile.ask, "build"],
    [PermissionProfile.bypass, "build"],
  ])("profile_%s_prompts_agent_%s", async (profile, agent) => {
    const rig = await createOpencodeRig();

    await runScript(rig, [{ type: "idle" }], profile);

    expect(
      opencodeServerOf(rig).requestsTo("POST", PROMPT_PATH)[0]?.body,
    ).toEqual({ parts: [{ type: "text", text: "go" }], agent });
  });

  it("set_profile_applies_to_the_next_prompt", async () => {
    const rig = await createOpencodeRig();
    const { handle } = await startOpencodeHandle(rig, PermissionProfile.ask);

    await handle.setProfile(PermissionProfile.plan);
    await handle.prompt("go", { model: null });

    expect(
      opencodeServerOf(rig).requestsTo("POST", PROMPT_PATH)[0]?.body,
    ).toMatchObject({ agent: "plan" });
  });
});

const BOOM: OpencodeStep = {
  type: "error",
  name: "UnknownError",
  message: "boom",
};
const STALE_IDLE_DELAY_MS = 40;
const NEXT_TURN_DELAY_MS = 120;
const SETTLE_WINDOW_MS = 1500;
const CHILD_SESSION_ID = "ses_child";
const GRANDCHILD_SESSION_ID = "ses_grandchild";
const SESSION_BUSY_MESSAGE = "OpenCode session is still busy";
const LEAKED_PAYLOAD = "sk-test-LEAK is not json";

type Settled<T> =
  { readonly settled: true; readonly value: T } | { readonly settled: false };

async function settlesWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<Settled<T>> {
  return Promise.race([
    promise.then((value): Settled<T> => ({ settled: true, value })),
    new Promise<Settled<T>>((resolve) =>
      setTimeout(() => {
        resolve({ settled: false });
      }, ms),
    ),
  ]);
}

function childEvent(
  type: string,
  sessionID: string,
  extra: Record<string, unknown> = {},
): OpencodeStep {
  return { type: "raw", event: { type, properties: { sessionID, ...extra } } };
}

function bashPermission(id: string, sessionId?: string): OpencodeStep {
  return {
    type: "permission",
    id,
    permission: "bash",
    patterns: ["ls"],
    metadata: { command: "ls" },
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function permissionRequestsIn(
  events: readonly AgentEvent[],
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      typesOf(events).filter((type) => type === "permission_request"),
    ).toHaveLength(count);
  });
}

const CHILD_NOISE: readonly OpencodeStep[] = [
  { type: "child_session", id: CHILD_SESSION_ID },
  {
    type: "child_session",
    id: GRANDCHILD_SESSION_ID,
    parentId: CHILD_SESSION_ID,
  },
  childEvent("session.error", CHILD_SESSION_ID, {
    error: { name: "UnknownError", data: { message: "child boom" } },
  }),
  childEvent("session.idle", CHILD_SESSION_ID),
  childEvent("message.part.updated", CHILD_SESSION_ID, {
    part: {
      type: "text",
      id: "prt_child",
      sessionID: CHILD_SESSION_ID,
      messageID: "msg_child",
      text: "child text",
    },
  }),
];

describe("opencode adapter: stale idle", () => {
  it("stale_idle_after_error_does_not_end_next_turn", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      BOOM,
      { type: "wait", ms: STALE_IDLE_DELAY_MS },
      { type: "idle" },
    ]);
    server.enqueue([
      { type: "wait", ms: NEXT_TURN_DELAY_MS },
      { type: "text", partId: "prt_second", text: "second" },
      { type: "idle" },
    ]);
    await handle.prompt("first", { model: null });
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([
      { type: "text", messageId: "prt_second", text: "second" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });

  it("busy_session_after_abort_fails_turn_without_prompt", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([BOOM, { type: "hang" }]);
    await handle.prompt("first", { model: null });
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: SESSION_BUSY_MESSAGE,
      },
    ]);
    expect(server.requestsTo("POST", PROMPT_PATH)).toHaveLength(1);
    expect(server.requestsTo("POST", ABORT_PATH)).toHaveLength(1);
  });
});

const CANCEL_IDLE_GRACE_MS = 200;
const CANCEL_STALE_IDLE_DELAY_MS = 300;
const TIMEOUT_IDLE_GRACE_MS = 400;
const TIMEOUT_RUN_DELAY_MS = 250;
const TIMEOUT_NEXT_TURN_DELAY_MS = 200;
const SLOW_WARM_UP_MS = 300;
const LATE_IDLE_NEXT_TURN_DELAY_MS = 100;
const SLOW_USER_MESSAGE_MS = 100;

describe("opencode adapter: cancelled turn waiting for idle", () => {
  it("cancel_during_idle_wait_does_not_send_prompt", async () => {
    const rig = await createOpencodeRig({ stopGraceMs: CANCEL_IDLE_GRACE_MS });
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      BOOM,
      { type: "wait", ms: CANCEL_STALE_IDLE_DELAY_MS },
      { type: "idle" },
    ]);
    await handle.prompt("first", { model: null });
    events.length = 0;

    const second = handle.prompt("second", { model: null });
    await handle.cancel();
    await second;

    expect(server.requestsTo("POST", PROMPT_PATH)).toHaveLength(1);
    expect(events).toEqual([{ type: "turn_end", stopReason: "cancelled" }]);
  });
});

describe("opencode adapter: prompt timeout", () => {
  it("late_idle_after_prompt_timeout_does_not_end_next_turn", async () => {
    const rig = await createOpencodeRig({ stopGraceMs: TIMEOUT_IDLE_GRACE_MS });
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.acceptNextPromptWithoutReply();
    server.enqueue([
      { type: "wait", ms: TIMEOUT_RUN_DELAY_MS },
      { type: "idle" },
    ]);
    server.enqueue([
      { type: "wait", ms: TIMEOUT_NEXT_TURN_DELAY_MS },
      { type: "text", partId: "prt_second", text: "second" },
      { type: "idle" },
    ]);
    await handle.prompt("first", { model: null });
    expect(typesOf(events)).toEqual(["turn_error"]);
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([
      { type: "text", messageId: "prt_second", text: "second" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(server.requestsTo("POST", PROMPT_PATH)).toHaveLength(2);
  });
});

describe("opencode adapter: unaccepted prompt timeout", () => {
  it("prompt_after_unaccepted_timeout_is_sent", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.stall("prompt");
    await handle.prompt("first", { model: null });
    expect(typesOf(events)).toEqual(["turn_error"]);
    server.unstall("prompt");
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
    expect(server.requestsTo("POST", PROMPT_PATH)).toHaveLength(2);
  });
});

describe("opencode adapter: late idle after unaccepted timeout", () => {
  it("late_idle_after_unaccepted_timeout_does_not_end_next_turn", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.acceptNextPromptWithoutReply();
    server.enqueue([{ type: "late_idle", afterPrompts: 2 }]);
    server.enqueue([
      { type: "wait", ms: LATE_IDLE_NEXT_TURN_DELAY_MS },
      { type: "text", partId: "prt_second", text: "second" },
      { type: "idle" },
    ]);
    await handle.prompt("first", { model: null });
    expect(typesOf(events)).toEqual(["turn_error"]);
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([
      { type: "text", messageId: "prt_second", text: "second" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("opencode adapter: trailing idle after rate limit", () => {
  it("trailing_idle_after_rate_limit_does_not_end_next_turn", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      RATE_LIMITED,
      { type: "idle" },
      { type: "late_idle", afterPrompts: 2 },
    ]);
    server.enqueue([
      { type: "wait", ms: LATE_IDLE_NEXT_TURN_DELAY_MS },
      { type: "text", partId: "prt_second", text: "second" },
      { type: "idle" },
    ]);
    await handle.prompt("first", { model: null });
    expect(typesOf(events)).toEqual(["rate_limit", "turn_error"]);
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([
      { type: "text", messageId: "prt_second", text: "second" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("opencode adapter: prompt rejected before user message", () => {
  it("prompt_rejected_before_user_message_fails_turn", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([{ type: "reject_prompt", message: "Agent not found" }]);
    await handle.prompt("first", { model: null });
    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "Agent not found",
      },
    ]);
    events.length = 0;

    await handle.prompt("second", { model: null });

    expect(events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
    expect(server.requestsTo("POST", PROMPT_PATH)).toHaveLength(2);
  });
});

describe("opencode adapter: slow user message", () => {
  it("slow_user_message_does_not_fail_turn_with_stale_error", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      { type: "slow_user_message", ms: SLOW_USER_MESSAGE_MS },
      {
        type: "error",
        name: "UnknownError",
        message: "stale trailing error",
      },
      { type: "wait", ms: SLOW_USER_MESSAGE_MS * 2 },
      { type: "text", partId: "prt_slow", text: "slow" },
      { type: "idle" },
    ]);

    await handle.prompt("first", { model: null });

    expect(events).toEqual([
      { type: "text", messageId: "prt_slow", text: "slow" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("opencode adapter: echoed messages", () => {
  it("user_prompt_is_not_echoed", async () => {
    const rig = await createOpencodeRig();

    const { events } = await runScript(rig, [
      { type: "text", partId: "prt_a", text: "Hel" },
      { type: "text", partId: "prt_s", text: "hint", synthetic: true },
      { type: "text", partId: "prt_a", text: "Hello" },
      { type: "idle" },
    ]);

    expect(events).toEqual([
      { type: "text", messageId: "prt_a", text: "Hel" },
      { type: "text", messageId: "prt_a", text: "lo" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("opencode adapter: child sessions", () => {
  it("child_session_permission_is_answered_on_child", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      ...CHILD_NOISE,
      bashPermission("per_child", CHILD_SESSION_ID),
      bashPermission("per_grandchild", GRANDCHILD_SESSION_ID),
      { type: "text", partId: "prt_parent", text: "parent" },
      { type: "idle" },
    ]);
    const turn = handle.prompt("go", { model: null });

    await permissionRequestsIn(events, 1);
    handle.answerPermission("per_child", "once");
    await permissionRequestsIn(events, 2);
    handle.answerPermission("per_grandchild", "always");
    await turn;

    expect(server.replies).toEqual([
      {
        sessionId: CHILD_SESSION_ID,
        permissionId: "per_child",
        response: "once",
      },
      {
        sessionId: GRANDCHILD_SESSION_ID,
        permissionId: "per_grandchild",
        response: "always",
      },
    ]);
    expect(typesOf(events)).toEqual([
      "permission_request",
      "permission_request",
      "text",
      "turn_end",
    ]);
  });

  it("stop_rejects_pending_child_permission", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([
      { type: "child_session", id: CHILD_SESSION_ID },
      bashPermission("per_child", CHILD_SESSION_ID),
      { type: "idle" },
    ]);
    const turn = handle.prompt("go", { model: null });
    await permissionRequestsIn(events, 1);

    await handle.stop(STOP_GRACE_MS);
    await turn;

    expect(server.replies).toEqual([
      {
        sessionId: CHILD_SESSION_ID,
        permissionId: "per_child",
        response: "reject",
      },
    ]);
  });
});

describe("opencode adapter: secrets in logs", () => {
  it("malformed_sse_payload_is_not_logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rig = await createOpencodeRig();
    const { handle } = await startOpencodeHandle(rig);

    opencodeServerOf(rig).emitRaw(LEAKED_PAYLOAD);
    await handle.prompt("go", { model: null });

    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain("sk-test");
    warn.mockRestore();
  });
});

describe("opencode adapter: request timeouts", () => {
  it("stalled_warm_up_fails_start_and_cleans_up", async () => {
    const rig = await createOpencodeRig();
    rig.container.config.stalledRoutes = ["config"];

    const outcome = await settlesWithin(rig.start(), SETTLE_WINDOW_MS);

    expect(outcome).toMatchObject({ settled: true, value: { ok: false } });
    expect(await runDirEntries(rig)).toEqual([]);
    expect(rig.container.contained[0]?.stopCalls).toHaveLength(1);
  });

  it("slow_warm_up_within_warm_up_timeout_starts", async () => {
    const rig = await createOpencodeRig();
    rig.container.config.delayedRoutes = new Map([["config", SLOW_WARM_UP_MS]]);

    const result = await rig.start();

    expect(result).toMatchObject({ ok: true });
  });

  it("stalled_prompt_async_fails_turn", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    opencodeServerOf(rig).stall("prompt");

    const outcome = await settlesWithin(
      handle.prompt("go", { model: null }),
      SETTLE_WINDOW_MS,
    );

    expect(outcome.settled).toBe(true);
    expect(typesOf(events)).toEqual(["turn_error"]);
  });

  it("stalled_reply_does_not_block_stop", async () => {
    const rig = await createOpencodeRig();
    const { handle, events } = await startOpencodeHandle(rig);
    const server = opencodeServerOf(rig);
    server.enqueue([bashPermission("per_stall"), { type: "idle" }]);
    const turn = handle.prompt("go", { model: null });
    await permissionRequestsIn(events, 1);
    server.stall("permission");
    server.stall("abort");

    const outcome = await settlesWithin(
      handle.stop(STOP_GRACE_MS),
      SETTLE_WINDOW_MS,
    );

    expect(outcome.settled).toBe(true);
    expect(rig.container.contained[0]?.stopCalls).toHaveLength(1);
    expect(await runDirEntries(rig)).toEqual([]);
    await turn;
  });
});
