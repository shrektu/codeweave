import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAccountReservations } from "../../src/backend/accountReservations";
import { SESSIONS_DIR, STORAGE_VERSION } from "../../src/backend/constants";
import { createLeaseModes } from "../../src/backend/leaseModes";
import {
  createSessionService,
  type SessionService,
} from "../../src/backend/session";
import { createJsonStore } from "../../src/backend/storage";
import { INITIAL_SESSION_STATE } from "../../src/domain/sessionReducer";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import type { StoredSession } from "../../src/shared/views";
import type { AgentAdapter, AgentHandle } from "../../src/backend/agentAdapter";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACCOUNT_CODEX_A,
  ACCOUNT_CODEX_B,
  RIG_NOW_MS,
  agentOf,
  closeRigs,
  openRig,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import {
  SESSION_ID as FAKE_ACP_SESSION_ID,
  type FakeAcpConfig,
  type ScriptStep,
} from "../fakes/fakeAcpAgent";
import {
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  type RateLimitRead,
} from "../fakes/fakeCodexAppServer";
import { replyTurn } from "../fakes/fakeAgy";
import { PROCESS_TEST_TIMEOUT_MS } from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const AGY_REPLY = "agy replied";
const PROMPT = "Continue the work";
const OLD_GOAL = "Old goal";
const NATIVE_CLAUDE_ID = "claude-native-1";
const NATIVE_CODEX_ID = "thr-native-1";
const NATIVE_OPENCODE_ID = "ses_fake";
const NATIVE_OPENCODE_V2_ID = "ses_fake";
const MISSING_OPENCODE_ID = "ses-missing-1";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPENCODE_API = {
  provider: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  rotation: true,
  auth: "api_key",
} as const;
const TURN_START_SCHEMA = z.looseObject({
  input: z.array(z.looseObject({ text: z.string() })),
});
const AGY_LINE_SCHEMA = z.looseObject({
  message: z.looseObject({ content: z.string() }),
});
const RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const FULL_PERCENT = 100;
const LOW_PERCENT = 10;
const THE_EXHAUSTED_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(
      rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
      null,
      "rate_limit_reached",
    ),
    false,
  ),
};
const THE_HEALTHY_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
  ),
};

const tempDirs: string[] = [];

afterEach(async () => {
  await closeRigs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function sharedUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-native-"));
  tempDirs.push(dir);
  return dir;
}

async function failingPromptService(
  cwd: string,
  userData: string,
  attempts: string[],
): Promise<SessionService> {
  let failures = 1;
  const handle: AgentHandle = {
    accountId: ACCOUNT_A.id,
    runId: "run-1",
    nativeSessionId: null,
    resumed: false,
    subscribe: () => () => undefined,
    prompt: (text) => {
      attempts.push(text);
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("send failed"));
      }
      return Promise.resolve();
    },
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: () => Promise.resolve({ ok: true }),
  };
  const adapter: AgentAdapter = {
    start: () => Promise.resolve({ ok: true, handle }),
  };
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT_A]);
  return createSessionService({
    adapter,
    store,
    broadcast: () => undefined,
    publishView: () => undefined,
    reserved: createAccountReservations(),
    leaseModes: createLeaseModes(),
    now: () => RIG_NOW_MS,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => "run-1",
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder: (requested) => Promise.resolve(requested ?? cwd),
    protectedPaths: () => Promise.resolve([]),
  });
}

async function readStoredSession(
  rig: BackendRig,
  sessionId: string,
): Promise<StoredSession> {
  const text = await readFile(
    join(rig.userData, SESSIONS_DIR, `${sessionId}.json`),
    "utf8",
  );
  return JSON.parse(text) as StoredSession;
}

async function storeSession(
  rig: BackendRig,
  overrides: Partial<StoredSession> = {},
): Promise<string> {
  const dir = join(rig.userData, SESSIONS_DIR);
  await mkdir(dir, { recursive: true });
  const stored: StoredSession = {
    version: STORAGE_VERSION,
    id: SESSION_ID,
    createdAt: RIG_NOW_MS,
    updatedAt: RIG_NOW_MS,
    title: OLD_GOAL,
    cwd: rig.cwd,
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    orchestrate: false,
    archived: false,
    prompts: [{ seq: 0, text: OLD_GOAL }],
    messages: [],
    toolCalls: [],
    turns: [],
    lastTurn: null,
    nativeSessions: [],
    ...overrides,
  };
  await writeFile(join(dir, `${stored.id}.json`), JSON.stringify(stored));
  return stored.id;
}

