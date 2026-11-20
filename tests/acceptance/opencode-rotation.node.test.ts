import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createExecutableResolver } from "../../src/backend/startup";
import type { ApiProviderId } from "../../src/domain/apiProviders";
import { ProviderId, type Account } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { AccountView } from "../../src/shared/views";
import {
  ACCOUNT_CODEX_A,
  RIG_CODEX_PATH,
  RIG_NOW_MS,
  RIG_OPENCODE_ALT_PATH,
  RIG_OPENCODE_PATH,
  closeRigs,
  createBackendRig,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import {
  commandItem,
  itemCompleted,
  itemStarted,
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  type RateLimitRead,
} from "../fakes/fakeCodexAppServer";
import {
  OPENCODE_SESSION_ID,
  type OpencodeStep,
} from "../fakes/fakeOpencodeServer";
import { createFakeVault } from "../fakes/fakeVault";
import { settled } from "../fakes/settle";

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
const RESETS_AT = 1_700_000_120;
const SLOW_RELAUNCH_MS = 1200;
const PROMPT_PATH = `/session/${OPENCODE_SESSION_ID}/prompt_async`;
const CODEX_RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const FULL_PERCENT = 100;
const LOW_PERCENT = 10;
const OPENCODE_MISSING_MESSAGE =
  "The OpenCode CLI was not found. Install it and restart Codeweave, or set its full path under Settings → OpenCode executable.";
const CUSTOM_OPENCODE_PATH = "/opt/custom/opencode";
const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Try again at 3:14 PM.";

const INITIAL_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
  ),
};
const EXHAUSTED_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(
      rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, CODEX_RESET_AT),
      null,
      "rate_limit_reached",
    ),
    false,
  ),
};

const PromptBodySchema = z.looseObject({
  parts: z.array(z.looseObject({ text: z.string() })),
});

const GROQ_MODEL = "llama-3.3-70b-versatile";
const DEEPSEEK_MODEL = "deepseek-v4-pro";

interface ApiSpec {
  readonly label: string;
  readonly provider: ApiProviderId;
  readonly model?: string;
  readonly rotation?: boolean;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRigs();
});

function keyOf(label: string): string {
  return `sk-test-${label.toLowerCase().replaceAll(" ", "-")}-0001`;
}

async function addApi(rig: BackendRig, spec: ApiSpec): Promise<AccountView> {
  const { account } = await rig.call("accounts/add", {
    label: spec.label,
    configDir: join(rig.userData, "accounts", spec.label.replaceAll(" ", "-")),
    provider: ProviderId.opencode,
    api: {
      provider: spec.provider,
      model: spec.model ?? GROQ_MODEL,
      baseUrl: null,
      rotation: spec.rotation ?? true,
      auth: "api_key",
    },
    apiKey: keyOf(spec.label),
  });
  return account;
}

function keylessAccount(id: string, order: number): Account {
  return {
    id,
    provider: ProviderId.opencode,
    label: id,
    configDir: join("/cfg", id),
    order,
    api: {
      provider: "groq",
      model: GROQ_MODEL,
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
  };
}

function promptsTo(rig: BackendRig, serverIndex: number): string[] {
  const server = rig.opencodeContainer.servers[serverIndex];
  if (server === undefined) {
    throw new Error(`opencode server ${String(serverIndex)} was not spawned`);
  }
  return server
    .requestsTo("POST", PROMPT_PATH)
    .map(
      (request) => PromptBodySchema.parse(request.body).parts[0]?.text ?? "",
    );
}

async function waitForPrompt(
  rig: BackendRig,
  serverIndex: number,
): Promise<string> {
  return settled(() => {
    const [first] = promptsTo(rig, serverIndex);
    if (first === undefined) {
      throw new Error(`server ${String(serverIndex)} has no prompt yet`);
    }
    return first;
  });
}

async function exhaustCodexA(rig: BackendRig): Promise<void> {
  rig.codexContainer.config.rateLimitReads = [INITIAL_READ, EXHAUSTED_READ];
  rig.codexContainer.scriptNext([
    itemStarted(commandItem("c1", "echo hi", "inProgress")),
    itemCompleted(commandItem("c1", "echo hi", "completed", "hi\n")),
    {
      type: "fail",
      codexErrorInfo: "usageLimitExceeded",
      message: USAGE_LIMIT_MESSAGE,
    },
  ]);
  await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });
  await rig.call("session/prompt", { text: "ship the release" });
}

async function runningOn(rig: BackendRig, accountId: string): Promise<void> {
  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId,
    });
  });
}

