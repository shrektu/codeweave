import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { ProviderId } from "../../src/domain/types";
import type { AccountView } from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_CODEX_A,
  RIG_NOW_MS,
  agentOf,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import {
  OPENCODE_SESSION_ID,
  type OpencodeStep,
} from "../fakes/fakeOpencodeServer";
import { settled } from "../fakes/settle";

const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};
const RATE_LIMITED: OpencodeStep = {
  type: "error",
  name: "APIError",
  message: "Rate limit exceeded",
  statusCode: 429,
  headers: { "retry-after": "120" },
};
const EXHAUSTED_TURN: readonly OpencodeStep[] = [
  RATE_LIMITED,
  { type: "idle" },
];
const PROMPT_PATH = `/session/${OPENCODE_SESSION_ID}/prompt_async`;
const GROQ_MODEL = "llama-3.3-70b-versatile";

afterEach(closeRigs);

async function addFreeApi(rig: BackendRig): Promise<AccountView> {
  const { account } = await rig.call("accounts/add", {
    label: "Groq F",
    configDir: join(rig.userData, "accounts", "Groq-F"),
    provider: ProviderId.opencode,
    api: {
      provider: "groq",
      model: GROQ_MODEL,
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: "sk-test-groq-f-0001",
  });
  return account;
}

it("claude_session_switches_to_codex_subscription_before_api", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_CODEX_A] });
  await addFreeApi(rig);
  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "claude",
  });
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);

  await rig.call("session/prompt", { text: "ship the release" });

  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_CODEX_A.id,
    });
  });
  const log = await rig.store.readSwitchLog(10);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    at: RIG_NOW_MS,
    sessionId: started.id,
    from: ACCOUNT_A.id,
    to: ACCOUNT_CODEX_A.id,
    reason: "rate_limit",
  });
  expect(rig.codexContainer.servers).toHaveLength(1);
  expect(rig.opencodeContainer.servers).toHaveLength(0);
});

it("opencode_session_pool_never_contains_subscriptions", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_CODEX_A] });
  const free = await addFreeApi(rig);
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);

  await rig.call("session/start", { cwd: rig.cwd, provider: "opencode" });
  await rig.call("session/prompt", { text: "go" });

  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toMatchObject({ phase: "waiting" });
    expect(view.limits.map((limit) => limit.accountId)).toEqual([free.id]);
  });
  expect(
    (await rig.store.readSwitchLog(10)).map((entry) => [entry.from, entry.to]),
  ).toEqual([[free.id, null]]);
  expect(rig.container.agents).toHaveLength(0);
  expect(rig.codexContainer.servers).toHaveLength(0);
  expect(
    rig.opencodeContainer.servers[0]?.requestsTo("POST", PROMPT_PATH),
  ).toHaveLength(1);
});
