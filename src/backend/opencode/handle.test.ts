import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeContained } from "../../../tests/fakes/fakeContainer";
import type { AgentEvent } from "../../domain/events";
import { PermissionProfile, ProviderId } from "../../domain/types";

import { OpencodeHttpError, type OpencodeClient } from "./client";
import { OpencodeHandle } from "./handle";
import { parseOpencodeEvent, type OpencodeEvent } from "./protocol";

const SESSION = "ses_1";
const CHILD = "ses_child";
const STOP_GRACE_MS = 20;
const GATE_GRACE_MS = 50;
const LATEST_MESSAGE = "msg_0001";
const NEXT_MESSAGE = "msg_0002";
const BUSY_MESSAGE = "OpenCode session is still busy";

interface Rig {
  readonly handle: OpencodeHandle;
  readonly events: AgentEvent[];
  readonly prompts: string[];
  readonly aborts: string[];
  readonly replies: string[][];
  readonly promptFailures: Error[];
  readonly serverBusy: { current: boolean };
  readonly serverFaults: { status: boolean; latest: boolean };
  readonly latestMessage: { current: string | null };
  holdAborts(): () => void;
  push(type: string, properties: Record<string, unknown>): Promise<void>;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function trackedPromise(work: Promise<void>): { readonly done: () => boolean } {
  let finished = false;
  void work.then(() => {
    finished = true;
  });
  return { done: () => finished };
}

interface Sinks {
  readonly prompts: string[];
  readonly aborts: string[];
  readonly replies: string[][];
  readonly promptFailures: Error[];
  readonly abortGate: { current: Promise<void> | null };
  readonly serverBusy: { current: boolean };
  readonly serverFaults: { status: boolean; latest: boolean };
  readonly latestMessage: { current: string | null };
}

function createClient(
  readable: ReadableStream<OpencodeEvent>,
  sinks: Sinks,
): OpencodeClient {
  return {
    warmUp: () => Promise.resolve(),
    providers: () => Promise.resolve({ providers: [] }),
    createSession: () => Promise.resolve(SESSION),
    promptAsync: ({ text }) => {
      sinks.prompts.push(text);
      const failure = sinks.promptFailures.shift();
      return failure === undefined
        ? Promise.resolve()
        : Promise.reject(failure);
    },
    abort: (sessionId) => {
      sinks.aborts.push(sessionId);
      return sinks.abortGate.current ?? Promise.resolve();
    },
    sessionStatus: () =>
      sinks.serverFaults.status
        ? Promise.reject(new Error("status unavailable"))
        : Promise.resolve(
            sinks.serverBusy.current
              ? new Map([[SESSION, { type: "busy" }]])
              : new Map(),
          ),
    latestMessageId: () =>
      sinks.serverFaults.latest
        ? Promise.reject(new Error("messages unavailable"))
        : Promise.resolve(sinks.latestMessage.current),
    replyPermission: (sessionId, permissionId, response) => {
      sinks.replies.push([sessionId, permissionId, response]);
      return Promise.resolve();
    },
    events: () => Promise.resolve(readable),
  };
}

function parsedEvent(
  type: string,
  properties: Record<string, unknown>,
): OpencodeEvent {
  const event = parseOpencodeEvent({ type, properties });
  if (event === null) {
    expect.unreachable(`fixture does not parse: ${type}`);
  }
  return event;
}

function createHandle(client: OpencodeClient): OpencodeHandle {
  const contained = new FakeContained("run-1", []);
  return new OpencodeHandle({
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
      contained,
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
    staleGateGraceMs: GATE_GRACE_MS,
  });
}

async function openRig(): Promise<Rig> {
  const { readable, writable } = new TransformStream<
    OpencodeEvent,
    OpencodeEvent
  >();
  const writer = writable.getWriter();
  const sinks: Sinks = {
    prompts: [],
    aborts: [],
    replies: [],
    promptFailures: [],
    abortGate: { current: null },
    serverBusy: { current: true },
    serverFaults: { status: false, latest: false },
    latestMessage: { current: LATEST_MESSAGE },
  };
  const handle = createHandle(createClient(readable, sinks));
  const events: AgentEvent[] = [];
  handle.subscribe((event) => events.push(event));
  await handle.open();
  return {
    ...sinks,
    handle,
    events,
    holdAborts() {
      const gate = Promise.withResolvers<undefined>();
      sinks.abortGate.current = gate.promise.then(() => undefined);
      return () => {
        gate.resolve(undefined);
      };
    },
    async push(type, properties) {
      await writer.write(parsedEvent(type, properties));
      await flush();
    },
  };
}

function userMessage(id: string): Record<string, unknown> {
  return { info: { id, role: "user", sessionID: SESSION } };
}

const USER_MESSAGE = userMessage(NEXT_MESSAGE);
const FIRST_RUN_MESSAGE = "msg_0101";
const SECOND_RUN_MESSAGE = "msg_0102";

const UNKNOWN_ERROR = {
  sessionID: SESSION,
  error: { name: "UnknownError", data: { message: "boom" } },
};

describe("stale idle", () => {
  it("stale_idle_after_error_does_not_end_next_turn", async () => {
    const rig = await openRig();
    const first = rig.handle.prompt("first");
    await flush();
    await rig.push("message.updated", userMessage(FIRST_RUN_MESSAGE));
    await rig.push("session.error", UNKNOWN_ERROR);
    await first;

    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();
    await rig.push("session.idle", { sessionID: SESSION });

    expect(rig.prompts).toEqual(["first", "second"]);
    expect(second.done()).toBe(false);
    await rig.push("message.updated", userMessage(SECOND_RUN_MESSAGE));
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(true);
    expect(rig.events.map((event) => event.type)).toEqual([
      "turn_error",
      "turn_end",
    ]);
  });

  async function withSecondPromptSentAfterFirstIdle(): Promise<{
    rig: Rig;
    second: ReturnType<typeof trackedPromise>;
  }> {
    const rig = await openRig();
    const first = rig.handle.prompt("first");
    await flush();
    await rig.push("message.updated", userMessage(FIRST_RUN_MESSAGE));
    await rig.push("session.error", UNKNOWN_ERROR);
    await first;
    rig.events.length = 0;
    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();
    await rig.push("session.idle", { sessionID: SESSION });
    expect(rig.prompts).toEqual(["first", "second"]);
    return { rig, second };
  }

  it("trailing_idle_of_previous_run_does_not_end_next_turn", async () => {
    const { rig, second } = await withSecondPromptSentAfterFirstIdle();

    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(false);
    await rig.push("message.updated", userMessage(SECOND_RUN_MESSAGE));
    await rig.push("session.idle", { sessionID: SESSION });

    expect(second.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("trailing_error_of_previous_run_does_not_fail_next_turn", async () => {
    const { rig, second } = await withSecondPromptSentAfterFirstIdle();

    await rig.push("session.error", UNKNOWN_ERROR);
    expect(second.done()).toBe(false);
    expect(rig.events).toEqual([]);
    await rig.push("message.updated", userMessage(SECOND_RUN_MESSAGE));
    await rig.push("session.idle", { sessionID: SESSION });

    expect(second.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("send_does_not_lower_status_boundary", async () => {
    const rig = await openRig();
    const first = rig.handle.prompt("first");
    await flush();
    await rig.push("message.updated", userMessage("msg_0100"));
    await rig.push("session.error", UNKNOWN_ERROR);
    await first;
    rig.events.length = 0;
    rig.serverBusy.current = false;
    rig.latestMessage.current = "msg_0300";

    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();
    expect(rig.prompts).toEqual(["first", "second"]);
    await rig.push("message.updated", userMessage("msg_0200"));
    await rig.push("session.idle", { sessionID: SESSION });

    expect(second.done()).toBe(false);
    await rig.push("message.updated", userMessage("msg_0400"));
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(true);
  });

  it("busy_session_after_abort_fails_turn_without_prompt", async () => {
    const rig = await openRig();
    const first = rig.handle.prompt("first");
    await flush();
    await rig.push("message.updated", userMessage(FIRST_RUN_MESSAGE));
    await rig.push("session.error", UNKNOWN_ERROR);
    await first;
    rig.events.length = 0;

    await rig.handle.prompt("second");

    expect(rig.prompts).toEqual(["first"]);
    expect(rig.aborts).toEqual([SESSION]);
    expect(rig.events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: BUSY_MESSAGE,
      },
    ]);
  });

  it("idle_and_error_without_a_turn_are_consumed", async () => {
    const rig = await openRig();
    await rig.push("session.error", UNKNOWN_ERROR);
    await rig.push("session.idle", { sessionID: SESSION });

    const turn = trackedPromise(rig.handle.prompt("go"));
    await flush();

    expect(rig.prompts).toEqual(["go"]);
    expect(turn.done()).toBe(false);
    expect(rig.events).toEqual([]);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });
    expect(turn.done()).toBe(true);
  });
});

describe("cancelled turn waiting for idle", () => {
  async function withBusySession(): Promise<Rig> {
    const rig = await openRig();
    const first = rig.handle.prompt("first");
    await flush();
    await rig.push("message.updated", userMessage(FIRST_RUN_MESSAGE));
    await rig.push("session.error", UNKNOWN_ERROR);
    await first;
    rig.events.length = 0;
    return rig;
  }

  it("cancel_during_idle_wait_does_not_send_prompt", async () => {
    const rig = await withBusySession();
    const second = rig.handle.prompt("second");
    await flush();

    await rig.handle.cancel();
    await rig.push("session.idle", { sessionID: SESSION });
    await second;

    expect(rig.prompts).toEqual(["first"]);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "cancelled" }]);
  });

  it("stop_during_idle_wait_does_not_send_prompt", async () => {
    const rig = await withBusySession();
    const second = rig.handle.prompt("second");
    await flush();
    const releaseAborts = rig.holdAborts();

    const stopped = rig.handle.stop(STOP_GRACE_MS);
    await flush();
    await rig.push("session.idle", { sessionID: SESSION });
    releaseAborts();
    await stopped;
    await second;

    expect(rig.prompts).toEqual(["first"]);
    expect(rig.events).toEqual([
      { type: "turn_end", stopReason: "cancelled" },
      { type: "process_exit" },
    ]);
  });
});

