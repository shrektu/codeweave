import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeContained } from "../../../../tests/fakes/fakeContainer";
import type { AgentEvent } from "../../../domain/events";
import { PermissionProfile, ProviderId } from "../../../domain/types";
import { TurnInProgressError } from "../../agentAdapter";

import type { OpencodeV2Client } from "./client";
import { OpencodeV2Handle } from "./handle";
import { parseOpencodeV2Event, type OpencodeV2Event } from "./protocol";

const SESSION = "ses_1";
const STOP_GRACE_MS = 20;
const READY_TIMEOUT_MS = 30;
const THRESHOLD_MS = 60_000;
const READY_TIMEOUT_MESSAGE = "opencode server did not start in time";
const RATE_LIMIT_ERROR = { type: "provider.rate-limit", message: "slow down" };

interface Calls {
  readonly prompts: string[];
  readonly interrupts: string[];
  readonly replies: string[][];
  readonly promptGate: { current: Promise<void> | null };
  readonly active: { current: boolean };
}

interface Rig {
  readonly handle: OpencodeV2Handle;
  readonly events: AgentEvent[];
  readonly calls: Calls;
  push(type: string, data: Record<string, unknown>): Promise<void>;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createClient(
  readable: ReadableStream<OpencodeV2Event>,
  calls: Calls,
): OpencodeV2Client {
  return {
    warmUp: () => Promise.resolve(),
    createSession: () => Promise.resolve(SESSION),
    prompt: (_sessionId, text) => {
      calls.prompts.push(text);
      return calls.promptGate.current ?? Promise.resolve();
    },
    switchAgent: () => Promise.resolve(),
    switchModel: () => Promise.resolve(),
    interrupt: (sessionId) => {
      calls.interrupts.push(sessionId);
      return Promise.resolve(true);
    },
    replyPermission: (sessionId, requestId, decision) => {
      calls.replies.push([sessionId, requestId, decision]);
      return Promise.resolve();
    },
    isActive: () => Promise.resolve(calls.active.current),
    models: () => Promise.resolve([]),
    events: () => Promise.resolve(readable),
  };
}

function parsed(type: string, data: Record<string, unknown>): OpencodeV2Event {
  const event = parseOpencodeV2Event({ type, data });
  if (event === null) {
    expect.unreachable(`fixture does not parse: ${type}`);
  }
  return event;
}

function createHandle(client: OpencodeV2Client): OpencodeV2Handle {
  return new OpencodeV2Handle({
    spec: {
      account: {
        id: "acc",
        provider: ProviderId.opencode,
        label: "OpenCode",
        configDir: "/nonexistent/account",
        order: 0,
      },
      cwd: "/nonexistent/work",
      profile: PermissionProfile.ask,
      runId: "run-1",
      executable: "/usr/bin/opencode",
    },
    agentProcess: {
      contained: new FakeContained("run-1", []),
      stop: () => Promise.resolve({ ok: true }),
    },
    watch: {
      exited: new Promise(() => undefined),
      listening: () => Promise.resolve("http://127.0.0.1:1"),
      untilExit: (work) => work,
      stderrTail: () => "",
    },
    files: {
      dir: "/nonexistent/run",
      keyFile: "/nonexistent/run/api-key",
      configFile: "/nonexistent/run/opencode.json",
    },
    client,
    redact: (text) => text,
    now: () => 0,
    stopGraceMs: STOP_GRACE_MS,
    readyTimeoutMs: READY_TIMEOUT_MS,
    defaultModel: { id: "llama", providerID: "groq" },
  });
}

function createRig(): Rig & { connect(): Promise<void> } {
  const { readable, writable } = new TransformStream<
    OpencodeV2Event,
    OpencodeV2Event
  >();
  const writer = writable.getWriter();
  const calls: Calls = {
    prompts: [],
    interrupts: [],
    replies: [],
    promptGate: { current: null },
    active: { current: false },
  };
  const handle = createHandle(createClient(readable, calls));
  const events: AgentEvent[] = [];
  handle.subscribe((event) => events.push(event));
  const push = async (
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    await writer.write(parsed(type, data));
    await flush();
  };
  return {
    handle,
    events,
    calls,
    push,
    connect: () => writer.write(parsed("server.connected", {})),
  };
}

async function openRig(): Promise<Rig> {
  const rig = createRig();
  void rig.connect();
  await rig.handle.open();
  return rig;
}

const OWN = { sessionID: SESSION };

function retry(
  at: number,
  error: Record<string, unknown>,
): Record<string, unknown> {
  return { ...OWN, attempt: 1, at, error };
}

async function startedTurn(
  rig: Rig,
): Promise<{ turn: Promise<void>; done: () => boolean }> {
  let finished = false;
  const turn = rig.handle.prompt("go", { model: null }).then(() => {
    finished = true;
  });
  await flush();
  await rig.push("session.execution.started", OWN);
  return { turn, done: () => finished };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retry handling", () => {
  it("retry_delay_exactly_at_the_threshold_is_only_api_retry", async () => {
    const rig = await openRig();
    const { turn } = await startedTurn(rig);

    await rig.push(
      "session.retry.scheduled",
      retry(THRESHOLD_MS, { ...RATE_LIMIT_ERROR, retryAfterMs: THRESHOLD_MS }),
    );
    await rig.push("session.execution.succeeded", OWN);
    await turn;

    expect(rig.events).toEqual([
      { type: "api_retry" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(rig.calls.interrupts).toEqual([]);
  });

  it("retry_delay_one_millisecond_above_the_threshold_ends_the_turn", async () => {
    const rig = await openRig();
    const { turn } = await startedTurn(rig);

    await rig.push(
      "session.retry.scheduled",
      retry(THRESHOLD_MS + 1, {
        ...RATE_LIMIT_ERROR,
        retryAfterMs: THRESHOLD_MS + 1,
      }),
    );
    await turn;

    expect(rig.events).toEqual([
      {
        type: "rate_limit",
        status: "rejected",
        resetsAt: 61,
        rateLimitType: null,
        utilization: null,
      },
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: "slow down",
      },
    ]);
    expect(rig.calls.interrupts).toEqual([SESSION]);
  });
});

describe("retry conclusion", () => {
  it("long_retry_without_retry_after_resets_at_the_scheduled_time", async () => {
    const rig = await openRig();
    const { turn } = await startedTurn(rig);

    await rig.push("session.retry.scheduled", retry(90_500, RATE_LIMIT_ERROR));
    await turn;

    expect(rig.events[0]).toMatchObject({ type: "rate_limit", resetsAt: 91 });
  });

  it("long_retry_with_another_error_ends_as_a_plain_turn_error", async () => {
    const rig = await openRig();
    const { turn } = await startedTurn(rig);

    await rig.push(
      "session.retry.scheduled",
      retry(THRESHOLD_MS + 1, {
        type: "provider.transport",
        message: "socket hang up",
      }),
    );
    await turn;

    expect(rig.events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "socket hang up",
      },
    ]);
  });

  it("terminal_event_after_a_concluded_turn_only_settles_it", async () => {
    const rig = await openRig();
    const { turn, done } = await startedTurn(rig);
    await rig.push(
      "session.retry.scheduled",
      retry(THRESHOLD_MS + 1, RATE_LIMIT_ERROR),
    );
    expect(done()).toBe(false);

    await rig.push("session.execution.interrupted", {
      ...OWN,
      reason: "user",
    });
    await turn;

    expect(rig.events.map((event) => event.type)).toEqual([
      "rate_limit",
      "turn_error",
    ]);
  });
});

