import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

import { startOpenaiChatMock } from "../fakes/openaiChatMock";

import { firstReadyWindow } from "./appWindow";
import {
  OPENCODE_ACCOUNT_SPECS,
  OPENCODE_GO_ROUTING_ACCOUNT_SPEC,
  OPENCODE_GO_ROUTING_SCENARIOS,
  OPENCODE_KEY_GO_A,
  OPENCODE_KEY_GROQ,
  OPENCODE_KEYS,
  OPENCODE_ROUTING_ACCOUNT_SPEC,
  OPENCODE_ROUTING_SCENARIOS,
  OPENCODE_ROTATION_SCENARIOS,
  findKeyLeaks,
  opencodeBinaryOnPath,
  pointAccountsAtMock,
  writeKeyringPreload,
  type OpencodeAccountSpec,
} from "./opencodeRotationFixture";
import {
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  WORKSPACE_PREFIX,
  createCleanupStack,
  createRepo,
  readEffectLines,
} from "./rotationFixture";
import { typeConfigDirectory } from "./pathFieldE2e";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const STEP_TIMEOUT_MS = 120_000;
const ADD_TIMEOUT_MS = 30_000;
const VAULT_TIMEOUT_MS = 15_000;
const SWITCH_ENTRY_PATTERN = /A → B · rate limit/;
const AGENT_OPTION = "OpenCode (API key)";
const API_PROVIDER_VALUE = "custom";
const MOCK_MODEL = "mock-model";
const KEY_HINT_LENGTH = 4;
const LIGHT_MODEL = "openai/gpt-oss-20b";
const HEAVY_MODEL = "openai/gpt-oss-120b";
const LIGHT_BADGE = `${LIGHT_MODEL} · light`;
const HEAVY_BADGE = `${HEAVY_MODEL} · heavy`;
const GO_LIGHT_MODEL = "mimo-v2.6-flash";
const GO_LIGHT_BADGE = `${GO_LIGHT_MODEL} · light`;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

async function addAccount(
  page: Page,
  spec: OpencodeAccountSpec,
  mockUrl: string,
  configDir: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByLabel("Agent").selectOption({ label: AGENT_OPTION });
  await dialog.getByLabel("Label", { exact: true }).fill(spec.label);
  await typeConfigDirectory(dialog, configDir);
  const apiProvider = spec.provider ?? API_PROVIDER_VALUE;
  await dialog.getByLabel("API provider").selectOption(apiProvider);
  await dialog
    .getByLabel("Model", { exact: true })
    .fill(spec.model ?? MOCK_MODEL);
  if (apiProvider === API_PROVIDER_VALUE) {
    await dialog.getByLabel("Base URL").fill(mockUrl);
  }
  await dialog.getByLabel("API key").fill(spec.apiKey);
  const failure = dialog.locator("form.add-account p.error");
  const submit = dialog.getByRole("button", { name: "Add account" });
  try {
    await expect(submit).toBeEnabled({ timeout: VAULT_TIMEOUT_MS });
  } catch (error) {
    await rethrowWithReason(failure, error);
  }
  await submit.click();
  const row = dialog.getByRole("listitem").filter({
    hasText: new RegExp(`^${spec.label}`),
  });
  try {
    await expect(row).toContainText(
      `Key …${spec.apiKey.slice(-KEY_HINT_LENGTH)}`,
      { timeout: ADD_TIMEOUT_MS },
    );
  } catch (error) {
    await rethrowWithReason(failure, error);
  }
}

async function rethrowWithReason(
  failure: Locator,
  error: unknown,
): Promise<never> {
  const reason = (await failure.allInnerTexts()).join("; ");
  if (reason === "") {
    throw error;
  }
  throw new Error(`adding an account failed: ${reason}`, { cause: error });
}

async function launchApp(
  root: string,
  userData: string,
): Promise<ElectronApplication> {
  const keyringArgs =
    process.platform === "linux" ? ["-r", await writeKeyringPreload(root)] : [];
  return electron.launch({
    args: [...keyringArgs, ".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [USER_DATA_DIR_ENV]: userData,
      [TEST_AGENT_ENV_VAR]: JSON.stringify({}),
    },
  });
}

async function addAccounts(
  page: Page,
  userData: string,
  mockUrl: string,
  specs: readonly OpencodeAccountSpec[] = OPENCODE_ACCOUNT_SPECS,
): Promise<void> {
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  for (const spec of specs) {
    await addAccount(
      page,
      spec,
      mockUrl,
      join(userData, "accounts", spec.label.toLowerCase()),
    );
  }
  await page.getByRole("button", { name: "Close" }).click();
}

async function chooseAskProfile(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const ask = page.getByRole("radio", { name: "Ask", exact: true });
  await ask.click();
  await expect(ask).toBeChecked();
  await page.getByRole("button", { name: "Close" }).click();
}

