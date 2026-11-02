import { describe, expect, it } from "vitest";

import {
  EventSchema,
  RequestSchema,
  ResponseSchema,
  ShutdownMessageSchema,
  ShutdownDoneMessageSchema,
} from "./protocol";

function request(method: string, params: unknown): unknown {
  return { v: 5, id: "a", method, params };
}

const VALID_REQUESTS: [string, unknown][] = [
  ["ping", {}],
  ["sessions/snapshot", {}],
  ["session/start", { cwd: "/work" }],
  [
    "session/start",
    {
      cwd: "/work",
      profile: "plan",
      flowRef: { flowId: "f", nodeId: "n" },
    },
  ],
  ["session/start", { cwd: "/work", provider: "codex" }],
  ["session/prompt", { text: "hi" }],
  ["session/stop", {}],
  ["permission/answer", { requestId: "r", optionId: "o" }],
  ["accounts/list", {}],
  ["accounts/suggest", {}],
  ["accounts/add", { label: "Work", configDir: "/x" }],
  ["accounts/add", { label: "Work", configDir: "/x", provider: "codex" }],
  ["accounts/add", { label: "Work", configDir: "/x", provider: "claude" }],
  [
    "accounts/add",
    {
      label: "Groq",
      configDir: "/x",
      provider: "opencode",
      api: {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        baseUrl: null,
        rotation: true,
      },
      apiKey: "sk-test-groq-0001",
    },
  ],
  [
    "accounts/add",
    {
      label: "Local",
      configDir: "/x",
      provider: "opencode",
      api: {
        provider: "custom",
        model: "qwen",
        baseUrl: "http://localhost:11434/v1",
        rotation: false,
      },
      apiKey: "sk-test-local-01",
    },
  ],
  ["accounts/setKey", { id: "acc", apiKey: "sk-test-groq-0002" }],
  ["vault/status", {}],
  ["models/catalog", {}],
  ["settings/set", { codexExecutable: "/opt/codex" }],
  ["settings/set", { agyExecutable: "/opt/agy" }],
  ["settings/set", { agyExecutable: null }],
  [
    "accounts/add",
    { label: "Gemini", configDir: "/data/accounts/g1", provider: "gemini" },
  ],
  ["settings/set", { opencodeExecutable: "/opt/opencode" }],
  ["settings/set", { opencodeExecutable: null }],
  ["accounts/remove", { id: "acc" }],
  ["accounts/move", { id: "acc", direction: "up" }],
  ["settings/get", {}],
  ["settings/set", { effectLevel: "low" }],
  ["settings/set", { claudeExecutable: null }],
  ["switchLog/list", {}],
  ["flows/list", { cwd: "/work" }],
];

const INVALID_REQUESTS: [string, unknown][] = [
  ["ping with a param", request("ping", { extra: 1 })],
  ["ping without params", { v: 5, id: "a", method: "ping" }],
  ["session/start without cwd", request("session/start", {})],
  ["session/start with empty cwd", request("session/start", { cwd: "" })],
  [
    "session/start with unknown profile",
    request("session/start", { cwd: "/w", profile: "yolo" }),
  ],
  [
    "session/start with empty flowRef node",
    request("session/start", {
      cwd: "/w",
      flowRef: { flowId: "f", nodeId: "" },
    }),
  ],
  [
    "session/start with unknown provider",
    request("session/start", { cwd: "/w", provider: "cursor" }),
  ],
  [
    "accounts/add with an unsupported provider",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "cursor",
    }),
  ],
  [
    "accounts/add for opencode without api data",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "opencode",
      apiKey: "sk-test-groq-0001",
    }),
  ],
  [
    "accounts/add for opencode without a key",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "opencode",
      api: { provider: "groq", model: "m", baseUrl: null, rotation: true },
    }),
  ],
  [
    "accounts/add for opencode with a key shorter than 8 characters",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "opencode",
      api: { provider: "groq", model: "m", baseUrl: null, rotation: true },
      apiKey: "sk-1234",
    }),
  ],
  [
    "accounts/add for opencode with an unknown api provider",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "opencode",
      api: { provider: "cohere", model: "m", baseUrl: null, rotation: true },
      apiKey: "sk-test-groq-0001",
    }),
  ],
  [
    "accounts/add for opencode with an invalid base url",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "opencode",
      api: { provider: "custom", model: "m", baseUrl: "nope", rotation: true },
      apiKey: "sk-test-groq-0001",
    }),
  ],
  [
    "accounts/add for claude carrying a key",
    request("accounts/add", {
      label: "G",
      configDir: "/x",
      provider: "claude",
      apiKey: "sk-test-groq-0001",
    }),
  ],
  [
    "accounts/setKey with a short key",
    request("accounts/setKey", { id: "acc", apiKey: "short" }),
  ],
  [
    "accounts/setKey without an id",
    request("accounts/setKey", { apiKey: "sk-test-groq-0001" }),
  ],
  ["vault/status with a param", request("vault/status", { verbose: true })],
  ["models/catalog with a param", request("models/catalog", { force: true })],
  [
    "settings/set with a numeric opencode executable",
    request("settings/set", { opencodeExecutable: 7 }),
  ],
  ["session/prompt without text", request("session/prompt", {})],
  [
    "session/prompt with blank text",
    request("session/prompt", { text: " \n" }),
  ],
  ["session/prompt with numeric text", request("session/prompt", { text: 5 })],
  [
    "permission/answer without option",
    request("permission/answer", { requestId: "r" }),
  ],
  [
    "permission/answer with empty request",
    request("permission/answer", { requestId: "", optionId: "o" }),
  ],
  ["accounts/add without dir", request("accounts/add", { label: "W" })],
  [
    "accounts/add with blank label",
    request("accounts/add", { label: "  ", configDir: "/x" }),
  ],
  [
    "accounts/add with empty dir",
    request("accounts/add", { label: "W", configDir: "" }),
  ],
  ["accounts/remove with numeric id", request("accounts/remove", { id: 3 })],
  [
    "accounts/move with sideways direction",
    request("accounts/move", { id: "a", direction: "left" }),
  ],
  ["accounts/move without direction", request("accounts/move", { id: "a" })],
  ["settings/set with an empty patch", request("settings/set", {})],
  [
    "settings/set with only undefined values",
    request("settings/set", { effectLevel: undefined }),
  ],
  [
    "settings/set with unknown effect level",
    request("settings/set", { effectLevel: "max" }),
  ],
  [
    "settings/set with numeric executable",
    request("settings/set", { claudeExecutable: 4 }),
  ],
  ["flows/list without cwd", request("flows/list", {})],
  ["flows/list with empty cwd", request("flows/list", { cwd: "" })],
  [
    "flows/list with extra param",
    request("flows/list", { cwd: "/w", glob: "*" }),
  ],
];

