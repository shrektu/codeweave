import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { GeminiScenario, startGeminiApiMock } from "../fakes/geminiApiMock";

import {
  addGeminiAccount,
  agyBinaryOnPath,
  agyConfigDir,
  chooseProfile,
  createAgyIsolation,
  launchApp,
  stubFolderDialog,
  writeAgySettings,
} from "./agyRotationFixture";
import { firstReadyWindow } from "./appWindow";
import {
  REPO_SEED_FILE,
  WORKSPACE_PREFIX,
  createCleanupStack,
  createRepo,
  type CleanupStack,
} from "./rotationFixture";

const STEP_TIMEOUT_MS = 120_000;
const ACCEPT_EDITS_PROFILE = "Accept edits";
const CREATED_FILE = "notes.txt";
const CREATED_CONTENT = "first line\nsecond line\n";
const EDIT_TARGET = "rotation test";
const EDIT_REPLACEMENT = "diff test";
const EDITED_CONTENT = `${EDIT_REPLACEMENT}\n`;
const PROMPT = "Create notes.txt and update the readme";
const SCREENSHOT_PATH = "test-results/agy-edit-diff.png";
const IDLE_PATTERN = /Idle on A/;

function diffFileOf(page: Page, path: string): Locator {
  return page
    .locator(".diff-file")
    .filter({ has: page.getByText(path, { exact: true }) });
}

function lineOf(diffFile: Locator, kind: string, text: string): Locator {
  return diffFile.locator(`.diff-line[data-kind="${kind}"]`, {
    hasText: text,
  });
}

async function prepare(cleanup: CleanupStack): Promise<{
  readonly repo: string;
  readonly page: Page;
}> {
  const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  cleanup.add(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  await createRepo(repo);
  const gemini = await startGeminiApiMock({
    scenario: GeminiScenario.editFile,
    editFiles: {
      createPath: join(repo, CREATED_FILE),
      editPath: join(repo, REPO_SEED_FILE),
      editTarget: EDIT_TARGET,
      editReplacement: EDIT_REPLACEMENT,
    },
  });
  cleanup.add(() => gemini.close());
  const isolation = await createAgyIsolation(
    root,
    agyConfigDir(userData),
    gemini.baseUrl,
  );
  await writeAgySettings(isolation);
  const app = await launchApp(root, userData, isolation);
  cleanup.add(() => app.close());
  await stubFolderDialog(app, repo);
  const page = await firstReadyWindow(app);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await addGeminiAccount(page, isolation.geminiDir);
  await page.getByRole("button", { name: "Close" }).click();
  return { repo, page };
}

test("agy_edit_card_shows_real_diff", async () => {
  agyBinaryOnPath();
  const cleanup = createCleanupStack();
  try {
    const { repo, page } = await prepare(cleanup);
    await chooseProfile(page, ACCEPT_EDITS_PROFILE);

    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByPlaceholder("Describe the task").fill(PROMPT);
    await page.getByRole("button", { name: "Send" }).click();

    const created = diffFileOf(page, CREATED_FILE);
    const modified = diffFileOf(page, REPO_SEED_FILE);
    await expect(created).toContainText("Created", {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(lineOf(created, "add", "+first line")).toBeVisible();
    await expect(modified).toContainText("Modified", {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(lineOf(modified, "del", `-${EDIT_TARGET}`)).toBeVisible();
    await expect(lineOf(modified, "add", `+${EDIT_REPLACEMENT}`)).toBeVisible();
    await expect(page.locator(".session-head .phase")).toContainText(
      IDLE_PATTERN,
      { timeout: STEP_TIMEOUT_MS },
    );

    expect(await readFile(join(repo, CREATED_FILE), "utf8")).toBe(
      CREATED_CONTENT,
    );
    expect(await readFile(join(repo, REPO_SEED_FILE), "utf8")).toBe(
      EDITED_CONTENT,
    );
    await page
      .getByRole("region", { name: "Session" })
      .screenshot({ path: SCREENSHOT_PATH });
  } finally {
    await cleanup.run();
  }
});