describe("prompt request failures", () => {
  it("prompt_timeout_keeps_session_busy", async () => {
    const rig = await openRig();
    rig.promptFailures.push(
      new Error("The operation was aborted due to timeout"),
    );
    await rig.handle.prompt("first");
    rig.events.length = 0;

    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();

    expect(rig.prompts).toEqual(["first"]);
    await rig.push("message.updated", userMessage(FIRST_RUN_MESSAGE));
    await rig.push("session.idle", { sessionID: SESSION });
    expect(rig.prompts).toEqual(["first", "second"]);
    expect(second.done()).toBe(false);
    await rig.push("message.updated", userMessage(SECOND_RUN_MESSAGE));
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("unaccepted_prompt_timeout_does_not_block_session", async () => {
    const rig = await openRig();
    rig.promptFailures.push(
      new Error("The operation was aborted due to timeout"),
    );
    await rig.handle.prompt("first");
    rig.events.length = 0;
    rig.serverBusy.current = false;

    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();

    expect(rig.prompts).toEqual(["first", "second"]);
    expect(rig.aborts).toEqual([]);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  async function withSecondPromptSentAfterStatusIdle(): Promise<{
    rig: Rig;
    second: ReturnType<typeof trackedPromise>;
  }> {
    const rig = await openRig();
    rig.promptFailures.push(
      new Error("The operation was aborted due to timeout"),
    );
    await rig.handle.prompt("first");
    rig.events.length = 0;
    rig.serverBusy.current = false;
    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();
    expect(rig.prompts).toEqual(["first", "second"]);
    return { rig, second };
  }

  it("late_idle_after_status_idle_does_not_end_next_turn", async () => {
    const { rig, second } = await withSecondPromptSentAfterStatusIdle();

    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(false);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });

    expect(second.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("late_error_after_status_idle_does_not_fail_next_turn", async () => {
    const { rig, second } = await withSecondPromptSentAfterStatusIdle();

    await rig.push("session.error", UNKNOWN_ERROR);
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(false);
    expect(rig.events).toEqual([]);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });

    expect(second.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
  });

  it("older_user_message_does_not_lift_the_stale_gate", async () => {
    const { rig, second } = await withSecondPromptSentAfterStatusIdle();

    await rig.push("message.updated", {
      info: { id: LATEST_MESSAGE, role: "user", sessionID: SESSION },
    });
    await rig.push("session.idle", { sessionID: SESSION });

    expect(second.done()).toBe(false);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(true);
  });

  it.each([
    ["status_failure_keeps_session_busy", "status"],
    ["latest_message_failure_keeps_session_busy", "latest"],
  ] as const)("%s", async (_name, fault) => {
    const rig = await openRig();
    rig.promptFailures.push(
      new Error("The operation was aborted due to timeout"),
    );
    await rig.handle.prompt("first");
    rig.events.length = 0;
    rig.serverBusy.current = false;
    rig.serverFaults[fault] = true;

    await rig.handle.prompt("second");

    expect(rig.prompts).toEqual(["first"]);
    expect(rig.events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: BUSY_MESSAGE,
      },
    ]);
  });

  it("prompt_http_rejection_releases_busy", async () => {
    const rig = await openRig();
    rig.promptFailures.push(
      new OpencodeHttpError("POST", "/prompt_async", 500),
    );
    await rig.handle.prompt("first");

    const second = trackedPromise(rig.handle.prompt("second"));
    await flush();

    expect(rig.prompts).toEqual(["first", "second"]);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });
    expect(second.done()).toBe(true);
  });
});

