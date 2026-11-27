import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, expect, it, vi } from "vitest";

import { SESSIONS_DIR, STORAGE_VERSION } from "../../src/backend/constants";
import type { Account } from "../../src/domain/types";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { StoredSession } from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACCOUNT_CODEX_A,
  RIG_NOW_MS,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import {
  createOpencodeRig,
  disposeOpencodeRigs,
  opencodeServerOf,
  startOpencodeHandle,
} from "../fakes/fakeOpencodeServer";
import { PROCESS_TEST_TIMEOUT_MS } from "../fakes/processHelpers";
import { OPENCODE_SESSION_ID } from "../fakes/fakeOpencodeServer";
import { settled } from "../fakes/settle";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

afterEach(closeRigs);
afterEach(disposeOpencodeRigs);

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const HANG: ScriptStep = { type: "hang" };
const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const COMPACT_PROMPT = "/compact";
const OPENCODE_MODEL = "llama-3.3-70b";
const SLOW_REQUEST_TIMEOUT_MS = 100;
const SLOW_SUMMARIZE_MS = 300;
const OPENCODE_API = {
  provider: "groq",
  model: OPENCODE_MODEL,
  baseUrl: null,
  rotation: true,
  auth: "api_key",
} as const;
const SUMMARIZE_PATH = `/session/${OPENCODE_SESSION_ID}/summarize`;
const V2_COMPACT_PATH = `/api/session/${OPENCODE_SESSION_ID}/compact`;

async function addOpencodeAccount(
  rig: BackendRig,
  label: string,
): Promise<void> {
  await rig.call("accounts/add", {
    label,
    configDir: join(rig.userData, "accounts", label),
    provider: ProviderId.opencode,
    api: OPENCODE_API,
    apiKey: `sk-compact-${label}-0001`,
  });
}

async function startSession(rig: BackendRig): Promise<string> {
  await rig.call("session/start", startParams(rig));
  const { id } = await rig.session();
  return id;
}

async function startOpencodeSession(rig: BackendRig): Promise<string> {
  await rig.call("session/start", {
    cwd: rig.cwd,
    provider: ProviderId.opencode,
  });
  const { id } = await rig.session();
  return id;
}

const AGY_ACCOUNT: Account = {
  ...ACCOUNT_A,
  id: "agy-a",
  provider: ProviderId.gemini,
  label: "Gemini",
  configDir: join(tmpdir(), "codeweave-compact-agy"),
};

it("claude_compact_sends_the_slash_compact_prompt", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue([END_TURN]);

  const result = await rig.call("session/compact", { sessionId });
  await turnEnded(rig);

  expect(result).toEqual({ accepted: true });
  expect(agentOf(rig).prompts).toEqual([COMPACT_PROMPT]);
  const view = await rig.session();
  expect(view.prompts).toEqual([
    { seq: 0, text: COMPACT_PROMPT, attachments: [] },
  ]);
});

it("codex_compact_uses_thread_compact_start", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });
  const sessionId = await startSession(rig);

  await rig.call("session/compact", { sessionId });
  await turnEnded(rig);

  const [server] = rig.codexContainer.servers;
  expect(server?.methods()).toContain("thread/compact/start");
  expect(server?.methods()).not.toContain("turn/start");
  expect(server?.paramsOf("thread/compact/start")).toEqual([
    { threadId: "thr-1" },
  ]);
});

it("opencode_v1_compact_posts_summarize_with_the_served_model", async () => {
  const rig = await openRig({ accounts: [] });
  await addOpencodeAccount(rig, "compact-v1");
  const sessionId = await startOpencodeSession(rig);

  await rig.call("session/compact", { sessionId });
  await turnEnded(rig);

  const [server] = rig.opencodeContainer.servers;
  const [request] = server?.requestsTo("POST", SUMMARIZE_PATH) ?? [];
  expect(request?.body).toEqual({
    providerID: "groq",
    modelID: OPENCODE_MODEL,
  });
});

it("opencode_v2_compact_posts_the_compact_endpoint", async () => {
  const rig = await openRig({ accounts: [], opencodeV2: true });
  await addOpencodeAccount(rig, "compact-v2");
  const sessionId = await startOpencodeSession(rig);

  await rig.call("session/compact", { sessionId });
  await turnEnded(rig);

  const [server] = rig.opencodeV2Container.servers;
  const [request] = server?.requestsTo("POST", V2_COMPACT_PATH) ?? [];
  expect(request?.body).toEqual({});
});

