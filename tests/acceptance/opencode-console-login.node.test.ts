import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { ProviderId, type Account } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { AccountView } from "../../src/shared/views";
import {
  RIG_NOW_MS,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import {
  LOGGED_IN_OUTPUT,
  NEEDS_AUTH_OUTPUT,
  createFakeAuthCli,
} from "../fakes/fakeOpencodeAuth";
import type { OpencodeV2Step } from "../fakes/fakeOpencodeV2Server";
import type { OpencodeStep } from "../fakes/fakeOpencodeServer";
import { OPENCODE_SESSION_ID } from "../fakes/opencodeFakeCommon";
import { makeTempDir } from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

const CONSOLE_ID = "go-console";
const GO_MODEL = "kimi-k2.7-code";
const ZEN_MODEL = "big-pickle";
const KEY = "sk-test-zen-0001";
const KEY_FILE_NAME = "api-key";
const FILE_REFERENCE = "{file:";
const PROMPT_PATH = `/api/session/${OPENCODE_SESSION_ID}/prompt`;
const RESETS_AT = 1_700_000_120;
const PROBE_CYCLES_FIRST = 1;
const SHORT_PROBE_TIMEOUT_MS = 30;
const NEEDS_LOGIN_RUNTIME = { status: "needs_login" };

const V1_LIMIT_TURN: readonly OpencodeStep[] = [
  {
    type: "error",
    name: "APIError",
    message: "Rate limit exceeded",
    statusCode: 429,
    headers: { "retry-after": "120" },
  },
  { type: "idle" },
];

const GO_LIMIT_TURN: readonly OpencodeV2Step[] = [
  { type: "started" },
  {
    type: "failed",
    error: {
      type: "provider.go-limit",
      message: "OpenCode Go 5 hour usage limit reached.",
      status: 429,
      retryAfterMs: 120_000,
    },
  },
];

const StartupSchema = z.looseObject({
  providers: z.record(
    z.string(),
    z.looseObject({ settings: z.looseObject({ apiKey: z.string() }) }),
  ),
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRigs();
});

function dbPathOf(configDir: string): string {
  return join(configDir, "data", "opencode", "opencode.db");
}

async function writeLoginState(
  configDir: string,
  output: string,
): Promise<void> {
  await mkdir(dirname(dbPathOf(configDir)), { recursive: true });
  await writeFile(dbPathOf(configDir), output);
}

function consoleAccount(id: string, order: number, configDir: string): Account {
  return {
    id,
    provider: ProviderId.opencode,
    label: id,
    configDir,
    order,
    api: {
      provider: "opencode-go",
      model: GO_MODEL,
      baseUrl: null,
      rotation: true,
      auth: "console_login",
    },
  };
}

async function addKeyAccount(
  rig: BackendRig,
  provider: "groq" | "opencode-zen",
): Promise<string> {
  const { account } = await rig.call("accounts/add", {
    label: `${provider} key`,
    configDir: join(rig.userData, "accounts", provider),
    provider: ProviderId.opencode,
    api: {
      provider,
      model: provider === "groq" ? "llama-3.3-70b" : ZEN_MODEL,
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: KEY,
  });
  return account.id;
}

async function addConsoleAccount(rig: BackendRig): Promise<string> {
  const { account } = await rig.call("accounts/add", {
    label: "Go console",
    configDir: join(rig.userData, "accounts", "go-console"),
    provider: ProviderId.opencode,
    api: {
      provider: "opencode-go",
      model: GO_MODEL,
      baseUrl: null,
      rotation: true,
      auth: "console_login",
    },
  });
  return account.id;
}

async function cyclesDone(rig: BackendRig, count: number): Promise<void> {
  await settled(() => {
    expect(rig.probeTasks).toHaveLength(count);
  });
}

async function runtimeOf(rig: BackendRig, id: string): Promise<unknown> {
  const listed = await rig.call("accounts/list", {});
  return listed.accounts.find((account) => account.id === id)?.runtime;
}

it("console_login_go_account_launches_keyless_with_the_account_db", async () => {
  const configDir = await makeTempDir();
  await writeLoginState(configDir, LOGGED_IN_OUTPUT);
  const rig = await openRig({
    opencodeV2: true,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });
  await rig.call("session/prompt", {
    sessionId: (await rig.session()).id,
    text: "ship it",
  });

  expect(view.activeAccountId).toBe(CONSOLE_ID);
  const [spec] = rig.opencodeV2Container.specs;
  expect(spec?.env.OPENCODE_DB).toBe(dbPathOf(configDir));
  expect(spec?.env.XDG_DATA_HOME).toBe(join(configDir, "data"));
  expect(spec?.env.OPENCODE_TEST_HOME).toBe(join(configDir, "home"));
  expect(spec?.env.HOME).not.toBe(join(configDir, "home"));
  const [startup] = rig.opencodeV2Container.startups;
  expect(startup?.keyFileContent).toBeNull();
  expect(startup?.runDirEntries).not.toContain(KEY_FILE_NAME);
  expect(JSON.stringify(startup?.config)).not.toContain(FILE_REFERENCE);
  expect(StartupSchema.parse(startup?.config).providers).toEqual({});
  await settled(() => {
    expect(
      rig.opencodeV2Container.servers[0]?.requestsTo("POST", PROMPT_PATH),
    ).toHaveLength(1);
  });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(false);
  });
  expect((await rig.session()).phase).toEqual({
    phase: "running",
    accountId: CONSOLE_ID,
  });
});

