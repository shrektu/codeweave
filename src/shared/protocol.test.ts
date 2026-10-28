import { describe, expect, it } from "vitest";

import {
  EventSchema,
  RequestSchema,
  ResponseSchema,
  ShutdownMessageSchema,
  ShutdownDoneMessageSchema,
} from "./protocol";

function request(method: string, params: unknown): unknown {
  return { v: 2, id: "a", method, params };
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
  ["session/prompt", { text: "hi" }],
  ["session/stop", {}],
  ["permission/answer", { requestId: "r", optionId: "o" }],
  ["accounts/list", {}],
  ["accounts/suggest", {}],
  ["accounts/add", { label: "Work", configDir: "/x" }],
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
  ["ping without params", { v: 2, id: "a", method: "ping" }],
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
    ["an empty id", { v: 2, id: "", method: "ping", params: {} }],
    ["an extra key", { v: 2, id: "a", method: "ping", params: {}, extra: 1 }],
    ["an unknown method", { v: 2, id: "a", method: "pong", params: {} }],
    ["a missing version", { id: "a", method: "ping", params: {} }],
    ["a non-numeric version", { v: "2", id: "a", method: "ping", params: {} }],
    ["a fractional version", { v: 1.5, id: "a", method: "ping", params: {} }],
    ["a missing id", { v: 2, method: "ping", params: {} }],
  ])("rejects_%s", (_label, payload) => {
    expect(RequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("ResponseSchema", () => {
  it("accepts_a_ping_result", () => {
    const parsed = ResponseSchema.safeParse({
      v: 2,
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
      v: 2,
      id: null,
      ok: false,
      error: { code, message: "bad" },
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    [
      "an unknown error code",
      { v: 2, id: "a", ok: false, error: { code: "NOPE", message: "x" } },
    ],
    [
      "a success without a request id",
      { v: 2, id: null, ok: true, result: { pong: true, backendPid: 1 } },
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
    expect(EventSchema.safeParse({ v: 2, event, payload }).success).toBe(true);
  });

  it.each([
    ["an unknown event", { v: 2, event: "nope", payload: null }],
    [
      "a settings event with a session payload",
      { v: 2, event: "settings/changed", payload: null },
    ],
    [
      "a log entry with an unknown reason",
      {
        v: 2,
        event: "switchLog/appended",
        payload: { ...logEntry, reason: "whim" },
      },
    ],
    ["an event without payload", { v: 2, event: "accounts/changed" }],
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