async function resumeAndPrompt(
  rig: BackendRig,
  sessionId: string,
  text: string = PROMPT,
): Promise<void> {
  await rig.call("session/resume", { sessionId });
  await rig.call("session/prompt", { sessionId, text });
  await turnEnded(rig);
}

async function resumeAndReply(
  rig: BackendRig,
  sessionId: string,
  steps: readonly ScriptStep[],
): Promise<void> {
  await rig.call("session/resume", { sessionId });
  agentOf(rig).enqueue(steps);
  await rig.call("session/prompt", { sessionId, text: PROMPT });
  await turnEnded(rig);
}

function hasPackage(text: string): boolean {
  return text.includes("## Goal") && text.includes("## Instruction");
}

function codexPrompt(rig: BackendRig, index = 0): string {
  const server = rig.codexContainer.servers[index];
  if (server === undefined) {
    throw new Error(`no codex server ${String(index)}`);
  }
  const [params] = server.paramsOf("turn/start");
  return TURN_START_SCHEMA.parse(params).input[0]?.text ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function promptText(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body.text === "string") {
    return body.text;
  }
  const parts = body.parts;
  if (!Array.isArray(parts)) {
    return null;
  }
  const part: unknown = parts[0];
  return isRecord(part) && typeof part.text === "string" ? part.text : null;
}

function opencodePrompts(rig: BackendRig, v2 = false): string[] {
  const container = v2 ? rig.opencodeV2Container : rig.opencodeContainer;
  const server = container.servers[0];
  if (server === undefined) {
    throw new Error("no opencode server");
  }
  return server.requests.flatMap((request) => {
    if (request.method !== "POST" || !request.path.includes("/prompt")) {
      return [];
    }
    const text = promptText(request.body);
    return text === null ? [] : [text];
  });
}

function agyPrompt(rig: BackendRig): string {
  const [spawn] = rig.agyContainer.agySpawns();
  const [line] = spawn?.stdinLines ?? [];
  return typeof line === "string"
    ? AGY_LINE_SCHEMA.parse(JSON.parse(line)).message.content
    : "";
}

function claudeRig(config: FakeAcpConfig): Promise<BackendRig> {
  return openRig({ accounts: [ACCOUNT_A], claudeConfig: config });
}

it("claude_resume_uses_acp_session_resume", async () => {
  const rig = await claudeRig({ resume: true });
  const sessionId = await storeSession(rig, {
    nativeSessions: [
      { accountId: ACCOUNT_A.id, nativeSessionId: NATIVE_CLAUDE_ID },
    ],
  });

  await resumeAndReply(rig, sessionId, [
    { type: "text", text: "ok" },
    END_TURN,
  ]);

  expect(agentOf(rig).resumeCalls).toEqual([
    expect.objectContaining({
      sessionId: NATIVE_CLAUDE_ID,
      cwd: rig.cwd,
      mcpServers: [],
    }),
  ]);
  expect(agentOf(rig).newSessions).toEqual([]);
  expect(agentOf(rig).prompts[0]).toBe(PROMPT);
});

it("claude_load_session_does_not_duplicate_history", async () => {
  const rig = await claudeRig({
    loadSession: true,
    replayed: [{ type: "text", text: "replayed history" }],
  });
  const sessionId = await storeSession(rig, {
    nativeSessions: [
      { accountId: ACCOUNT_A.id, nativeSessionId: NATIVE_CLAUDE_ID },
    ],
  });

  await resumeAndReply(rig, sessionId, [
    { type: "text", text: "ok" },
    END_TURN,
  ]);

  expect(agentOf(rig).loadCalls).toEqual([
    expect.objectContaining({ sessionId: NATIVE_CLAUDE_ID, cwd: rig.cwd }),
  ]);
  expect(agentOf(rig).newSessions).toEqual([]);
  const view = await rig.session();
  expect(view.messages.map((message) => message.text)).toEqual(["ok"]);
  expect(agentOf(rig).prompts[0]).toBe(PROMPT);
});