test("opencode_ui_rotates_api_key_a_to_b", async () => {
  opencodeBinaryOnPath();
  const cleanup = createCleanupStack();
  try {
    const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
    cleanup.add(() => rm(root, { recursive: true, force: true }));
    const userData = join(root, "user-data");
    const repo = join(root, "repo");
    await createRepo(repo);
    const mock = await startOpenaiChatMock({
      scenarios: OPENCODE_ROTATION_SCENARIOS,
      toolCommand: ROTATION_COMMAND,
    });
    cleanup.add(() => mock.close());
    const app = await launchApp(root, userData);
    cleanup.add(() => app.close());
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [folder] });
    }, repo);
    const page = await firstReadyWindow(app);

    await addAccounts(page, userData, mock.url);
    await chooseAskProfile(page);

    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByPlaceholder("Describe the task").fill(ROTATION_PROMPT);
    await page.getByRole("button", { name: "Send" }).click();

    const card = page.locator(".card.ask");
    await expect(card).toContainText(ROTATION_COMMAND, {
      timeout: STEP_TIMEOUT_MS,
    });
    await card.getByRole("button", { name: "Allow once", exact: true }).click();

    await expect(
      page.getByRole("region", { name: "Switch log" }),
    ).toContainText(SWITCH_ENTRY_PATTERN, { timeout: STEP_TIMEOUT_MS });
    await expect(page.locator(".session-head .phase")).toContainText(
      /Idle on B/,
      { timeout: STEP_TIMEOUT_MS },
    );
    expect(await readEffectLines(repo)).toEqual(["deploy-side-effect"]);
    expect(await findKeyLeaks([userData], OPENCODE_KEYS)).toEqual([]);
  } finally {
    await cleanup.run();
  }
});

async function stubFolderDialog(
  app: ElectronApplication,
  folder: string,
): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [picked] });
  }, folder);
}

async function sendWithClass(
  page: Page,
  taskClass: string,
  prompt: string,
): Promise<void> {
  await page.getByLabel("Task class").selectOption(taskClass);
  await page.getByPlaceholder("Describe the task").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
}

async function seedRoutingAccount(
  root: string,
  userData: string,
  mockUrl: string,
  spec: OpencodeAccountSpec = OPENCODE_ROUTING_ACCOUNT_SPEC,
): Promise<void> {
  const setup = await launchApp(root, userData);
  const page = await firstReadyWindow(setup);
  await addAccounts(page, userData, mockUrl, [spec]);
  await setup.close();
  await pointAccountsAtMock(userData, mockUrl);
}

test("composer classes route the real opencode", async () => {
  opencodeBinaryOnPath();
  const cleanup = createCleanupStack();
  try {
    const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
    cleanup.add(() => rm(root, { recursive: true, force: true }));
    const userData = join(root, "user-data");
    const repo = join(root, "repo");
    await createRepo(repo);
    const mock = await startOpenaiChatMock({
      scenarios: OPENCODE_ROUTING_SCENARIOS,
      toolCommand: ROTATION_COMMAND,
    });
    cleanup.add(() => mock.close());

    await seedRoutingAccount(root, userData, mock.url);

    const app = await launchApp(root, userData);
    cleanup.add(() => app.close());
    await stubFolderDialog(app, repo);
    const page = await firstReadyWindow(app);
    await page.getByRole("button", { name: "Choose folder…" }).click();

    const badges = page.locator(".turn-badge");
    const idle = page.locator(".session-head .phase");
    await sendWithClass(page, "light", "Say hello");
    await expect(badges.nth(0)).toContainText(LIGHT_BADGE, {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(idle).toContainText(/Idle on G/, {
      timeout: STEP_TIMEOUT_MS,
    });
    await sendWithClass(page, "heavy", "Say hello again");
    await expect(badges.nth(1)).toContainText(HEAVY_BADGE, {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(idle).toContainText(/Idle on G/, {
      timeout: STEP_TIMEOUT_MS,
    });

    expect(
      mock
        .requests()
        .filter((request) => request.hasTools)
        .map((request) => request.model),
    ).toEqual([LIGHT_MODEL, HEAVY_MODEL]);
    expect(await findKeyLeaks([userData], [OPENCODE_KEY_GROQ])).toEqual([]);
  } finally {
    await cleanup.run();
  }
});

test("seeded go account routes a light turn", async () => {
  opencodeBinaryOnPath();
  const cleanup = createCleanupStack();
  try {
    const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
    cleanup.add(() => rm(root, { recursive: true, force: true }));
    const userData = join(root, "user-data");
    const repo = join(root, "repo");
    await createRepo(repo);
    const mock = await startOpenaiChatMock({
      scenarios: OPENCODE_GO_ROUTING_SCENARIOS,
      toolCommand: ROTATION_COMMAND,
    });
    cleanup.add(() => mock.close());

    await seedRoutingAccount(
      root,
      userData,
      mock.url,
      OPENCODE_GO_ROUTING_ACCOUNT_SPEC,
    );

    const app = await launchApp(root, userData);
    cleanup.add(() => app.close());
    await stubFolderDialog(app, repo);
    const page = await firstReadyWindow(app);
    await page.getByRole("button", { name: "Choose folder…" }).click();

    await sendWithClass(page, "light", "Say hello");
    await expect(page.locator(".turn-badge").nth(0)).toContainText(
      GO_LIGHT_BADGE,
      { timeout: STEP_TIMEOUT_MS },
    );
    await expect(page.locator(".session-head .phase")).toContainText(
      /Idle on GO/,
      { timeout: STEP_TIMEOUT_MS },
    );

    expect(
      mock
        .requests()
        .filter((request) => request.hasTools)
        .map((request) => request.model),
    ).toEqual([GO_LIGHT_MODEL]);
    expect(await findKeyLeaks([userData], [OPENCODE_KEY_GO_A])).toEqual([]);
  } finally {
    await cleanup.run();
  }
});
