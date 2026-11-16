import { describe, expect, it } from "vitest";

import {
  EventSchema,
  RequestSchema,
  ResponseSchema,
  ShutdownMessageSchema,
  ShutdownDoneMessageSchema,
} from "./protocol";

function request(method: string, params: unknown): unknown {
  return { v: 6, id: "a", method, params };
}

const SAVE_FLOW = {
  id: "ship",
  title: "Ship",
  nodes: [{ id: "a", agent: "c" }],
  edges: [],
};

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
  ["flow/start", { cwd: "/work", flowId: "ship", task: "Add a login form" }],
  ["flow/stop", {}],
  ["flow/decide", { runId: "run-1", decision: "approve" }],
  ["flow/decide", { runId: "run-1", decision: "another_round" }],
  ["flow/decide", { runId: "run-1", decision: "stop" }],
  [
    "flows/save",
    {
      cwd: "/work",
      file: "flows/ship.md",
      revision: "abc",
      flow: {
        id: "ship",
        title: "Ship",
        maxRounds: 3,
        nodes: [{ id: "a", agent: "coder", provider: "codex" }],
        edges: [{ from: "a", to: "a", kind: "reviews", gate: true }],
      },
    },
  ],
  ["settings/set", { terminalShell: "/bin/zsh" }],
  ["settings/set", { terminalShell: null }],
  ["terminal/open", { cwd: "/work", cols: 2, rows: 1 }],
  ["terminal/open", { cwd: "/work", cols: 1000, rows: 500 }],
  ["terminal/input", { id: "t", data: "x" }],
  ["terminal/input", { id: "t", data: "y".repeat(65_536) }],
  ["terminal/resize", { id: "t", cols: 120, rows: 40 }],
  ["terminal/ack", { id: "t", chars: 1 }],
  ["terminal/detach", { id: "t" }],
  ["terminal/close", { id: "t" }],
];

const TERMINAL_INVALID_REQUESTS: [string, unknown][] = [
  [
    "terminal/open without cwd",
    request("terminal/open", { cols: 80, rows: 24 }),
  ],
  [
    "terminal/open with empty cwd",
    request("terminal/open", { cwd: "", cols: 80, rows: 24 }),
  ],
  [
    "terminal/open with zero columns",
    request("terminal/open", { cwd: "/w", cols: 0, rows: 24 }),
  ],
  [
    "terminal/open with one column",
    request("terminal/open", { cwd: "/w", cols: 1, rows: 24 }),
  ],
  [
    "terminal/open with too many columns",
    request("terminal/open", { cwd: "/w", cols: 1001, rows: 24 }),
  ],
  [
    "terminal/open with zero rows",
    request("terminal/open", { cwd: "/w", cols: 80, rows: 0 }),
  ],
  [
    "terminal/open with too many rows",
    request("terminal/open", { cwd: "/w", cols: 80, rows: 501 }),
  ],
  [
    "terminal/open with negative columns",
    request("terminal/open", { cwd: "/w", cols: -1, rows: 24 }),
  ],
  [
    "terminal/open with NaN rows",
    request("terminal/open", { cwd: "/w", cols: 80, rows: Number.NaN }),
  ],
  [
    "terminal/open with fractional columns",
    request("terminal/open", { cwd: "/w", cols: 80.5, rows: 24 }),
  ],
  [
    "terminal/resize with too many rows",
    request("terminal/resize", { id: "t", cols: 80, rows: 501 }),
  ],
  [
    "terminal/resize without an id",
    request("terminal/resize", { cols: 80, rows: 24 }),
  ],
  [
    "terminal/input with empty data",
    request("terminal/input", { id: "t", data: "" }),
  ],
  [
    "terminal/input over the limit",
    request("terminal/input", { id: "t", data: "y".repeat(65_537) }),
  ],
  [
    "terminal/input with an empty id",
    request("terminal/input", { id: "", data: "x" }),
  ],
  ["terminal/ack with zero", request("terminal/ack", { id: "t", chars: 0 })],
  [
    "terminal/ack with a fraction",
    request("terminal/ack", { id: "t", chars: 1.5 }),
  ],
  [
    "terminal/detach with an extra key",
    request("terminal/detach", { id: "t", x: 1 }),
  ],
  ["terminal/close without an id", request("terminal/close", {})],
];

const FLOW_INVALID_REQUESTS: [string, unknown][] = [
  [
    "flow/start with a blank task",
    request("flow/start", { cwd: "/w", flowId: "ship", task: "  \n" }),
  ],
  [
    "flow/start without a flow id",
    request("flow/start", { cwd: "/w", task: "Go" }),
  ],
  [
    "flow/start with an empty cwd",
    request("flow/start", { cwd: "", flowId: "ship", task: "Go" }),
  ],
  ["flow/stop with a param", request("flow/stop", { runId: "run-1" })],
  [
    "flow/decide with an unknown decision",
    request("flow/decide", { runId: "run-1", decision: "retry" }),
  ],
  [
    "flow/decide without a run id",
    request("flow/decide", { decision: "approve" }),
  ],
];