it("opencode_session_rotates_key_a_to_b", async () => {
  const rig = await openRig({});
  const a = await addApi(rig, { label: "Groq A", provider: "groq" });
  const b = await addApi(rig, { label: "Cerebras B", provider: "cerebras" });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });
  await rig.call("session/prompt", { text: "ship the release" });

  const handoff = await waitForPrompt(rig, 1);
  await runningOn(rig, b.id);
  expect(started.provider).toBe("opencode");
  expect(rig.order.slice(0, 3)).toEqual([
    "spawn:run-1",
    "stop-confirmed:run-1",
    "spawn:run-2",
  ]);
  expect(await rig.opencodeContainer.contained[0]?.isEmpty()).toBe(true);
  expect(handoff).toContain("1. ship the release");
  expect(await rig.store.readSwitchLog(10)).toEqual([
    {
      at: RIG_NOW_MS,
      sessionId: started.id,
      from: a.id,
      to: b.id,
      reason: "rate_limit",
      resetsAt: RESETS_AT,
      contextPackageChars: handoff.length,
    },
  ]);
  expect(rig.opencodeContainer.startups[1]?.keyFileContent).toBe(
    keyOf("Cerebras B"),
  );
});

it("opencode_rotation_outlasts_slow_relaunch", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Groq A", provider: "groq" });
  const b = await addApi(rig, { label: "Cerebras B", provider: "cerebras" });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);
  await rig.call("session/start", { cwd: rig.cwd, provider: "opencode" });
  rig.opencodeContainer.config.launchDelayMs = SLOW_RELAUNCH_MS;

  await rig.call("session/prompt", { text: "ship the release" });

  expect(await waitForPrompt(rig, 1)).toContain("1. ship the release");
  await runningOn(rig, b.id);
});

it("paid_account_without_rotation_is_skipped", async () => {
  const rig = await openRig({});
  const a = await addApi(rig, { label: "Groq A", provider: "groq" });
  await addApi(rig, {
    label: "Deepseek D",
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    rotation: false,
  });
  const c = await addApi(rig, { label: "Cerebras C", provider: "cerebras" });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);

  await rig.call("session/start", { cwd: rig.cwd, provider: "opencode" });
  await rig.call("session/prompt", { text: "go" });

  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toMatchObject({ phase: "waiting" });
    expect(view.limits.map((limit) => limit.accountId).sort()).toEqual(
      [a.id, c.id].sort(),
    );
  });
  expect(rig.opencodeContainer.servers).toHaveLength(2);
  expect((await rig.store.readSwitchLog(10)).map((entry) => entry.to)).toEqual([
    c.id,
    null,
  ]);
});

it("rotation_off_account_is_never_the_initial_account", async () => {
  const rig = await openRig({});
  await addApi(rig, {
    label: "Deepseek D",
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    rotation: false,
  });

  await expect(
    rig.call("session/start", { cwd: rig.cwd, provider: "opencode" }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No usable account",
  });
  expect(rig.opencodeContainer.servers).toHaveLength(0);
});

it("subscription_session_falls_through_to_free_api_account", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });
  const paid = await addApi(rig, {
    label: "Deepseek D",
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
  });
  const free = await addApi(rig, { label: "Groq F", provider: "groq" });
  await addApi(rig, {
    label: "Moonshot M",
    provider: "moonshotai",
    rotation: false,
  });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);

  await exhaustCodexA(rig);

  await runningOn(rig, paid.id);
  expect(
    (await rig.store.readSwitchLog(10)).map((entry) => [entry.from, entry.to]),
  ).toEqual([
    [ACCOUNT_CODEX_A.id, free.id],
    [free.id, paid.id],
  ]);
  expect(rig.opencodeContainer.servers).toHaveLength(2);
  expect((await rig.session()).provider).toBe("codex");
});

it("handoff_to_api_account_uses_opencode_executable", async () => {
  const resolved: (readonly [ProviderId, string | null])[] = [];
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    resolveExecutable: (provider, configured) => {
      resolved.push([provider, configured]);
      return provider === ProviderId.opencode
        ? RIG_OPENCODE_PATH
        : RIG_CODEX_PATH;
    },
  });
  const api = await addApi(rig, { label: "Groq F", provider: "groq" });
  await rig.call("settings/set", {
    opencodeExecutable: CUSTOM_OPENCODE_PATH,
  });

  await exhaustCodexA(rig);

  await runningOn(rig, api.id);
  expect(resolved).toContainEqual([ProviderId.opencode, CUSTOM_OPENCODE_PATH]);
  expect(rig.opencodeContainer.specs[0]?.command).toBe(RIG_OPENCODE_PATH);
  const view = await rig.session();
  expect(view.provider).toBe("codex");
  expect(view.activeAccountId).toBe(api.id);
  expect(view).toMatchObject({ activeProvider: "opencode" });
});