it("opencode_v2_compaction_failed_is_a_turn_error", async () => {
  const rig = await openRig({ accounts: [], opencodeV2: true });
  await addOpencodeAccount(rig, "compact-v2-failed");
  const sessionId = await startOpencodeSession(rig);
  const [server] = rig.opencodeV2Container.servers;
  server?.enqueue([
    {
      type: "compaction_failed",
      error: { type: "provider.quota", message: "quota exceeded" },
    },
  ]);

  await rig.call("session/compact", { sessionId });
  await settled(async () => {
    const view = await rig.session();
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).toEqual({
      kind: "failed",
      message: "quota exceeded",
    });
  });
});

it("agy_cannot_compact", async () => {
  const rig = await openRig({ accounts: [AGY_ACCOUNT] });
  const sessionId = await startSession(rig);

  expect((await rig.session()).canCompact).toBe(false);
  await expect(
    rig.call("session/compact", { sessionId }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: "Gemini cannot compact the conversation",
  });
  expect((await rig.session()).prompts).toEqual([]);
  const [spawn] = rig.agyContainer.agySpawns();
  expect(spawn?.stdinLines).toEqual([]);
});

it("compact_while_busy_is_rejected", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue([HANG]);

  await rig.call("session/prompt", { sessionId, text: "go" });

  await expect(
    rig.call("session/compact", { sessionId }),
  ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });
  await rig.call("session/stop", { sessionId });
});

it("prompt_during_compaction_is_rejected", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue([HANG]);

  await rig.call("session/compact", { sessionId });

  await expect(
    rig.call("session/prompt", { sessionId, text: "go" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });
  await rig.call("session/stop", { sessionId });
});

it("can_compact_reflects_the_live_provider", async () => {
  const claude = await openRig({ accounts: [ACCOUNT_A] });
  await startSession(claude);
  expect((await claude.session()).canCompact).toBe(true);
  await claude.call("session/stop", { sessionId: (await claude.session()).id });
  expect((await claude.session()).canCompact).toBe(false);

  const codex = await openRig({ accounts: [ACCOUNT_CODEX_A] });
  await startSession(codex);
  expect((await codex.session()).canCompact).toBe(true);

  const opencode = await openRig({ accounts: [] });
  await addOpencodeAccount(opencode, "can-compact");
  await startOpencodeSession(opencode);
  expect((await opencode.session()).canCompact).toBe(true);

  const agy = await openRig({ accounts: [AGY_ACCOUNT] });
  await startSession(agy);
  expect((await agy.session()).canCompact).toBe(false);
});

it("opencode_v1_slow_summarize_completes_the_compaction", async () => {
  const rig = await createOpencodeRig({
    api: OPENCODE_API,
    requestTimeoutMs: SLOW_REQUEST_TIMEOUT_MS,
  });
  const { handle, events } = await startOpencodeHandle(rig);
  opencodeServerOf(rig).delay("summarize", SLOW_SUMMARIZE_MS);
  if (handle.compact === undefined) {
    expect.unreachable("opencode handle cannot compact");
  }

  await handle.compact();

  expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
});

it("opencode_v2_auto_compaction_keeps_the_prompt_running", async () => {
  const rig = await openRig({ accounts: [], opencodeV2: true });
  await addOpencodeAccount(rig, "auto-compaction");
  const sessionId = await startOpencodeSession(rig);
  const [server] = rig.opencodeV2Container.servers;
  server?.enqueue([
    { type: "started" },
    { type: "compaction_started", reason: "auto" },
    { type: "compaction_ended", reason: "auto" },
    {
      type: "text",
      messageId: "msg_auto",
      ordinal: 0,
      delta: "after compaction",
    },
    { type: "succeeded" },
  ]);

  await rig.call("session/prompt", { sessionId, text: "long task" });
  await turnEnded(rig);

  const view = await rig.session();
  expect(view.messages.map((message) => message.text)).toContain(
    "after compaction",
  );
  expect(view.lastTurn).toEqual({ kind: "ended", stopReason: "end_turn" });
});