it("claude_without_resume_support_sends_package", async () => {
  const rig = await claudeRig({});
  const sessionId = await storeSession(rig, {
    nativeSessions: [
      { accountId: ACCOUNT_A.id, nativeSessionId: NATIVE_CLAUDE_ID },
    ],
  });

  await resumeAndReply(rig, sessionId, [
    { type: "text", text: "ok" },
    END_TURN,
  ]);

  expect(agentOf(rig).resumeCalls).toEqual([]);
  expect(agentOf(rig).loadCalls).toEqual([]);
  expect(agentOf(rig).newSessions).toHaveLength(1);
  const [first] = agentOf(rig).prompts;
  expect(first).toContain(OLD_GOAL);
  expect(hasPackage(first ?? "")).toBe(true);
  expect(first?.endsWith(PROMPT)).toBe(true);
});

it("codex_resume_uses_thread_resume", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    codexConfig: { resumedThreadIds: [NATIVE_CODEX_ID] },
  });
  const sessionId = await storeSession(rig, {
    provider: ProviderId.codex,
    nativeSessions: [
      { accountId: ACCOUNT_CODEX_A.id, nativeSessionId: NATIVE_CODEX_ID },
    ],
  });

  rig.codexContainer.scriptNext([{ type: "complete", status: "completed" }]);
  await resumeAndPrompt(rig, sessionId);

  const [server] = rig.codexContainer.servers;
  expect(server?.methods() ?? []).not.toContain("thread/start");
  expect(server?.paramsOf("thread/resume")).toEqual([
    expect.objectContaining({
      threadId: NATIVE_CODEX_ID,
      cwd: rig.cwd,
    }),
  ]);
  expect(codexPrompt(rig)).toBe(PROMPT);
});

it("codex_unknown_thread_falls_back_to_package", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    codexConfig: { resumedThreadIds: [] },
  });
  const sessionId = await storeSession(rig, {
    provider: ProviderId.codex,
    nativeSessions: [
      { accountId: ACCOUNT_CODEX_A.id, nativeSessionId: NATIVE_CODEX_ID },
    ],
  });

  rig.codexContainer.scriptNext([{ type: "complete", status: "completed" }]);
  await resumeAndPrompt(rig, sessionId);

  const [server] = rig.codexContainer.servers;
  expect(server?.methods() ?? []).toContain("thread/resume");
  expect(server?.methods() ?? []).toContain("thread/start");
  const first = codexPrompt(rig);
  expect(first).toContain(OLD_GOAL);
  expect(hasPackage(first)).toBe(true);
});

it("opencode_resume_reuses_session", async () => {
  const rig = await openRig({ accounts: [] });
  const added = await rig.call("accounts/add", {
    label: "OpenCode",
    configDir: join(rig.userData, "accounts", "opencode-native"),
    provider: "opencode",
    api: OPENCODE_API,
    apiKey: "sk-native-opencode-0001",
  });
  const accountId = added.account.id;
  const sessionId = await storeSession(rig, {
    provider: ProviderId.opencode,
    nativeSessions: [{ accountId, nativeSessionId: NATIVE_OPENCODE_ID }],
  });
  await resumeAndPrompt(rig, sessionId);

  const [server] = rig.opencodeContainer.servers;
  expect(
    server?.requests.some(
      (request) =>
        request.method === "GET" &&
        request.path === `/session/${NATIVE_OPENCODE_ID}`,
    ),
  ).toBe(true);
  expect(
    server?.requests.some(
      (request) => request.method === "POST" && request.path === "/session",
    ),
  ).toBe(false);
  expect(opencodePrompts(rig)).toEqual([PROMPT]);
});

it("opencode_v2_resume_reuses_session", async () => {
  const rig = await openRig({ accounts: [], opencodeV2: true });
  const added = await rig.call("accounts/add", {
    label: "OpenCode v2",
    configDir: join(rig.userData, "accounts", "opencode-native-v2"),
    provider: "opencode",
    api: OPENCODE_API,
    apiKey: "sk-native-opencode-0002",
  });
  const accountId = added.account.id;
  const sessionId = await storeSession(rig, {
    provider: ProviderId.opencode,
    nativeSessions: [{ accountId, nativeSessionId: NATIVE_OPENCODE_V2_ID }],
  });
  await resumeAndPrompt(rig, sessionId);

  const [server] = rig.opencodeV2Container.servers;
  expect(
    server?.requests.some(
      (request) =>
        request.method === "GET" &&
        request.path === `/api/session/${NATIVE_OPENCODE_V2_ID}`,
    ),
  ).toBe(true);
  expect(
    server?.requests.some(
      (request) => request.method === "POST" && request.path === "/api/session",
    ),
  ).toBe(false);
  expect(opencodePrompts(rig, true)).toEqual([PROMPT]);
});

