import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { SESSIONS_DIR, STORAGE_VERSION } from "../../src/backend/constants";
import type { Account } from "../../src/domain/types";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import { usageTotalsOf } from "../../src/domain/usageLedger";
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
import { replyTurn } from "../fakes/fakeAgy";
import { PROCESS_TEST_TIMEOUT_MS } from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

afterEach(closeRigs);

const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const OPENCODE_MODEL = "llama-3.3-70b";
const OPENCODE_API = {
  provider: "groq",
  model: OPENCODE_MODEL,
  baseUrl: null,
  rotation: true,
  auth: "api_key",
} as const;
const TURN_USAGE = {
  totalTokens: 174,
  inputTokens: 100,
  outputTokens: 20,
  thoughtTokens: 5,
  cachedReadTokens: 10,
  cachedWriteTokens: 2,
};
const TAKEOVER_USAGE = {
  totalTokens: 67,
  inputTokens: 50,
  outputTokens: 10,
  thoughtTokens: 2,
  cachedReadTokens: 5,
  cachedWriteTokens: 0,
};
const ZERO_TOKENS = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};
const AGY_ACCOUNT: Account = {
  ...ACCOUNT_A,
  id: "agy-usage",
  provider: ProviderId.gemini,
  label: "Gemini",
  configDir: join(tmpdir(), "codeweave-usage-agy"),
};

async function addOpencodeAccount(
  rig: BackendRig,
  label: string,
): Promise<void> {
  await rig.call("accounts/add", {
    label,
    configDir: join(rig.userData, "accounts", label),
    provider: ProviderId.opencode,
    api: OPENCODE_API,
    apiKey: `sk-usage-${label}-0001`,
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

function turnStep(
  cost: number,
  usage: typeof TURN_USAGE,
): readonly ScriptStep[] {
  return [
    { type: "usage_update", cost: { amount: cost, currency: "USD" } },
    { type: "end", stopReason: "end_turn", usage },
  ];
}

it("claude_session_reports_turn_tokens_and_cumulative_cost", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue(turnStep(0.25, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "first turn" });
  await turnEnded(rig);
  agentOf(rig).enqueue(turnStep(0.4, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "second turn" });
  await turnEnded(rig);

  const totals = usageTotalsOf((await rig.session()).usage);

  expect(totals.tokens).toEqual({
    input: 200,
    output: 40,
    cacheRead: 20,
    cacheWrite: 4,
    reasoning: 10,
  });
  expect(totals.costs).toEqual({ USD: 0.4 });
  expect(totals.tokensReported).toBe(true);
  expect(totals.costReported).toBe(true);
});

it("codex_session_reports_tokens_without_cost", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });
  rig.codexContainer.scriptNext([
    {
      type: "notify",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            inputTokens: 1000,
            cachedInputTokens: 300,
            cacheWriteInputTokens: 0,
            outputTokens: 200,
            reasoningOutputTokens: 60,
            totalTokens: 1260,
          },
          last: { totalTokens: 1260 },
          modelContextWindow: 258_400,
        },
      },
    },
    { type: "complete", status: "completed" },
  ]);
  const sessionId = await startSession(rig);
  await rig.call("session/prompt", { sessionId, text: "go" });
  await turnEnded(rig);

  const totals = usageTotalsOf((await rig.session()).usage);

  expect(totals.tokens).toEqual({
    input: 700,
    output: 140,
    cacheRead: 300,
    cacheWrite: 0,
    reasoning: 60,
  });
  expect(totals.tokensReported).toBe(true);
  expect(totals.costReported).toBe(false);
});