async function withGatedTurn(): Promise<{
  rig: Rig;
  turn: ReturnType<typeof trackedPromise>;
}> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rig = await openRig();
  rig.latestMessage.current = null;
  const turn = trackedPromise(rig.handle.prompt("go"));
  await flush();
  return { rig, turn };
}

describe("prompt rejected before the user message", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prompt_rejected_before_user_message_fails_turn", async () => {
    const { rig, turn } = await withGatedTurn();

    await rig.push("session.error", UNKNOWN_ERROR);
    await rig.push("session.error", UNKNOWN_ERROR);
    expect(turn.done()).toBe(false);
    expect(rig.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(GATE_GRACE_MS + STOP_GRACE_MS);

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "boom",
      },
    ]);
    rig.serverBusy.current = false;
    const next = trackedPromise(rig.handle.prompt("next"));
    await flush();
    expect(rig.prompts).toEqual(["go", "next"]);
    expect(next.done()).toBe(false);
  });
});

async function withSecondTurnAfterEarlierOne(latest: string): Promise<{
  rig: Rig;
  turn: ReturnType<typeof trackedPromise>;
}> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rig = await openRig();
  const first = rig.handle.prompt("first");
  await flush();
  await rig.push("message.updated", userMessage("msg_0100"));
  await rig.push("session.idle", { sessionID: SESSION });
  await first;
  rig.events.length = 0;
  rig.latestMessage.current = latest;
  const turn = trackedPromise(rig.handle.prompt("second"));
  await flush();
  expect(rig.prompts).toEqual(["first", "second"]);
  return { rig, turn };
}

