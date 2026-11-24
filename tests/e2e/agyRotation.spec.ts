import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
  addGeminiAccount,
  agyBinaryOnPath,
  agyConfigDir,
  chooseProfile,
  createAgyIsolation,
  launchApp,
  startChatProxy,
  stubFolderDialog,
  submitAccount,
  writeAgySettings,
  type AgyIsolation,
  type ChatProxy,
} from "./agyRotationFixture";
import { OPENCODE_KEY_B } from "./opencodeRotationFixture";
import {
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  WORKSPACE_PREFIX,
  createCleanupStack,
  createRepo,
  readEffectLines,
  type CleanupStack,
} from "./rotationFixture";
import { typeConfigDirectory } from "./pathFieldE2e";

const STEP_TIMEOUT_MS = 120_000;
const SWITCH_ENTRY_PATTERN = /A → B · rate limit/;
const OPENCODE_OPTION = "OpenCode (API key)";
const OPENCODE_LABEL = "B";
const MOCK_MODEL = "mock-model";
const EXPECTED_MAIN_REQUESTS = 2;
const UNATTENDED_PROFILE = "Unattended";
const CONTEXT_INTRO =
  "You are taking over a coding session from another account that hit its usage limit.";

interface Setup {
  readonly userData: string;
  readonly repo: string;
  readonly gemini: GeminiApiMock;
  readonly proxy: ChatProxy;
  readonly isolation: AgyIsolation;
  readonly app: ElectronApplication;
}

async function addOpencodeAccount(
  page: Page,
  configDir: string,
  baseUrl: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Accounts" });
  await dialog.getByLabel("Agent").selectOption({ label: OPENCODE_OPTION });
  await dialog.getByLabel("Label", { exact: true }).fill(OPENCODE_LABEL);
  await typeConfigDirectory(dialog, configDir);
  await dialog.getByLabel("API provider").selectOption("custom");
  await dialog.getByLabel("Model", { exact: true }).fill(MOCK_MODEL);
  await dialog.getByLabel("Base URL").fill(baseUrl);
  await dialog.getByLabel("API key").fill(OPENCODE_KEY_B);
  await submitAccount(page, OPENCODE_LABEL);
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
  await stubFolderDialog(app, repo);
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
    await chooseProfile(page, UNATTENDED_PROFILE);

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