async function sentTurn(
  rig: Rig,
): Promise<{ turn: Promise<void>; done: () => boolean }> {
  let finished = false;
  const turn = rig.handle.prompt("go", { model: null }).then(() => {
    finished = true;
  });
  await flush();
  return { turn, done: () => finished };
}

describe("events before execution started", () => {
  it("stale_long_retry_before_execution_started_does_not_end_the_turn", async () => {
    const rig = await openRig();
    const { turn, done } = await sentTurn(rig);

    await rig.push(
      "session.retry.scheduled",
      retry(THRESHOLD_MS + 1, {
        ...RATE_LIMIT_ERROR,
        retryAfterMs: THRESHOLD_MS + 1,
      }),
    );

    expect(rig.events).toEqual([]);
    expect(rig.calls.interrupts).toEqual([]);
    expect(done()).toBe(false);
    await rig.push("session.execution.started", OWN);
    await rig.push("session.execution.succeeded", OWN);
    await turn;
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
    expect(rig.calls.interrupts).toEqual([]);
  });

  it("stale_short_retry_before_execution_started_emits_no_api_retry", async () => {
    const rig = await openRig();
    const { turn } = await sentTurn(rig);

    await rig.push(
      "session.retry.scheduled",
      retry(1000, { ...RATE_LIMIT_ERROR, retryAfterMs: 1000 }),
    );
    await rig.push("session.execution.started", OWN);
    await rig.push("session.execution.succeeded", OWN);
    await turn;

    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("stale_text_and_tool_events_before_execution_started_are_dropped", async () => {
    const rig = await openRig();
    const { turn } = await sentTurn(rig);

    await rig.push("session.text.delta", {
      ...OWN,
      assistantMessageID: "msg_1",
      ordinal: 0,
      delta: "old",
    });
    await rig.push("session.tool.input.started", {
      ...OWN,
      id: "call_1",
      name: "shell",
    });
    await rig.push("session.execution.started", OWN);
    await rig.push("session.execution.succeeded", OWN);
    await turn;

    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });
});

describe("turn lifecycle", () => {
  it("terminal_event_before_execution_started_is_ignored", async () => {
    const rig = await openRig();
    let finished = false;
    const turn = rig.handle.prompt("go", { model: null }).then(() => {
      finished = true;
    });
    await flush();

    await rig.push("session.execution.succeeded", OWN);

    expect(finished).toBe(false);
    expect(rig.events).toEqual([]);
    await rig.push("session.execution.started", OWN);
    await rig.push("session.execution.succeeded", OWN);
    await turn;
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("second_prompt_during_a_turn_is_rejected", async () => {
    const rig = await openRig();
    const { turn } = await startedTurn(rig);

    await expect(rig.handle.prompt("again", { model: null })).rejects.toThrow(
      TurnInProgressError,
    );

    await rig.push("session.execution.succeeded", OWN);
    await turn;
  });

  it("cancel_before_the_prompt_was_sent_ends_cancelled_without_a_post", async () => {
    const rig = await openRig();

    const turn = rig.handle.prompt("go", { model: null });
    await rig.handle.cancel();
    await turn;

    expect(rig.calls.prompts).toEqual([]);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "cancelled" }]);
  });

  it("cancel_racing_the_prompt_post_interrupts_again_after_it", async () => {
    const rig = await openRig();
    const gate = Promise.withResolvers<undefined>();
    rig.calls.promptGate.current = gate.promise.then(() => undefined);
    const turn = rig.handle.prompt("go", { model: null });
    await flush();

    await rig.handle.cancel();
    expect(rig.calls.interrupts).toHaveLength(1);
    gate.resolve(undefined);
    await turn;

    expect(rig.calls.interrupts).toHaveLength(2);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "cancelled" }]);
  });
});

describe("permissions and listeners", () => {
  it("permission_ask_without_a_live_turn_is_rejected", async () => {
    const rig = await openRig();

    await rig.push("permission.asked", {
      id: "per_1",
      sessionID: SESSION,
      action: "shell",
      resources: ["ls"],
    });

    expect(rig.calls.replies).toEqual([[SESSION, "per_1", "reject"]]);
    expect(rig.events).toEqual([]);
  });

  it("a_throwing_listener_does_not_break_the_others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rig = await openRig();
    const seen: AgentEvent[] = [];
    rig.handle.subscribe(() => {
      throw new Error("listener failed");
    });
    rig.handle.subscribe((event) => seen.push(event));
    const { turn } = await startedTurn(rig);

    await rig.push("session.execution.succeeded", OWN);
    await turn;

    expect(seen).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });
});

describe("open", () => {
  it("open_rejects_when_the_server_never_reports_connected", async () => {
    const rig = createRig();

    await expect(rig.handle.open()).rejects.toThrow(READY_TIMEOUT_MESSAGE);
  });
});