it("opencode_missing_session_falls_back_to_package", async () => {
  const rig = await openRig({ accounts: [] });
  const added = await rig.call("accounts/add", {
    label: "OpenCode",
    configDir: join(rig.userData, "accounts", "opencode-missing"),
    provider: "opencode",
    api: OPENCODE_API,
    apiKey: "sk-native-opencode-0003",
  });
  const sessionId = await storeSession(rig, {
    provider: ProviderId.opencode,
    nativeSessions: [
      { accountId: added.account.id, nativeSessionId: MISSING_OPENCODE_ID },
    ],
  });

  await resumeAndPrompt(rig, sessionId);

  const [server] = rig.opencodeContainer.servers;
  expect(
    server?.requests.some(
      (request) => request.method === "POST" && request.path === "/session",
    ),
  ).toBe(true);
  const [first] = opencodePrompts(rig);
  expect(first).toContain(OLD_GOAL);
  expect(hasPackage(first ?? "")).toBe(true);
});

it("agy_resume_uses_context_package_only", async () => {
  const rig = await openRig({ accounts: [] });
  await rig.call("accounts/add", {
    label: "Gemini",
    configDir: join(rig.userData, "accounts", "agy-native"),
    provider: "gemini",
  });
  const sessionId = await storeSession(rig, {
    provider: ProviderId.gemini,
  });
  rig.agyContainer.scriptTurn(replyTurn("conv-live", AGY_REPLY));

  await resumeAndPrompt(rig, sessionId);

  const [spawn] = rig.agyContainer.agySpawns();
  expect(spawn?.conversation).toBeNull();
  expect(hasPackage(agyPrompt(rig))).toBe(true);
  await settled(async () => {
    const stored = await readStoredSession(rig, sessionId);
    expect(stored.nativeSessions).toEqual([]);
  });
});

it("native_ids_recorded_after_first_turn", async () => {
  const rig = await claudeRig({});
  await rig.call("session/start", { cwd: rig.cwd, provider: "claude" });
  const started = await rig.session();
  agentOf(rig).enqueue([{ type: "text", text: "ok" }, END_TURN]);
  await rig.call("session/prompt", { sessionId: started.id, text: PROMPT });
  await turnEnded(rig);
  await rig.dispose();

  const text = await readFile(
    join(rig.userData, SESSIONS_DIR, `${started.id}.json`),
    "utf8",
  );
  expect((JSON.parse(text) as StoredSession).nativeSessions).toEqual([
    { accountId: ACCOUNT_A.id, nativeSessionId: FAKE_ACP_SESSION_ID },
  ]);
});

it("exhausted_account_resumes_elsewhere_with_package", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfigByHome: {
      [ACCOUNT_CODEX_A.configDir]: { rateLimitReads: [THE_EXHAUSTED_READ] },
      [ACCOUNT_CODEX_B.configDir]: { rateLimitReads: [THE_HEALTHY_READ] },
    },
  });
  await settled(async () => {
    const { accounts } = await rig.call("accounts/list", {});
    expect(
      accounts.find((account) => account.id === ACCOUNT_CODEX_A.id)?.runtime,
    ).toMatchObject({ status: "exhausted" });
  });
  const sessionId = await storeSession(rig, {
    provider: ProviderId.codex,
    nativeSessions: [
      { accountId: ACCOUNT_CODEX_A.id, nativeSessionId: NATIVE_CODEX_ID },
    ],
  });

  rig.codexContainer.scriptNext([{ type: "complete", status: "completed" }]);
  const view = await rig.call("session/resume", { sessionId });
  await rig.call("session/prompt", { sessionId, text: PROMPT });
  await turnEnded(rig);

  expect(view.activeAccountId).toBe(ACCOUNT_CODEX_B.id);
  const [server] = rig.codexContainer.servers;
  expect(server?.methods() ?? []).not.toContain("thread/resume");
  expect(server?.methods() ?? []).toContain("thread/start");
  const first = codexPrompt(rig);
  expect(first).toContain(OLD_GOAL);
  expect(hasPackage(first)).toBe(true);
});

