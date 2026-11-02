import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import {
  GeminiRequestKind,
  GeminiScenario,
  startGeminiApiMock,
  type GeminiApiMock,
} from "../fakes/geminiApiMock";
import { ChatScenario, startOpenaiChatMock } from "../fakes/openaiChatMock";

import {
  AGY_ACCOUNT_LABEL,
  agyBinaryOnPath,
  agyConfigDir,
  assertAgyIsolated,
  createAgyIsolation,
  startChatProxy,
  writeAgySettings,
  type AgyIsolation,
  type ChatProxy,
} from "./agyRotationFixture";
import { OPENCODE_KEY_B, writeKeyringPreload } from "./opencodeRotationFixture";
import {
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  WORKSPACE_PREFIX,
  createCleanupStack,
  createRepo,
  readEffectLines,
  type CleanupStack,
} from "./rotationFixture";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const STEP_TIMEOUT_MS = 120_000;
const ADD_TIMEOUT_MS = 30_000;
const SWITCH_ENTRY_PATTERN = /A → B · rate limit/;
const GEMINI_OPTION = "Gemini";
const OPENCODE_OPTION = "OpenCode (API key)";
const OPENCODE_LABEL = "B";
const MOCK_MODEL = "mock-model";
const EXPECTED_MAIN_REQUESTS = 2;
const CONTEXT_INTRO =
  "You are taking over a coding session from another account that hit its usage limit.";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

interface Setup {
  readonly userData: string;
  readonly repo: string;
  readonly gemini: GeminiApiMock;
  readonly proxy: ChatProxy;
  readonly isolation: AgyIsolation;
  readonly app: ElectronApplication;
}

async function launchApp(
  root: string,
  userData: string,
  isolation: AgyIsolation,
): Promise<ElectronApplication> {
  assertAgyIsolated(isolation);
  const keyringArgs =
    process.platform === "linux" ? ["-r", await writeKeyringPreload(root)] : [];
  return electron.launch({
    args: [...keyringArgs, ".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [USER_DATA_DIR_ENV]: userData,
      [TEST_AGENT_ENV_VAR]: JSON.stringify(isolation.agentEnv),
    },
  });
}

async function submitAccount(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(
    dialog.getByRole("listitem").filter({ hasText: new RegExp(`^${label}`) }),
  ).toBeVisible({ timeout: ADD_TIMEOUT_MS });
}

async function addGeminiAccount(page: Page, configDir: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByLabel("Agent").selectOption({ label: GEMINI_OPTION });
  await dialog.getByLabel("Label", { exact: true }).fill(AGY_ACCOUNT_LABEL);
  await dialog.getByLabel("Config directory").fill(configDir);
  await submitAccount(page, AGY_ACCOUNT_LABEL);
}

async function addOpencodeAccount(
  page: Page,
  configDir: string,
  baseUrl: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByLabel("Agent").selectOption({ label: OPENCODE_OPTION });
  await dialog.getByLabel("Label", { exact: true }).fill(OPENCODE_LABEL);
  await dialog.getByLabel("Config directory").fill(configDir);
  await dialog.getByLabel("API provider").selectOption("custom");
  await dialog.getByLabel("Model", { exact: true }).fill(MOCK_MODEL);
  await dialog.getByLabel("Base URL").fill(baseUrl);
  await dialog.getByLabel("API key").fill(OPENCODE_KEY_B);
  await submitAccount(page, OPENCODE_LABEL);
}

async function chooseUnattendedProfile(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const unattended = page.getByRole("radio", {
    name: "Unattended",
    exact: true,
  });
  await unattended.click();
  await expect(unattended).toBeChecked();
  await page.getByRole("button", { name: "Close" }).click();
}

async function prepare(cleanup: CleanupStack): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  cleanup.add(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  await createRepo(repo);
  const gemini = await startGeminiApiMock({
    scenario: GeminiScenario.toolThen429,
    toolCommand: ROTATION_COMMAND,
  });
  cleanup.add(() => gemini.close());
  const chat = await startOpenaiChatMock({
    scenarios: { [OPENCODE_KEY_B]: ChatScenario.ok },
    toolCommand: ROTATION_COMMAND,
  });
  cleanup.add(() => chat.close());
  const proxy = await startChatProxy(chat.url);
  cleanup.add(() => proxy.close());
  const isolation = await createAgyIsolation(
    root,
    agyConfigDir(userData),
    gemini.baseUrl,
  );
  await writeAgySettings(isolation);
  const app = await launchApp(root, userData, isolation);
  cleanup.add(() => app.close());
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [folder] });
  }, repo);
  return { userData, repo, gemini, proxy, isolation, app };
}

async function addAccounts(page: Page, setup: Setup): Promise<void> {
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await addGeminiAccount(page, setup.isolation.geminiDir);
  await addOpencodeAccount(
    page,
    join(setup.userData, "accounts", OPENCODE_LABEL.toLowerCase()),
    setup.proxy.url,
  );
  await page.getByRole("button", { name: "Close" }).click();
}

test("agy_ui_rotates_gemini_to_opencode_after_quota", async () => {
  agyBinaryOnPath();
  const cleanup = createCleanupStack();
  try {
    const setup = await prepare(cleanup);
    const { repo, gemini, proxy } = setup;
    const page = await setup.app.firstWindow();
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );

    await addAccounts(page, setup);
    await chooseUnattendedProfile(page);

    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByPlaceholder("Describe the task").fill(ROTATION_PROMPT);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByRole("region", { name: "Switch log" }),
    ).toContainText(SWITCH_ENTRY_PATTERN, { timeout: STEP_TIMEOUT_MS });
    await expect(page.locator(".session-head .phase")).toContainText(
      /Idle on B/,
      { timeout: STEP_TIMEOUT_MS },
    );
    expect(await readEffectLines(repo)).toEqual(["deploy-side-effect"]);
    expect(gemini.requests(GeminiRequestKind.main)).toHaveLength(
      EXPECTED_MAIN_REQUESTS,
    );
    const handover = proxy.requests().find((request) => request.hasTools);
    expect(handover?.body).toContain(CONTEXT_INTRO);
  } finally {
    await cleanup.run();
  }
});
