import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentAdapter, AgentHandle } from "../../src/backend/agentAdapter";
import {
  createSessionService,
  type SessionService,
} from "../../src/backend/session";
import { createJsonStore } from "../../src/backend/storage";
import type { AgentEvent } from "../../src/domain/events";
import type { Account, ApiAccount } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { SessionView } from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import {
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import { createFakeVault } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

const KEY = "sk-test-groq-0001";
const KEY_HEAD = "sk-test-gr";
const KEY_TAIL = "oq-0001";
const LABEL = "Groq main";
const REDACTED = "[redacted:Groq main]";
const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const GROQ_API: ApiAccount = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  baseUrl: null,
  rotation: true,
  auth: "api_key",
};
const NOW_MS = 1_700_000_000_000;
const GRACE_MS = 10;
const RPC_INTERNAL_ERROR = -32603;

afterEach(async () => {
  await closeRigs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const tempDirs: string[] = [];
const services: SessionService[] = [];

async function rigWithKey(): Promise<BackendRig> {
  const rig = await openRig();
  await rig.call("accounts/add", {
    label: LABEL,
    configDir: join(rig.userData, "accounts", "groq-main"),
    provider: "opencode",
    api: GROQ_API,
    apiKey: KEY,
  });
  return rig;
}

function everythingSeen(rig: BackendRig, view: SessionView): string {
  return JSON.stringify([view, rig.broadcasts]);
}

it("claude_session_masks_key_split_across_text_deltas_and_tool_data", async () => {
  const rig = await rigWithKey();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    { type: "text", messageId: "m1", text: `the key is ${KEY_HEAD}` },
    { type: "text", messageId: "m1", text: `${KEY_TAIL}, bye` },
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Run curl",
      kind: "execute",
      rawInput: { command: `curl -H "x-api-key: ${KEY}"` },
    },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      text: `echoed ${KEY}`,
    },
    END_TURN,
  ]);

  await rig.call("session/prompt", { text: "go" });
  await turnEnded(rig);

  const view = await rig.session();
  expect(view.messages.map((message) => message.text).join("")).toBe(
    `the key is ${REDACTED}, bye`,
  );
  expect(view.toolCalls[0]).toMatchObject({
    command: `curl -H "x-api-key: ${REDACTED}"`,
    output: expect.stringContaining(`echoed ${REDACTED}`) as string,
  });
  expect(everythingSeen(rig, view)).not.toContain(KEY);
});

it("claude_session_masks_key_in_permission_request_command", async () => {
  const rig = await rigWithKey();
  await rig.call("session/start", startParams(rig, "ask"));
  agentOf(rig).enqueue([
    {
      type: "permission",
      toolCallId: "t1",
      title: "Run curl",
      kind: "execute",
      rawInput: { command: `curl -H "x-api-key: ${KEY}"` },
      paths: [],
      options: DEFAULT_PERMISSION_OPTIONS,
    },
    END_TURN,
  ]);

  await rig.call("session/prompt", { text: "go" });

  const view = await settled(async () => {
    const current = await rig.session();
    expect(current.permissions).toHaveLength(1);
    return current;
  });
  expect(view.permissions[0]?.command).toBe(`curl -H "x-api-key: ${REDACTED}"`);
  expect(everythingSeen(rig, view)).not.toContain(KEY);
});

it("provider_error_echoing_key_is_masked", async () => {
  const rig = await rigWithKey();
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([
    {
      type: "fail",
      code: RPC_INTERNAL_ERROR,
      message: `Invalid API key ${KEY}`,
    },
  ]);

  await rig.call("session/prompt", { text: "go" });
  await turnEnded(rig);

  const view = await rig.session();
  expect(view.lastTurn).toEqual({
    kind: "failed",
    message: `Invalid API key ${REDACTED}`,
  });
  expect(everythingSeen(rig, view)).not.toContain(KEY);
});

it("session_start_error_echoing_key_is_masked", async () => {
  const rig = await rigWithKey();
  rig.container.config.newSessionError = {
    code: RPC_INTERNAL_ERROR,
    message: `rejected key ${KEY}`,
  };

  const failure = await rig
    .call("session/start", startParams(rig))
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: expect.stringContaining(REDACTED) as string,
  });
  expect(failure instanceof Error ? failure.message : "").not.toContain(KEY);
});