it("keyless_api_account_is_skipped_at_start", async () => {
  const rig = await openRig({ accounts: [keylessAccount("api-keyless", 0)] });
  const keyed = await addApi(rig, { label: "Groq B", provider: "groq" });

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });

  expect(view.activeAccountId).toBe(keyed.id);
  expect(rig.opencodeContainer.servers).toHaveLength(1);
  expect(rig.opencodeContainer.startups[0]?.keyFileContent).toBe(
    keyOf("Groq B"),
  );
});

it("undecryptable_key_at_start_tries_next_account", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const first = await createBackendRig({});
  const broken = await addApi(first, { label: "Groq A", provider: "groq" });
  await first.dispose();
  const vault = createFakeVault();
  vault.available = false;
  const rig = await openRig({ userData: first.userData, vault });
  vault.available = true;
  const healthy = await addApi(rig, { label: "Groq B", provider: "groq" });
  vault.available = false;

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });

  expect(view.activeAccountId).toBe(healthy.id);
  expect(rig.opencodeContainer.servers).toHaveLength(1);
  expect(
    (await rig.call("accounts/list", {})).accounts.find(
      (account) => account.id === broken.id,
    ),
  ).toMatchObject({ hasKey: true });
});

it("undecryptable_only_account_reports_needs_login", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const first = await createBackendRig({});
  await addApi(first, { label: "Groq A", provider: "groq" });
  await first.dispose();
  const vault = createFakeVault();
  vault.available = false;
  const rig = await openRig({ userData: first.userData, vault });

  await expect(
    rig.call("session/start", { cwd: rig.cwd, provider: "opencode" }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Account Groq A needs login",
  });
  expect(rig.opencodeContainer.servers).toHaveLength(0);
});

it("missing_key_marks_needs_login", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const rig = await openRig({ accounts: [keylessAccount("api-gone", 0)] });
  const a = await addApi(rig, { label: "Groq A", provider: "groq" });
  const c = await addApi(rig, { label: "Cerebras C", provider: "cerebras" });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);

  await rig.call("session/start", { cwd: rig.cwd, provider: "opencode" });
  await rig.call("session/prompt", { text: "go" });

  await runningOn(rig, c.id);
  const accounts = (await rig.call("accounts/list", {})).accounts;
  expect(accounts.find((account) => account.id === "api-gone")).toMatchObject({
    runtime: { status: "needs_login" },
  });
  expect(
    (await rig.store.readSwitchLog(10)).map((entry) => [entry.from, entry.to]),
  ).toEqual([[a.id, c.id]]);
  expect(rig.opencodeContainer.servers).toHaveLength(2);
});

it("missing_opencode_executable_is_reported", async () => {
  const missing = createExecutableResolver({ PATH: "" }, "linux");
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    resolveExecutable: (provider, configured) =>
      provider === ProviderId.opencode
        ? missing(provider, configured)
        : RIG_CODEX_PATH,
  });
  await addApi(rig, { label: "Groq A", provider: "groq" });

  await expect(
    rig.call("session/start", { cwd: rig.cwd, provider: "opencode" }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: OPENCODE_MISSING_MESSAGE,
  });
  const codex = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });

  expect(codex.provider).toBe("codex");
});

it("opencode_env_has_no_provider_keys", async () => {
  const rig = await openRig({
    parentEnv: {
      PATH: "/usr/bin",
      GROQ_API_KEY: "sk-test-parent-groq",
      OPENROUTER_API_KEY: "sk-test-parent-openrouter",
      OPENCODE_CONFIG_CONTENT: '{"model":"parent/model"}',
      OPENCODE_PERMISSION: "allow",
    },
  });
  await addApi(rig, { label: "Groq A", provider: "groq" });

  await rig.call("session/start", { cwd: rig.cwd, provider: "opencode" });

  const env = rig.opencodeContainer.specs[0]?.env ?? {};
  expect(Object.keys(env).filter((key) => key.endsWith("_API_KEY"))).toEqual(
    [],
  );
  expect(
    Object.keys(env)
      .filter((key) => key.startsWith("OPENCODE_"))
      .sort(),
  ).toEqual([
    "OPENCODE_CONFIG",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_DISABLE_LSP_DOWNLOAD",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_TEST_HOME",
  ]);
  expect(JSON.stringify(env)).not.toContain("sk-test-parent");
});