const INVALID_REQUESTS: [string, unknown][] = [
  ...TERMINAL_INVALID_REQUESTS,
  ...FLOW_INVALID_REQUESTS,
  ["ping with a param", request("ping", { extra: 1 })],
  ["ping without params", { v: 6, id: "a", method: "ping" }],
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
  [
    "flows/save without revision",
    request("flows/save", { cwd: "/w", file: "flows/a.md", flow: SAVE_FLOW }),
  ],
  [
    "flows/save with maxRounds above the limit",
    request("flows/save", {
      cwd: "/w",
      file: "flows/a.md",
      revision: "r",
      flow: { ...SAVE_FLOW, maxRounds: 11 },
    }),
  ],
  [
    "flows/save with unknown node provider",
    request("flows/save", {
      cwd: "/w",
      file: "flows/a.md",
      revision: "r",
      flow: { ...SAVE_FLOW, nodes: [{ id: "a", agent: "c", provider: "x" }] },
    }),
  ],
  [
    "flows/save with extra param",
    request("flows/save", {
      cwd: "/w",
      file: "flows/a.md",
      revision: "r",
      flow: SAVE_FLOW,
      force: true,
    }),
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
    ["an empty id", { v: 6, id: "", method: "ping", params: {} }],
    ["an extra key", { v: 6, id: "a", method: "ping", params: {}, extra: 1 }],
    ["an unknown method", { v: 6, id: "a", method: "pong", params: {} }],
    ["a missing version", { id: "a", method: "ping", params: {} }],
    ["a non-numeric version", { v: "2", id: "a", method: "ping", params: {} }],
    ["a fractional version", { v: 1.5, id: "a", method: "ping", params: {} }],
    ["a missing id", { v: 6, method: "ping", params: {} }],
  ])("rejects_%s", (_label, payload) => {
    expect(RequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("ResponseSchema", () => {
  it("accepts_a_ping_result", () => {
    const parsed = ResponseSchema.safeParse({
      v: 6,
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
      v: 6,
      id: null,
      ok: false,
      error: { code, message: "bad" },
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    [
      "an unknown error code",
      { v: 6, id: "a", ok: false, error: { code: "NOPE", message: "x" } },
    ],
    [
      "a success without a request id",
      { v: 6, id: null, ok: true, result: { pong: true, backendPid: 1 } },
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
    terminalShell: null,
    updateCheck: true,
    updateChannel: "stable",
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

  const terminal = {
    id: "t-1",
    cwd: "/work",
    shell: "/bin/bash",
    status: "exited",
    exitCode: 0,
  };

  const flowRun = {
    runId: "run-1",
    flowId: "ship",
    flowTitle: "Ship",
    cwd: "/work",
    task: "Go",
    status: "awaiting_decision",
    round: 2,
    maxRounds: 2,
    currentNodeId: null,
    nodes: [{ id: "a", status: "done", visits: 2, result: "ok" }],
    decision: { reason: "rounds_exhausted", nodeId: "a" },
    failure: null,
  };

  it.each([
    ["flow/changed", null],
    ["flow/changed", flowRun],
    ["session/changed", null],
    ["accounts/changed", { accounts: [] }],
    ["settings/changed", settings],
    ["switchLog/appended", logEntry],
    ["terminal/data", { id: "t-1", data: "hello\u001b[0m" }],
    ["terminal/changed", terminal],
    ["terminal/changed", null],
  ])("accepts_%s", (event, payload) => {
    expect(EventSchema.safeParse({ v: 6, event, payload }).success).toBe(true);
  });

  it.each([
    ["an unknown event", { v: 6, event: "nope", payload: null }],
    [
      "a settings event with a session payload",
      { v: 6, event: "settings/changed", payload: null },
    ],
    [
      "a log entry with an unknown reason",
      {
        v: 6,
        event: "switchLog/appended",
        payload: { ...logEntry, reason: "whim" },
      },
    ],
    ["an event without payload", { v: 6, event: "accounts/changed" }],
    [
      "terminal data without an id",
      { v: 6, event: "terminal/data", payload: { data: "x" } },
    ],
    [
      "terminal data with an extra key",
      { v: 6, event: "terminal/data", payload: { id: "t", data: "x", seq: 1 } },
    ],
    [
      "a terminal with an unknown status",
      {
        v: 6,
        event: "terminal/changed",
        payload: { ...terminal, status: "zombie" },
      },
    ],
    [
      "a terminal with a fractional exit code",
      {
        v: 6,
        event: "terminal/changed",
        payload: { ...terminal, exitCode: 1.5 },
      },
    ],
    [
      "a flow run with an unknown status",
      {
        v: 6,
        event: "flow/changed",
        payload: { ...flowRun, status: "paused" },
      },
    ],
    [
      "a flow run with an unknown decision reason",
      {
        v: 6,
        event: "flow/changed",
        payload: { ...flowRun, decision: { reason: "tired", nodeId: "a" } },
      },
    ],
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