describe("gated turn resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejected_prompt_after_earlier_turn_fails_turn", async () => {
    const { rig, turn } = await withSecondTurnAfterEarlierOne("msg_0100");

    await rig.push("session.error", UNKNOWN_ERROR);
    await rig.push("session.error", UNKNOWN_ERROR);
    await vi.advanceTimersByTimeAsync(GATE_GRACE_MS + STOP_GRACE_MS);

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "boom",
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("newer_message_after_earlier_turn_keeps_turn_past_grace", async () => {
    const { rig, turn } = await withSecondTurnAfterEarlierOne("msg_0200");

    await rig.push("session.error", UNKNOWN_ERROR);
    await vi.advanceTimersByTimeAsync(GATE_GRACE_MS + STOP_GRACE_MS);

    expect(turn.done()).toBe(false);
    expect(rig.events).toEqual([]);
    await rig.push("message.updated", userMessage("msg_0200"));
    await rig.push("session.idle", { sessionID: SESSION });

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("user_message_on_server_keeps_turn_past_grace", async () => {
    const { rig, turn } = await withGatedTurn();
    rig.latestMessage.current = "msg_0900";

    await rig.push("session.error", UNKNOWN_ERROR);
    await vi.advanceTimersByTimeAsync(GATE_GRACE_MS + STOP_GRACE_MS);

    expect(turn.done()).toBe(false);
    expect(rig.events).toEqual([]);
    await rig.push("message.updated", userMessage("msg_0900"));
    await rig.push("session.idle", { sessionID: SESSION });

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stale_error_before_user_message_does_not_fail_turn", async () => {
    const { rig, turn } = await withGatedTurn();

    await rig.push("session.error", UNKNOWN_ERROR);
    await rig.push("message.updated", USER_MESSAGE);
    await rig.push("session.idle", { sessionID: SESSION });

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "end_turn" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel_before_user_message_ends_turn", async () => {
    const { rig, turn } = await withGatedTurn();

    await rig.handle.cancel();
    expect(turn.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([{ type: "turn_end", stopReason: "cancelled" }]);
  });

  it("gate_resolution_failure_fails_turn", async () => {
    const { rig, turn } = await withGatedTurn();
    rig.serverFaults.latest = true;

    await rig.push("session.error", UNKNOWN_ERROR);
    await vi.advanceTimersByTimeAsync(GATE_GRACE_MS + STOP_GRACE_MS);

    expect(turn.done()).toBe(true);
    expect(rig.events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "boom",
      },
    ]);
  });
});

describe("child session permissions", () => {
  async function withPendingChildPermission(): Promise<{
    rig: Rig;
    turn: ReturnType<typeof trackedPromise>;
  }> {
    const rig = await openRig();
    const turn = trackedPromise(rig.handle.prompt("go"));
    await flush();
    await rig.push("session.created", {
      info: { id: CHILD, parentID: SESSION },
    });
    await rig.push("session.idle", { sessionID: CHILD });
    await rig.push("session.error", { ...UNKNOWN_ERROR, sessionID: CHILD });
    await rig.push("permission.asked", {
      id: "per_child",
      sessionID: CHILD,
      permission: "bash",
      patterns: ["ls"],
      metadata: { command: "ls" },
    });
    return { rig, turn };
  }

  it("child_permission_is_requested_and_replied_on_the_child", async () => {
    const { rig, turn } = await withPendingChildPermission();

    expect(turn.done()).toBe(false);
    expect(rig.events.map((event) => event.type)).toEqual([
      "permission_request",
    ]);
    rig.handle.answerPermission("per_child", "once");
    await flush();
    expect(rig.replies).toEqual([[CHILD, "per_child", "once"]]);
  });

  it("stop_rejects_pending_child_permission_on_the_child", async () => {
    const { rig } = await withPendingChildPermission();

    await rig.handle.stop(STOP_GRACE_MS);

    expect(rig.replies).toEqual([[CHILD, "per_child", "reject"]]);
  });
});