it("logged_out_console_account_fails_to_start_with_needs_login_and_rotates", async () => {
  const rig = await openRig({ opencodeV2: true });
  await cyclesDone(rig, PROBE_CYCLES_FIRST);
  const consoleId = await addConsoleAccount(rig);
  const keyedId = await addKeyAccount(rig, "groq");

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });

  expect(view.activeAccountId).toBe(keyedId);
  expect(await runtimeOf(rig, consoleId)).toEqual(NEEDS_LOGIN_RUNTIME);
  expect(rig.opencodeV2Container.servers).toHaveLength(1);
  expect(rig.authCli.calls.length).toBeGreaterThan(0);
});

it("go_limit_on_a_console_account_rotates_like_a_key_account", async () => {
  const configDir = await makeTempDir();
  await writeLoginState(configDir, LOGGED_IN_OUTPUT);
  const rig = await openRig({
    opencodeV2: true,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });
  const keyedId = await addKeyAccount(rig, "groq");
  rig.opencodeV2Container.scriptNextServer(GO_LIMIT_TURN);

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });
  await rig.call("session/prompt", {
    sessionId: (await rig.session()).id,
    text: "ship the release",
  });

  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: keyedId,
    });
  });
  const [entry] = await rig.store.readSwitchLog(10);
  expect(entry).toMatchObject({
    at: RIG_NOW_MS,
    sessionId: started.id,
    from: CONSOLE_ID,
    to: keyedId,
    reason: "rate_limit",
    resetsAt: RESETS_AT,
  });
});

it("console_login_on_opencode_1x_is_refused_before_any_process", async () => {
  const rig = await openRig({});
  await addConsoleAccount(rig);

  await expect(
    rig.call("session/start", { cwd: rig.cwd, provider: "opencode" }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Account Go console needs login",
  });

  expect(rig.opencodeContainer.specs).toHaveLength(0);
  expect(rig.opencodeV2Container.specs).toHaveLength(0);
});

it("v1 console account is skipped at session start", async () => {
  const configDir = await makeTempDir();
  const rig = await openRig({
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });
  const keyedId = await addKeyAccount(rig, "groq");

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });

  expect(view.activeAccountId).toBe(keyedId);
  expect(await runtimeOf(rig, CONSOLE_ID)).toEqual(NEEDS_LOGIN_RUNTIME);
  expect(rig.opencodeContainer.specs).toHaveLength(1);
  expect(rig.opencodeV2Container.specs).toHaveLength(0);
});

it("v1 console account is skipped by rotation instead of aborting the session", async () => {
  const rig = await openRig({});
  const firstKeyId = await addKeyAccount(rig, "groq");
  const consoleId = await addConsoleAccount(rig);
  const lastKeyId = await addKeyAccount(rig, "opencode-zen");
  rig.opencodeContainer.scriptNextServer(V1_LIMIT_TURN);

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });
  await rig.call("session/prompt", {
    sessionId: (await rig.session()).id,
    text: "ship the release",
  });

  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: lastKeyId,
    });
  });
  expect(started.activeAccountId).toBe(firstKeyId);
  expect(await runtimeOf(rig, consoleId)).toEqual(NEEDS_LOGIN_RUNTIME);
  expect(rig.opencodeContainer.specs).toHaveLength(2);
});

it("v1 console limit probe reports needs login", async () => {
  const configDir = await makeTempDir();
  const rig = await openRig({
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });

  await cyclesDone(rig, PROBE_CYCLES_FIRST);

  expect(await runtimeOf(rig, CONSOLE_ID)).toEqual(NEEDS_LOGIN_RUNTIME);
  expect(rig.authCli.calls).toEqual([]);
});