it("opencode_v2_steps_add_up_tokens_and_cost", async () => {
  const rig = await openRig({ accounts: [], opencodeV2: true });
  await addOpencodeAccount(rig, "v2-usage");
  const sessionId = await startOpencodeSession(rig);
  const [server] = rig.opencodeV2Container.servers;
  server?.enqueue([
    { type: "started" },
    { type: "step", model: OPENCODE_MODEL },
    {
      type: "step_ended",
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 10, write: 2 },
      },
      cost: 0.02,
    },
    {
      type: "step_ended",
      tokens: {
        input: 50,
        output: 10,
        reasoning: 0,
        cache: { read: 5, write: 0 },
      },
      cost: 0.03,
    },
    { type: "succeeded" },
  ]);

  await rig.call("session/prompt", { sessionId, text: "go" });
  await turnEnded(rig);

  const totals = usageTotalsOf((await rig.session()).usage);

  expect(totals.tokens).toEqual({
    input: 150,
    output: 30,
    cacheRead: 15,
    cacheWrite: 2,
    reasoning: 5,
  });
  expect(totals.costs).toEqual({ USD: 0.05 });
  expect(totals.tokensReported).toBe(true);
  expect(totals.costReported).toBe(true);
});

it("opencode_v1_repeated_message_update_is_counted_once", async () => {
  const rig = await openRig({ accounts: [] });
  await addOpencodeAccount(rig, "v1-usage");
  const sessionId = await startOpencodeSession(rig);
  const [server] = rig.opencodeContainer.servers;
  server?.enqueue([
    {
      type: "usage",
      cost: 0.1,
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 10, write: 2 },
      },
    },
    {
      type: "usage",
      cost: 0.25,
      tokens: {
        input: 150,
        output: 30,
        reasoning: 8,
        cache: { read: 20, write: 4 },
      },
    },
    { type: "idle" },
  ]);

  await rig.call("session/prompt", { sessionId, text: "go" });
  await turnEnded(rig);

  const totals = usageTotalsOf((await rig.session()).usage);

  expect(totals.tokens).toEqual({
    input: 150,
    output: 30,
    cacheRead: 20,
    cacheWrite: 4,
    reasoning: 8,
  });
  expect(totals.costs).toEqual({ USD: 0.25 });
  expect(totals.tokensReported).toBe(true);
  expect(totals.costReported).toBe(true);
});

it("agy_session_reports_no_usage", async () => {
  const rig = await openRig({ accounts: [AGY_ACCOUNT] });
  const sessionId = await startSession(rig);
  rig.agyContainer.scriptTurn(replyTurn("conv-usage", "hello"));

  await rig.call("session/prompt", { sessionId, text: "go" });
  await turnEnded(rig);

  const totals = usageTotalsOf((await rig.session()).usage);

  expect(totals.tokens).toEqual(ZERO_TOKENS);
  expect(totals.tokensReported).toBe(false);
  expect(totals.costReported).toBe(false);
});

it("usage_survives_rotation_to_another_account", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue(turnStep(0.5, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "first turn" });
  await turnEnded(rig);

  rig.container.scriptNext(turnStep(0.2, TAKEOVER_USAGE));
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { sessionId, text: "second turn" });
  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toEqual({ phase: "running", accountId: ACCOUNT_B.id });
    expect(view.turnInFlight).toBe(false);
  });

  const totals = usageTotalsOf((await rig.session()).usage);

  expect(totals.tokens).toEqual({
    input: 150,
    output: 30,
    cacheRead: 15,
    cacheWrite: 2,
    reasoning: 7,
  });
  expect(totals.costs).toEqual({ USD: 0.7 });
  expect(totals.tokensReported).toBe(true);
  expect(totals.costReported).toBe(true);
});

it("usage_survives_restore_from_history", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue(turnStep(0.3, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "remember usage" });
  await turnEnded(rig);
  await settled(async () => {
    const stored: unknown = JSON.parse(
      await readFile(
        join(rig.userData, SESSIONS_DIR, `${sessionId}.json`),
        "utf8",
      ),
    );
    expect(stored).toMatchObject({ usage: { base: { tokensReported: true } } });
  });

  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });
  const restored = await rig.call("session/resume", { sessionId });
  const totals = usageTotalsOf(restored.usage);

  expect(totals.tokens).toEqual({
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 2,
    reasoning: 5,
  });
  expect(totals.costs).toEqual({ USD: 0.3 });
  expect(totals.tokensReported).toBe(true);
  expect(totals.costReported).toBe(true);
});