it("native_id_used_only_by_its_account", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    claudeConfig: { resume: true },
  });
  const sessionId = await storeSession(rig, {
    nativeSessions: [
      { accountId: ACCOUNT_A.id, nativeSessionId: NATIVE_CLAUDE_ID },
    ],
  });
  const resumed = await rig.call("session/resume", { sessionId });
  expect(resumed.activeAccountId).toBe(ACCOUNT_A.id);

  agentOf(rig, 0).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { sessionId, text: PROMPT });
  await settled(() => {
    expect(rig.container.agents).toHaveLength(2);
  });
  await settled(async () => {
    const view = await rig.session();
    expect(view.turnInFlight).toBe(false);
    expect(view.phase.phase).toBe("running");
  });

  expect(agentOf(rig, 1).resumeCalls).toEqual([]);
  expect(agentOf(rig, 1).newSessions).toHaveLength(1);

  await rig.dispose();
  const stored = await readStoredSession(rig, sessionId);
  expect(stored.nativeSessions).not.toContainEqual({
    accountId: ACCOUNT_B.id,
    nativeSessionId: NATIVE_CLAUDE_ID,
  });
  expect(stored.nativeSessions).toContainEqual({
    accountId: ACCOUNT_B.id,
    nativeSessionId: FAKE_ACP_SESSION_ID,
  });
});

it("native_ids_merged_on_record", async () => {
  const userData = await sharedUserData();
  const first = await openRig({
    userData,
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfigByHome: {
      [ACCOUNT_CODEX_A.configDir]: { rateLimitReads: [THE_EXHAUSTED_READ] },
      [ACCOUNT_CODEX_B.configDir]: { rateLimitReads: [THE_HEALTHY_READ] },
    },
  });
  await settled(async () => {
    const { accounts } = await first.call("accounts/list", {});
    expect(
      accounts.find((account) => account.id === ACCOUNT_CODEX_A.id)?.runtime,
    ).toMatchObject({ status: "exhausted" });
  });
  const sessionId = await storeSession(first, {
    provider: ProviderId.codex,
    nativeSessions: [{ accountId: ACCOUNT_CODEX_A.id, nativeSessionId: "a1" }],
  });

  first.codexContainer.scriptNext([{ type: "complete", status: "completed" }]);
  await resumeAndPrompt(first, sessionId);
  await settled(async () => {
    const live = await readStoredSession(first, sessionId);
    expect(live.nativeSessions).toEqual(
      expect.arrayContaining([
        { accountId: ACCOUNT_CODEX_A.id, nativeSessionId: "a1" },
        { accountId: ACCOUNT_CODEX_B.id, nativeSessionId: "thr-1" },
      ]),
    );
  });
  await first.dispose();

  const second = await openRig({
    userData,
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    codexConfig: { resumedThreadIds: ["a1"] },
  });
  second.codexContainer.scriptNext([{ type: "complete", status: "completed" }]);
  const resumed = await second.call("session/resume", { sessionId });

  expect(resumed.activeAccountId).toBe(ACCOUNT_CODEX_A.id);
  const [server] = second.codexContainer.servers;
  expect(server?.methods()).toContain("thread/resume");
  expect(server?.paramsOf("thread/resume")).toEqual([
    expect.objectContaining({ threadId: "a1" }),
  ]);
});

it("resume_package_survives_failed_first_prompt", async () => {
  const userData = await sharedUserData();
  const cwd = await sharedUserData();
  const attempts: string[] = [];
  const service = await failingPromptService(cwd, userData, attempts);

  try {
    await service.start(
      { cwd },
      {
        resume: {
          id: "seed-session",
          createdAt: RIG_NOW_MS,
          state: INITIAL_SESSION_STATE,
          nativeSessions: [],
          contextPackage: "PACKAGE",
        },
      },
    );
    await service.prompt("first");
    await settled(() => {
      expect(service.view()?.turnInFlight).toBe(false);
      expect(service.isSettled()).toBe(true);
    });
    await service.prompt("second");
    await settled(() => {
      expect(service.isSettled()).toBe(true);
    });
  } finally {
    await service.shutdown();
  }

  expect(attempts).toEqual(["PACKAGE\n\nfirst", "PACKAGE\n\nsecond"]);
});