describe("RequestSchema", () => {
  it.each(VALID_REQUESTS)("accepts_%s_%j", (method, params) => {
    expect(RequestSchema.safeParse(request(method, params)).success).toBe(true);
  });

  it.each(INVALID_REQUESTS)("rejects_%s", (_label, payload) => {
    expect(RequestSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["an empty id", { v: 5, id: "", method: "ping", params: {} }],
    ["an extra key", { v: 5, id: "a", method: "ping", params: {}, extra: 1 }],
    ["an unknown method", { v: 5, id: "a", method: "pong", params: {} }],
    ["a missing version", { id: "a", method: "ping", params: {} }],
    ["a non-numeric version", { v: "2", id: "a", method: "ping", params: {} }],
    ["a fractional version", { v: 1.5, id: "a", method: "ping", params: {} }],
    ["a missing id", { v: 5, method: "ping", params: {} }],
  ])("rejects_%s", (_label, payload) => {
    expect(RequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("ResponseSchema", () => {
  it("accepts_a_ping_result", () => {
    const parsed = ResponseSchema.safeParse({
      v: 5,
      id: "a",
      ok: true,
      result: { pong: true, backendPid: 42 },
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    "VALIDATION",
    "SESSION_BUSY",
    "NOT_FOUND",
    "CONFLICT",
    "UNAVAILABLE",
    "EXPIRED",
  ])("accepts_the_error_code_%s", (code) => {
    const parsed = ResponseSchema.safeParse({
      v: 5,
      id: null,
      ok: false,
      error: { code, message: "bad" },
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    [
      "an unknown error code",
      { v: 5, id: "a", ok: false, error: { code: "NOPE", message: "x" } },
    ],
    [
      "a success without a request id",
      { v: 5, id: null, ok: true, result: { pong: true, backendPid: 1 } },
    ],
  ])("rejects_%s", (_label, payload) => {
    expect(ResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe("EventSchema", () => {
  const settings = {
    permissionProfile: "ask",
    effectLevel: "full",
    claudeExecutable: "/usr/bin/claude",
    codexExecutable: null,
    agyExecutable: null,
    opencodeExecutable: null,
  };
  const logEntry = {
    at: 1,
    sessionId: "s",
    from: "a",
    to: null,
    reason: "needs_login",
    resetsAt: null,
    contextPackageChars: 0,
  };

  it.each([
    ["session/changed", null],
    ["accounts/changed", { accounts: [] }],
    ["settings/changed", settings],
    ["switchLog/appended", logEntry],
  ])("accepts_%s", (event, payload) => {
    expect(EventSchema.safeParse({ v: 5, event, payload }).success).toBe(true);
  });

  it.each([
    ["an unknown event", { v: 5, event: "nope", payload: null }],
    [
      "a settings event with a session payload",
      { v: 5, event: "settings/changed", payload: null },
    ],
    [
      "a log entry with an unknown reason",
      {
        v: 5,
        event: "switchLog/appended",
        payload: { ...logEntry, reason: "whim" },
      },
    ],
    ["an event without payload", { v: 5, event: "accounts/changed" }],
  ])("rejects_%s", (_label, payload) => {
    expect(EventSchema.safeParse(payload).success).toBe(false);
  });
});

describe("shutdown messages", () => {
  it("accepts_only_their_own_type", () => {
    expect(ShutdownMessageSchema.safeParse({ type: "shutdown" }).success).toBe(
      true,
    );
    expect(
      ShutdownMessageSchema.safeParse({ type: "shutdown-done" }).success,
    ).toBe(false);
    expect(
      ShutdownDoneMessageSchema.safeParse({ type: "shutdown-done" }).success,
    ).toBe(true);
  });
});