it("resumed_claude_session_keeps_earlier_cost", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_A],
    claudeConfig: { resume: true },
  });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue(turnStep(0.05, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "first turn" });
  await turnEnded(rig);
  await settled(async () => {
    const stored: unknown = JSON.parse(
      await readFile(
        join(rig.userData, SESSIONS_DIR, `${sessionId}.json`),
        "utf8",
      ),
    );
    expect(stored).toMatchObject({ usage: { base: { tokensReported: true } } });
  });

  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });
  await rig.call("session/resume", { sessionId });

  const resumed = agentOf(rig, 1);
  expect(resumed.resumeCalls).toHaveLength(1);
  resumed.enqueue(turnStep(0.08, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "second turn" });
  await settled(async () => {
    const costs = usageTotalsOf((await rig.session()).usage).costs;
    expect(costs).toEqual({ USD: 0.13 });
  });

  const totals = usageTotalsOf((await rig.session()).usage);
  expect(totals.tokens.input).toBe(200);
});

it("stored_session_without_usage_loads_with_empty_ledger", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const dir = join(rig.userData, SESSIONS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      version: STORAGE_VERSION,
      id: sessionId,
      createdAt: RIG_NOW_MS,
      updatedAt: RIG_NOW_MS,
      title: "old work",
      cwd: rig.cwd,
      explicitFolder: true,
      provider: ProviderId.claude,
      profile: PermissionProfile.ask,
      orchestrate: false,
      archived: false,
      prompts: [{ seq: 0, text: "old work", attachments: [] }],
      messages: [],
      toolCalls: [],
      turns: [],
      lastTurn: null,
      nativeSessions: [],
    }),
  );

  const restored = await rig.call("session/resume", { sessionId });
  const totals = usageTotalsOf(restored.usage);

  expect(totals).toEqual({
    tokens: ZERO_TOKENS,
    costs: {},
    tokensReported: false,
    costReported: false,
  });
});

it("claude_to_codex_rotation_keeps_codex_cost_not_reported", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_CODEX_A] });
  const sessionId = await startSession(rig);
  agentOf(rig).enqueue(turnStep(0.5, TURN_USAGE));
  await rig.call("session/prompt", { sessionId, text: "first turn" });
  await turnEnded(rig);

  rig.codexContainer.scriptNext([
    {
      type: "notify",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            inputTokens: 1000,
            cachedInputTokens: 300,
            cacheWriteInputTokens: 0,
            outputTokens: 200,
            reasoningOutputTokens: 60,
            totalTokens: 1260,
          },
          last: { totalTokens: 1260 },
          modelContextWindow: 258_400,
        },
      },
    },
    { type: "complete", status: "completed" },
  ]);
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", { sessionId, text: "second turn" });
  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_CODEX_A.id,
    });
    expect(view.turnInFlight).toBe(false);
    expect(view.usage.reporters.codex).toBeDefined();
  });

  const { usage } = await rig.session();

  expect(usage.reporters.claude).toEqual({ tokens: true, cost: true });
  expect(usage.reporters.codex).toEqual({ tokens: true, cost: false });
  expect(usageTotalsOf(usage).costs).toEqual({ USD: 0.5 });
});

it("stored_usage_without_reporters_loads", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const dir = join(rig.userData, SESSIONS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      version: STORAGE_VERSION,
      id: sessionId,
      createdAt: RIG_NOW_MS,
      updatedAt: RIG_NOW_MS,
      title: "m1 work",
      cwd: rig.cwd,
      explicitFolder: true,
      provider: ProviderId.claude,
      profile: PermissionProfile.ask,
      orchestrate: false,
      archived: false,
      prompts: [{ seq: 0, text: "m1 work", attachments: [] }],
      messages: [],
      toolCalls: [],
      turns: [],
      lastTurn: null,
      usage: {
        base: {
          tokens: { ...ZERO_TOKENS, input: 7 },
          costs: { USD: 0.5 },
          tokensReported: true,
          costReported: true,
        },
        sources: {},
      },
      nativeSessions: [],
    }),
  );

  const restored = await rig.call("session/resume", { sessionId });

  expect(restored.usage.reporters).toEqual({});
  expect(usageTotalsOf(restored.usage).costs).toEqual({ USD: 0.5 });
});