interface OpencodeSession {
  readonly service: SessionService;
  readonly cwd: string;
}

function scriptedHandle(
  accountId: string,
  events: readonly AgentEvent[],
): AgentHandle {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    accountId,
    runId: "run-1",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: () => {
      for (const event of events) {
        listeners.forEach((listener) => {
          listener(event);
        });
      }
      return Promise.resolve();
    },
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: () => Promise.resolve({ ok: true }),
  };
}

async function opencodeSession(
  adapterFor: (accountId: string) => ReturnType<AgentAdapter["start"]>,
): Promise<OpencodeSession> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-mask-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-mask-cwd-"));
  tempDirs.push(userData, cwd);
  const account: Account = {
    id: "oc-1",
    provider: "opencode",
    label: LABEL,
    configDir: join(userData, "oc"),
    order: 0,
    api: GROQ_API,
  };
  const store = createJsonStore(userData);
  await store.writeAccounts([account]);
  const service = createSessionService({
    adapter: { start: (spec) => adapterFor(spec.account.id) },
    store,
    broadcast: () => undefined,
    now: () => NOW_MS,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => "run-1",
    resolveExecutable: () => "/usr/bin/opencode",
    stopGraceMs: GRACE_MS,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [{ value: KEY, label: LABEL }],
  });
  services.push(service);
  return { service, cwd };
}

async function promptedOpencodeView(
  events: readonly AgentEvent[],
  isSettled: (view: SessionView) => boolean = (view) => view.lastTurn !== null,
): Promise<SessionView> {
  const { service, cwd } = await opencodeSession((accountId) =>
    Promise.resolve({ ok: true, handle: scriptedHandle(accountId, events) }),
  );
  await service.start({ cwd, profile: "ask" });
  await service.prompt("go");
  return settled(() => {
    const view = service.view();
    if (view === null) {
      throw new Error("no session");
    }
    expect(isSettled(view)).toBe(true);
    return view;
  });
}

it("opencode_session_masks_every_event_shape", async () => {
  const view = await promptedOpencodeView([
    { type: "text", messageId: "m1", text: `a ${KEY_HEAD}` },
    { type: "text", messageId: "m1", text: `${KEY_TAIL} b` },
    {
      type: "tool_call",
      toolCallId: "t1",
      title: `Run ${KEY}`,
      kind: "execute",
      status: "in_progress",
      rawInput: { command: `echo ${KEY}`, nested: [{ token: KEY }] },
    },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      output: `out ${KEY}`,
      rawInput: { command: `echo again ${KEY}` },
    },
    {
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: `bad key ${KEY}`,
    },
  ]);

  expect(view.messages.map((message) => message.text).join("")).toBe(
    `a ${REDACTED} b`,
  );
  expect(view.toolCalls[0]).toMatchObject({
    title: `Run ${REDACTED}`,
    command: `echo again ${REDACTED}`,
    output: `out ${REDACTED}`,
  });
  expect(view.lastTurn).toEqual({
    kind: "failed",
    message: `bad key ${REDACTED}`,
  });
  expect(JSON.stringify(view)).not.toContain(KEY);
});

it("opencode_session_masks_key_in_permission_request", async () => {
  const view = await promptedOpencodeView(
    [
      {
        type: "permission_request",
        requestId: "p1",
        toolCallId: "t2",
        title: "Run curl",
        kind: "execute",
        rawInput: { command: `curl ${KEY}` },
        locations: [],
        options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
      },
    ],
    (current) => current.permissions.length === 1,
  );

  expect(view.permissions[0]?.command).toBe(`curl ${REDACTED}`);
  expect(JSON.stringify(view)).not.toContain(KEY);
});