it("limit_probes_ignore_api_accounts", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });
  const api = await addApi(rig, { label: "Groq A", provider: "groq" });

  await settled(() => {
    expect(rig.probeTasks).toHaveLength(1);
  });

  expect(rig.probeContainer.specs.map((spec) => spec.env.CODEX_HOME)).toEqual([
    ACCOUNT_CODEX_A.configDir,
  ]);
  expect(
    rig.probeContainer.specs.some((spec) =>
      JSON.stringify(spec).includes(api.configDir),
    ),
  ).toBe(false);
});

const MODEL_BASE = {
  capabilities: {
    toolcall: true,
    input: { text: true, image: false },
    output: { text: true, image: false },
  },
} as const;

function catalogModel(
  providerId: string,
  id: string,
  extra: {
    readonly capabilities?: unknown;
    readonly cost?: { readonly input: number; readonly output: number };
    readonly context?: number;
  } = {},
): Record<string, unknown> {
  return {
    id,
    name: `Name of ${id}`,
    providerID: providerId,
    capabilities: extra.capabilities ?? MODEL_BASE.capabilities,
    cost: extra.cost ?? { input: 1, output: 2 },
    limit: { context: extra.context ?? 8000, output: 1000 },
  };
}

const PROVIDERS_RESPONSE = {
  providers: [
    {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      models: {
        [GROQ_MODEL]: catalogModel("groq", GROQ_MODEL, {
          cost: { input: 0.59, output: 0.79 },
          context: 131_072,
        }),
        "whisper-large-v3": catalogModel("groq", "whisper-large-v3", {
          capabilities: {
            toolcall: false,
            input: { text: true },
            output: { text: true },
          },
        }),
      },
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      env: ["OPENROUTER_API_KEY"],
      models: {
        "qwen/qwen3-coder:free": catalogModel(
          "openrouter",
          "qwen/qwen3-coder:free",
          { cost: { input: 0, output: 0 }, context: 262_144 },
        ),
        "vision/image-only": catalogModel("openrouter", "vision/image-only", {
          capabilities: {
            toolcall: true,
            input: { text: false },
            output: { text: true },
          },
        }),
      },
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      models: {
        [DEEPSEEK_MODEL]: catalogModel("deepseek", DEEPSEEK_MODEL, {
          cost: { input: 0.5, output: 1.5 },
          context: 65_536,
        }),
      },
    },
    {
      id: "azure",
      name: "Azure",
      env: ["AZURE_API_KEY"],
      models: { "gpt-x": catalogModel("azure", "gpt-x") },
    },
  ],
  default: {},
};

const EXPECTED_MODELS = [
  {
    providerId: "groq",
    modelId: GROQ_MODEL,
    name: `Name of ${GROQ_MODEL}`,
    contextWindow: 131_072,
    costIn: 0.59,
    costOut: 0.79,
    free: true,
    trainsOnData: false,
  },
  {
    providerId: "openrouter",
    modelId: "qwen/qwen3-coder:free",
    name: "Name of qwen/qwen3-coder:free",
    contextWindow: 262_144,
    costIn: 0,
    costOut: 0,
    free: true,
    trainsOnData: "unknown",
  },
  {
    providerId: "deepseek",
    modelId: DEEPSEEK_MODEL,
    name: `Name of ${DEEPSEEK_MODEL}`,
    contextWindow: 65_536,
    costIn: 0.5,
    costOut: 1.5,
    free: false,
    trainsOnData: "unknown",
  },
];

const ConfigSchema = z.looseObject({ enabled_providers: z.array(z.string()) });

it("catalog_lists_models_with_flags", async () => {
  const rig = await openRig({
    opencodeConfig: { providers: PROVIDERS_RESPONSE },
  });

  const result = await rig.call("models/catalog", {});

  expect(result).toEqual({ models: EXPECTED_MODELS, error: null });
});

const OPENROUTER_PAID = "vendor/paid-model";
const SLOW_WARM_UP_MS = 500;
const SHORT_PROBE_BUDGET_MS = 60;

function singleProvider(
  id: string,
  models: Record<string, unknown>,
): { providers: unknown[]; default: Record<string, never> } {
  return { providers: [{ id, name: id, env: [], models }], default: {} };
}