it("limit_probe_follows_the_console_login_state_and_skips_key_accounts", async () => {
  const configDir = await makeTempDir();
  const rig = await openRig({
    opencodeV2: true,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });
  await cyclesDone(rig, PROBE_CYCLES_FIRST);
  await addKeyAccount(rig, "groq");
  expect(await runtimeOf(rig, CONSOLE_ID)).toEqual(NEEDS_LOGIN_RUNTIME);

  await writeLoginState(configDir, LOGGED_IN_OUTPUT);
  await settled(() => {
    expect(rig.probeTasks.some((task) => !task.cancelled)).toBe(true);
  });
  rig.probeTasks.find((task) => !task.cancelled)?.run();

  await settled(async () => {
    expect(await runtimeOf(rig, CONSOLE_ID)).toEqual({ status: "ready" });
  });
  expect(new Set(rig.authCli.calls.map((call) => call.db))).toEqual(
    new Set([dbPathOf(configDir)]),
  );
});

it("revoked_console_login_in_the_probe_reads_as_needs_login", async () => {
  const configDir = await makeTempDir();
  await writeLoginState(configDir, NEEDS_AUTH_OUTPUT);
  const rig = await openRig({
    opencodeV2: true,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });

  await cyclesDone(rig, PROBE_CYCLES_FIRST);

  expect(await runtimeOf(rig, CONSOLE_ID)).toEqual(NEEDS_LOGIN_RUNTIME);
});

async function viewOf(rig: BackendRig, id: string): Promise<AccountView> {
  const found = (await rig.call("accounts/list", {})).accounts.find(
    (account) => account.id === id,
  );
  if (found === undefined) {
    throw new Error(`account ${id} is not listed`);
  }
  return found;
}

async function loggedInRig(usageOutput: string | Error): Promise<BackendRig> {
  const configDir = await makeTempDir();
  await writeLoginState(configDir, LOGGED_IN_OUTPUT);
  const authCli = createFakeAuthCli();
  if (usageOutput instanceof Error) {
    authCli.usageFailure = usageOutput;
  } else {
    authCli.usageOutput = usageOutput;
  }
  const rig = await openRig({
    opencodeV2: true,
    authCli,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });
  await cyclesDone(rig, PROBE_CYCLES_FIRST);
  return rig;
}

function usageOutputOf(data: unknown): string {
  return JSON.stringify({ location: { directory: "/x" }, data });
}

const GO_ROLLING_RESET_MS = 1_700_003_600_000;
const GO_WEEKLY_RESET_MS = 1_700_100_000_000;
const GO_MONTHLY_RESET_MS = 1_702_000_000_000;
const BUDGET_RESET_MS = 1_701_000_000_000;

const GO_USAGE_OUTPUT = usageOutputOf({
  workspace: { id: "wrk_1", name: "Personal", usageURL: "https://x/usage" },
  go: {
    rolling: { percent: 12.5, limited: false, resetsAt: GO_ROLLING_RESET_MS },
    weekly: { percent: 40, limited: false, resetsAt: GO_WEEKLY_RESET_MS },
    monthly: { percent: 100, limited: true, resetsAt: GO_MONTHLY_RESET_MS },
  },
  budgets: [{ id: "bud_1", limit: 50, spent: 12.5, resetsAt: BUDGET_RESET_MS }],
});

it("console_account_reports_go_windows", async () => {
  const rig = await loggedInRig(GO_USAGE_OUTPUT);

  expect(await viewOf(rig, CONSOLE_ID)).toMatchObject({
    runtime: { status: "ready" },
    limitAvailability: "reported",
    limit: {
      status: "allowed",
      rateLimitType: "monthly",
      utilization: 1,
      resetsAt: 1_702_000_000,
      windows: [
        {
          id: "five_hour",
          scope: null,
          period: "five_hour",
          utilization: 0.125,
          resetsAt: 1_700_003_600,
          exhausted: false,
        },
        {
          id: "seven_day",
          scope: null,
          period: "seven_day",
          utilization: 0.4,
          resetsAt: 1_700_100_000,
          exhausted: false,
        },
        {
          id: "monthly",
          scope: null,
          period: "monthly",
          utilization: 1,
          resetsAt: 1_702_000_000,
          exhausted: true,
        },
        {
          id: "budget:bud_1",
          scope: "Budget $12.50 of $50",
          period: "monthly",
          utilization: 0.25,
          resetsAt: 1_701_000_000,
          exhausted: false,
        },
      ],
    },
  });
});