it("opencode_session_flushes_held_back_text_at_turn_end", async () => {
  const view = await promptedOpencodeView([
    { type: "text", messageId: "m1", text: "short answer" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);

  expect(view.messages.map((message) => message.text).join("")).toBe(
    "short answer",
  );
});

it("held_back_text_is_flushed_before_the_next_non_text_event", async () => {
  const view = await promptedOpencodeView([
    { type: "text", messageId: "m1", text: "short answer" },
    {
      type: "tool_call",
      toolCallId: "t1",
      title: "Run ls",
      kind: "execute",
      status: "pending",
    },
    { type: "turn_end", stopReason: "end_turn" },
  ]);

  const [message] = view.messages;
  const [toolCall] = view.toolCalls;
  expect(message?.text).toBe("short answer");
  expect(message?.seq).toBeLessThan(toolCall?.seq ?? Number.NEGATIVE_INFINITY);
});

it("opencode_session_start_failure_message_is_masked", async () => {
  const { service, cwd } = await opencodeSession(() =>
    Promise.resolve({
      ok: false,
      reason: "error",
      message: `provider rejected ${KEY}`,
    }),
  );

  const started = service.start({ cwd });

  await expect(started).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: `Could not start the agent: provider rejected ${REDACTED}`,
  });
});

const OTHER_KEY = "sk-test-groq-0002";
const KEY_RETRY_WAIT_MS = 10_000;

async function promptEchoing(rig: BackendRig, text: string): Promise<string> {
  agentOf(rig).enqueue([{ type: "text", messageId: "m1", text }, END_TURN]);
  await rig.call("session/prompt", { text: "go" });
  await settled(async () => {
    const view = await rig.session();
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).not.toBeNull();
  });
  const view = await rig.session();
  return view.messages.map((message) => message.text).join("");
}

it("replaced_and_removed_keys_stay_masked", async () => {
  const rig = await openRig();
  const { account } = await rig.call("accounts/add", {
    label: LABEL,
    configDir: join(rig.userData, "accounts", "groq-main"),
    provider: "opencode",
    api: GROQ_API,
    apiKey: KEY,
  });
  await rig.call("session/start", startParams(rig));
  await promptEchoing(rig, "warm up");

  await rig.call("accounts/setKey", { id: account.id, apiKey: OTHER_KEY });
  const afterReplace = await promptEchoing(rig, `old ${KEY} new ${OTHER_KEY}`);
  await rig.call("accounts/remove", { id: account.id });
  const afterRemove = await promptEchoing(rig, `gone ${KEY} and ${OTHER_KEY}`);

  expect(afterReplace).toContain(`old ${REDACTED} new ${REDACTED}`);
  expect(afterRemove).toContain(`gone ${REDACTED} and ${REDACTED}`);
  expect(everythingSeen(rig, await rig.session())).not.toContain(KEY);
});

it("prompt_failure_log_is_masked", async () => {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    logged.push(
      args
        .map((arg) => (arg instanceof Error ? (arg.stack ?? "") : String(arg)))
        .join(" "),
    );
  });
  const { service, cwd } = await opencodeSession((accountId) =>
    Promise.resolve({
      ok: true,
      handle: {
        ...scriptedHandle(accountId, []),
        prompt: () => Promise.reject(new Error(`rejected key ${KEY}`)),
      },
    }),
  );
  await service.start({ cwd, profile: "ask" });

  await service.prompt("go");
  const view = await settled(() => {
    const current = service.view();
    expect(current?.lastTurn).not.toBeNull();
    return current;
  });

  expect(view?.lastTurn).toEqual({
    kind: "failed",
    message: `rejected key ${REDACTED}`,
  });
  expect(logged.join("\n")).toContain(REDACTED);
  expect(logged.join("\n")).not.toContain(KEY);
  spy.mockRestore();
});

it("failed_startup_decrypt_is_retried_for_masking", async () => {
  const userData = await makeTempDir();
  const vault = createFakeVault();
  const first = await openRig({
    userData,
    vault,
    accounts: [ACCOUNT_A, ACCOUNT_B],
  });
  await first.call("accounts/add", {
    label: LABEL,
    configDir: join(userData, "accounts", "groq-main"),
    provider: "opencode",
    api: GROQ_API,
    apiKey: KEY,
  });
  vault.available = false;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await openRig({ userData, vault });
  await rig.call("session/start", startParams(rig));
  await promptEchoing(rig, "warm up");

  vault.available = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + KEY_RETRY_WAIT_MS);
  await promptEchoing(rig, "still locked");
  await new Promise((resolve) => setImmediate(resolve));
  const text = await promptEchoing(rig, `leak ${KEY}`);

  expect(text).toContain(`leak ${REDACTED}`);
  vi.useRealTimers();
  warn.mockRestore();
});