it("catalog_marks_paid_openrouter_model_not_free", async () => {
  const rig = await openRig({
    opencodeConfig: {
      providers: {
        providers: [
          {
            id: "openrouter",
            name: "OpenRouter",
            env: ["OPENROUTER_API_KEY"],
            models: {
              [OPENROUTER_PAID]: catalogModel("openrouter", OPENROUTER_PAID, {
                cost: { input: 3, output: 15 },
              }),
              "vendor/tagged:free": catalogModel(
                "openrouter",
                "vendor/tagged:free",
                { cost: { input: 3, output: 15 } },
              ),
            },
          },
          {
            id: "groq",
            name: "Groq",
            env: ["GROQ_API_KEY"],
            models: {
              [GROQ_MODEL]: catalogModel("groq", GROQ_MODEL, {
                cost: { input: 0.59, output: 0.79 },
              }),
            },
          },
        ],
        default: {},
      },
    },
  });

  const result = await rig.call("models/catalog", {});

  expect(result.models.map((item) => [item.modelId, item.free])).toEqual([
    [OPENROUTER_PAID, false],
    ["vendor/tagged:free", true],
    [GROQ_MODEL, true],
  ]);
});

it("catalog_executable_change_mid_probe_returns_new_models", async () => {
  let executable = RIG_OPENCODE_PATH;
  const rig = await openRig({
    opencodeConfig: {
      providers: singleProvider("groq", {
        [GROQ_MODEL]: catalogModel("groq", GROQ_MODEL),
      }),
      delayedRoutes: new Map([["config", 100]]),
    },
    resolveExecutable: (provider) =>
      provider === ProviderId.opencode ? executable : RIG_CODEX_PATH,
  });

  const first = rig.call("models/catalog", {});
  await settled(() => {
    expect(rig.opencodeContainer.servers).toHaveLength(1);
  });
  executable = RIG_OPENCODE_ALT_PATH;
  rig.opencodeContainer.config.providers = singleProvider("deepseek", {
    [DEEPSEEK_MODEL]: catalogModel("deepseek", DEEPSEEK_MODEL),
  });
  const second = rig.call("models/catalog", {});

  expect((await first).models.map((item) => item.modelId)).toEqual([
    GROQ_MODEL,
  ]);
  expect(await second).toMatchObject({ error: null });
  expect((await second).models.map((item) => item.modelId)).toEqual([
    DEEPSEEK_MODEL,
  ]);
  expect(rig.opencodeContainer.specs.map((spec) => spec.command)).toEqual([
    RIG_OPENCODE_PATH,
    RIG_OPENCODE_ALT_PATH,
  ]);
});

it("slow_catalog_warm_up_reports_error_before_renderer_timeout", async () => {
  const rig = await openRig({
    opencodeConfig: {
      providers: PROVIDERS_RESPONSE,
      delayedRoutes: new Map([["config", SLOW_WARM_UP_MS]]),
    },
    catalogProbeTimeoutMs: SHORT_PROBE_BUDGET_MS,
  });

  const result = await rig.call("models/catalog", {});

  expect(result).toEqual({
    models: [],
    error: "model catalog probe timed out",
  });
  expect(rig.opencodeContainer.contained[0]?.stopCalls).toHaveLength(1);
});

it("catalog_probe_is_isolated_and_stopped", async () => {
  const rig = await openRig({
    opencodeConfig: { providers: PROVIDERS_RESPONSE },
  });

  await rig.call("models/catalog", {});

  const [spec] = rig.opencodeContainer.specs;
  expect(spec?.command).toBe(RIG_OPENCODE_PATH);
  expect(spec?.cwd).toBe(join(rig.userData, "opencode-catalog"));
  expect(spec?.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
  expect(rig.opencodeContainer.contained[0]?.stopCalls).toHaveLength(1);
  const startup = rig.opencodeContainer.startups[0];
  expect(
    ConfigSchema.parse(startup?.config).enabled_providers.toSorted(),
  ).toEqual([
    "cerebras",
    "deepseek",
    "google",
    "groq",
    "mistral",
    "moonshotai",
    "opencode",
    "opencode-go",
    "openrouter",
    "zai",
  ]);
  expect(JSON.stringify(startup)).not.toMatch(/sk-/);
});

it("catalog_is_probed_once_per_backend", async () => {
  const rig = await openRig({
    opencodeConfig: { providers: PROVIDERS_RESPONSE },
  });

  const first = await rig.call("models/catalog", {});
  const second = await rig.call("models/catalog", {});

  expect(second).toEqual(first);
  expect(rig.opencodeContainer.specs).toHaveLength(1);
});

it("catalog_reports_missing_executable", async () => {
  const missing = createExecutableResolver({ PATH: "" }, "linux");
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    resolveExecutable: (provider, configured) =>
      provider === ProviderId.opencode
        ? missing(provider, configured)
        : RIG_CODEX_PATH,
  });

  const result = await rig.call("models/catalog", {});

  expect(result).toEqual({ models: [], error: OPENCODE_MISSING_MESSAGE });
  const codex = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });
  expect(codex.provider).toBe("codex");
});
