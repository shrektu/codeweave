import { describe, expect, it } from "vitest";

import {
  ActiveSessionsSchema,
  InterruptResponseSchema,
  ModelListResponseSchema,
  SessionCreatedResponseSchema,
  V2ModelSchema,
  parseOpencodeV2Event,
} from "./protocol";

const GO_LIMIT_ERROR = {
  type: "provider.go-limit",
  message: "OpenCode Go 5 hour usage limit reached.",
  status: 429,
  response: { body: '{"error":"sk-test-fake"}' },
  retryAfterMs: 120000,
};

const EVENT_SAMPLES: readonly (readonly [string, unknown])[] = [
  ["server.connected", { type: "server.connected", data: {} }],
  [
    "session.created",
    {
      type: "session.created",
      data: { sessionID: "ses_2", parentID: "ses_1", title: "child" },
    },
  ],
  [
    "session.execution.started",
    { type: "session.execution.started", data: { sessionID: "ses_1" } },
  ],
  [
    "session.execution.succeeded",
    { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
  ],
  [
    "session.execution.failed",
    {
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: GO_LIMIT_ERROR },
    },
  ],
  [
    "session.execution.interrupted",
    {
      type: "session.execution.interrupted",
      data: { sessionID: "ses_1", reason: "user" },
    },
  ],
  [
    "session.step.started",
    {
      type: "session.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        agent: "build",
        model: { id: "llama-3.3-70b", providerID: "groq" },
      },
    },
  ],
  [
    "session.text.delta",
    {
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "Hel",
      },
    },
  ],
  [
    "session.text.ended",
    {
      type: "session.text.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        ordinal: 0,
        text: "Hello",
      },
    },
  ],
  [
    "session.tool.input.started",
    {
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", id: "call_1", name: "shell" },
    },
  ],
  [
    "session.tool.called",
    {
      type: "session.tool.called",
      data: { sessionID: "ses_1", id: "call_1", input: { command: "ls" } },
    },
  ],
  [
    "session.tool.progress",
    {
      type: "session.tool.progress",
      data: { sessionID: "ses_1", id: "call_1" },
    },
  ],
  [
    "session.tool.success",
    {
      type: "session.tool.success",
      data: {
        sessionID: "ses_1",
        id: "call_1",
        content: [{ type: "text", text: "a.txt" }],
        metadata: { exit: 0 },
      },
    },
  ],
  [
    "session.tool.failed",
    {
      type: "session.tool.failed",
      data: {
        sessionID: "ses_1",
        id: "call_1",
        error: { type: "aborted", message: "The user declined this tool call" },
      },
    },
  ],
  [
    "session.retry.scheduled",
    {
      type: "session.retry.scheduled",
      data: {
        sessionID: "ses_1",
        attempt: 1,
        at: 1790000000000,
        error: { type: "provider.rate-limit", message: "slow down" },
      },
    },
  ],
  [
    "permission.asked",
    {
      type: "permission.asked",
      data: {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["echo hi"],
        save: ["echo *"],
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
      },
    },
  ],
];

describe("parseOpencodeV2Event", () => {
  it.each(EVENT_SAMPLES)("parses_%s", (type, sample) => {
    expect(parseOpencodeV2Event(sample)).toMatchObject(sample as object);
    expect(parseOpencodeV2Event(sample)).toHaveProperty("type", type);
  });

  it("unknown_event_types_are_dropped", () => {
    expect(
      parseOpencodeV2Event({
        type: "session.usage.updated",
        data: { sessionID: "ses_1" },
      }),
    ).toBeNull();
  });

  it("malformed_known_events_are_dropped", () => {
    expect(
      parseOpencodeV2Event({
        type: "session.text.delta",
        data: { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0 },
      }),
    ).toBeNull();
    expect(parseOpencodeV2Event("nope")).toBeNull();
    expect(parseOpencodeV2Event(null)).toBeNull();
    expect(parseOpencodeV2Event({ type: "session.tool.called" })).toBeNull();
  });

  it("permission_asked_defaults_resources_to_empty", () => {
    expect(
      parseOpencodeV2Event({
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_1", action: "webfetch" },
      }),
    ).toMatchObject({ data: { resources: [] } });
  });

  it("tool_success_defaults_content_to_empty", () => {
    expect(
      parseOpencodeV2Event({
        type: "session.tool.success",
        data: { sessionID: "ses_1", id: "call_1" },
      }),
    ).toMatchObject({ data: { content: [] } });
  });

  it("execution_error_keeps_type_status_and_retry_after", () => {
    expect(
      parseOpencodeV2Event({
        type: "session.execution.failed",
        data: { sessionID: "ses_1", error: GO_LIMIT_ERROR },
      }),
    ).toMatchObject({
      data: {
        error: {
          type: "provider.go-limit",
          message: "OpenCode Go 5 hour usage limit reached.",
          status: 429,
          retryAfterMs: 120000,
        },
      },
    });
  });
});

describe("response schemas", () => {
  it("session_create_reads_the_id", () => {
    expect(
      SessionCreatedResponseSchema.parse({ data: { id: "ses_1", cost: 0 } }),
    ).toMatchObject({ data: { id: "ses_1" } });
  });

  it("active_sessions_is_a_record", () => {
    expect(
      ActiveSessionsSchema.parse({ data: { ses_1: { type: "running" } } }).data,
    ).toEqual({ ses_1: { type: "running" } });
  });

  it("model_schema_strips_settings_and_keeps_the_listed_fields", () => {
    const parsed = V2ModelSchema.parse({
      id: "kimi-k3",
      providerID: "opencode-go",
      name: "Kimi K3",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      settings: { apiKey: "sk-test-fake" },
    });

    expect(parsed).toEqual({
      id: "kimi-k3",
      providerID: "opencode-go",
      name: "Kimi K3",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
    });
  });

  it("model_schema_rejects_entries_without_id_or_capabilities", () => {
    const base = { id: "m", providerID: "p", name: "M" };

    expect(V2ModelSchema.safeParse(base).success).toBe(false);
    expect(
      V2ModelSchema.safeParse({
        providerID: "p",
        name: "M",
        capabilities: { tools: true, input: [], output: [] },
      }).success,
    ).toBe(false);
  });

  it("model_list_keeps_unknown_entries_unparsed", () => {
    expect(ModelListResponseSchema.parse({ data: [1, "x"] }).data).toEqual([
      1,
      "x",
    ]);
  });

  it("interrupt_reads_the_flag", () => {
    expect(InterruptResponseSchema.parse({ interrupted: false })).toEqual({
      interrupted: false,
    });
  });
});