it("console_account_without_allowance_reports_unsupported", async () => {
  const rig = await loggedInRig(usageOutputOf({ budgets: [] }));

  expect(await viewOf(rig, CONSOLE_ID)).toMatchObject({
    runtime: { status: "ready" },
    limit: null,
    limitAvailability: "unsupported",
  });
});

it("console_usage_failure_reports_failed_not_needs_login", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await loggedInRig(new Error("exit 1"));

  expect(await viewOf(rig, CONSOLE_ID)).toMatchObject({
    runtime: { status: "ready" },
    limit: null,
    limitAvailability: "failed",
  });
});

it("console_usage_failure_keeps_last_windows", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await loggedInRig(GO_USAGE_OUTPUT);
  const before = await viewOf(rig, CONSOLE_ID);
  rig.authCli.usageFailure = new Error("exit 1");

  const task = rig.probeTasks.findLast((candidate) => !candidate.cancelled);
  task?.run();
  await cyclesDone(rig, PROBE_CYCLES_FIRST + 1);

  const after = await viewOf(rig, CONSOLE_ID);
  expect(after.limitAvailability).toBe("reported");
  expect(after.limit?.windows).toHaveLength(4);
  expect(after.limit).toEqual(before.limit);
});

it("console login probe timeout does not block the session start", async () => {
  const configDir = await makeTempDir();
  await writeLoginState(configDir, LOGGED_IN_OUTPUT);
  const authCli = createFakeAuthCli();
  const rig = await openRig({
    opencodeV2: true,
    authCli,
    consoleLoginTimeoutMs: SHORT_PROBE_TIMEOUT_MS,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });
  await cyclesDone(rig, PROBE_CYCLES_FIRST);
  authCli.hangNext = 1;
  const callsBefore = authCli.calls.length;

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });

  expect(view.activeAccountId).toBe(CONSOLE_ID);
  expect(authCli.calls).toHaveLength(callsBefore + 1);
  expect(authCli.calls.at(-1)?.timeoutMs).toBe(SHORT_PROBE_TIMEOUT_MS);
  expect(rig.opencodeV2Container.servers).toHaveLength(1);
});

it("session start while the background probe of the same console account runs releases the probe first", async () => {
  const configDir = await makeTempDir();
  await writeLoginState(configDir, LOGGED_IN_OUTPUT);
  const authCli = createFakeAuthCli();
  authCli.hangNext = 1;
  const rig = await openRig({
    opencodeV2: true,
    authCli,
    accounts: [consoleAccount(CONSOLE_ID, 0, configDir)],
  });
  await settled(() => {
    expect(authCli.calls).toHaveLength(1);
  });

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });

  expect(view.activeAccountId).toBe(CONSOLE_ID);
  expect(authCli.calls.length).toBeGreaterThanOrEqual(2);
  expect(rig.opencodeV2Container.servers).toHaveLength(1);
});

it("limit probe never runs auth list for api key opencode accounts", async () => {
  const rig = await openRig({ opencodeV2: true });
  await cyclesDone(rig, PROBE_CYCLES_FIRST);
  await addKeyAccount(rig, "groq");
  await addKeyAccount(rig, "opencode-zen");
  await settled(() => {
    expect(rig.probeTasks.some((task) => !task.cancelled)).toBe(true);
  });
  rig.probeTasks.find((task) => !task.cancelled)?.run();

  await settled(() => {
    expect(rig.probeTasks.filter((task) => !task.cancelled)).toHaveLength(1);
  });

  expect(rig.authCli.calls).toEqual([]);
});

it("zen_key_account_launches_provider_opencode_and_the_catalog_lists_zen", async () => {
  const rig = await openRig({
    opencodeV2: true,
    opencodeV2Config: {
      models: [
        {
          id: ZEN_MODEL,
          providerID: "opencode",
          name: "Big Pickle",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [{ input: 0, output: 0 }],
          limit: { context: 200_000 },
        },
      ],
    },
  });
  const zenId = await addKeyAccount(rig, "opencode-zen");

  const view = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });
  const catalog = await rig.call("models/catalog", {});

  expect(view.activeAccountId).toBe(zenId);
  const [startup] = rig.opencodeV2Container.startups;
  const providers = StartupSchema.parse(startup?.config).providers;
  expect(Object.keys(providers)).toEqual(["opencode"]);
  expect(providers.opencode?.settings.apiKey).toMatch(/^\{file:/);
  expect(startup?.keyFileContent).toBe(KEY);
  expect(
    catalog.models
      .filter((model) => model.providerId === "opencode-zen")
      .map((model) => model.modelId),
  ).toEqual([ZEN_MODEL]);
});