it("rotation_during_compaction_hands_the_context_to_the_next_account", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue([END_TURN]);
  await rig.call("session/prompt", { sessionId, text: "first goal" });
  await turnEnded(rig);
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/compact", { sessionId });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(false);
  });

  const nextAccount = agentOf(rig, 1);
  expect(nextAccount.prompts).toEqual([]);
  nextAccount.enqueue([END_TURN]);
  await rig.call("session/prompt", { sessionId, text: "next" });
  await turnEnded(rig);

  expect(nextAccount.prompts).toHaveLength(1);
  const [handoff] = nextAccount.prompts;
  expect(handoff?.startsWith("You are taking over")).toBe(true);
  expect(handoff).toContain("first goal");
  expect(handoff?.endsWith("next")).toBe(true);
  expect(nextAccount.prompts).not.toEqual([COMPACT_PROMPT]);
});

const RESUMED_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESTORED_SESSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function storeHistorySession(
  rig: BackendRig,
  id: string,
  nativeSessions: StoredSession["nativeSessions"],
): Promise<string> {
  const dir = join(rig.userData, SESSIONS_DIR);
  await mkdir(dir, { recursive: true });
  const stored: StoredSession = {
    version: STORAGE_VERSION,
    id,
    createdAt: RIG_NOW_MS,
    updatedAt: RIG_NOW_MS,
    title: "first goal",
    cwd: rig.cwd,
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    orchestrate: false,
    archived: false,
    prompts: [{ seq: 0, text: "first goal", attachments: [] }],
    messages: [],
    toolCalls: [],
    turns: [],
    lastTurn: null,
    nativeSessions,
  };
  await writeFile(join(dir, `${stored.id}.json`), JSON.stringify(stored));
  return stored.id;
}

function storeResumedSession(rig: BackendRig): Promise<string> {
  return storeHistorySession(rig, RESUMED_SESSION_ID, [
    { accountId: ACCOUNT_A.id, nativeSessionId: "native-a" },
    { accountId: ACCOUNT_B.id, nativeSessionId: "native-b" },
  ]);
}

it("rotation_during_compact_to_resumed_account_briefs_next_prompt", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    claudeConfig: { resume: true },
  });
  const sessionId = await storeResumedSession(rig);
  await rig.call("session/resume", { sessionId });
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/compact", { sessionId });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(false);
  });

  const nextAccount = agentOf(rig, 1);
  expect(nextAccount.resumeCalls[0]?.sessionId).toBe("native-b");
  expect(nextAccount.prompts).toEqual([]);

  nextAccount.enqueue([END_TURN]);
  await rig.call("session/prompt", { sessionId, text: "next" });
  await turnEnded(rig);

  expect(nextAccount.prompts).toHaveLength(1);
  const [handoff] = nextAccount.prompts;
  expect(handoff?.startsWith("You are taking over")).toBe(true);
  expect(handoff).toContain("first goal");
  expect(handoff?.endsWith("next")).toBe(true);
});

it("rate_limited_compact_waiting_for_reset_sends_nothing", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/compact", { sessionId });
  await settled(async () => {
    expect((await rig.session()).phase.phase).toBe("waiting");
  });

  const waitTask = rig.scheduled.find((task) => !task.cancelled);
  expect(waitTask).toBeDefined();
  waitTask?.run();
  await settled(async () => {
    const view = await rig.session();
    expect(view.phase.phase).toBe("running");
    expect(view.turnInFlight).toBe(false);
  });

  expect(agentOf(rig, 0).prompts).toEqual([COMPACT_PROMPT]);
  const restarted = agentOf(rig, 1);
  expect(restarted.prompts).toEqual([]);

  restarted.enqueue([END_TURN]);
  await rig.call("session/prompt", { sessionId, text: "next" });
  await turnEnded(rig);

  expect(restarted.prompts).toHaveLength(1);
  const [handoff] = restarted.prompts;
  expect(handoff?.startsWith("You are taking over")).toBe(true);
  expect(handoff?.endsWith("next")).toBe(true);
});

it("restored_session_compact_rotation_sends_one_takeover_package", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const sessionId = await storeHistorySession(rig, RESTORED_SESSION_ID, []);
  await rig.call("session/resume", { sessionId });
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/compact", { sessionId });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(false);
  });

  const nextAccount = agentOf(rig, 1);
  expect(nextAccount.prompts).toEqual([]);
  nextAccount.enqueue([END_TURN]);
  await rig.call("session/prompt", { sessionId, text: "next" });
  await turnEnded(rig);

  expect(nextAccount.prompts).toHaveLength(1);
  const [handoff] = nextAccount.prompts;
  expect(handoff?.match(/You are taking over a coding session/g)).toHaveLength(
    1,
  );
  expect(handoff).not.toContain("being resumed in a new agent");
  expect(handoff).toContain("first goal");
  expect(handoff?.endsWith("next")).toBe(true);
});
