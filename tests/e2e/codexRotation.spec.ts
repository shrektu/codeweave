import { join } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";

import { PermissionProfile } from "../../src/domain/types";
import { startResponsesMock } from "../fakes/responsesMock";

import {
  CODEX_ROTATION_SCENARIOS,
  assertWorkspaceIsolated,
  createCodexRotationWorkspace,
} from "./codexRotationFixture";
import {
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  createCleanupStack,
  readEffectLines,
} from "./rotationFixture";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const STEP_TIMEOUT_MS = 120_000;
const SWITCH_ENTRY_PATTERN = /A → B · rate limit/;
const INHERITED_CREDENTIAL_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_HOME",
] as const;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

function launchEnv(userData: string): Record<string, string> {
  const inherited = Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ||
    INHERITED_CREDENTIAL_VARS.some((blocked) => blocked === name)
      ? []
      : [[name, value] as const],
  );
  return {
    ...Object.fromEntries(inherited),
    [USER_DATA_DIR_ENV]: userData,
    [TEST_AGENT_ENV_VAR]: JSON.stringify({}),
  };
}

async function expectRotationShown(page: Page): Promise<void> {
  await expect(page.getByRole("region", { name: "Switch log" })).toContainText(
    SWITCH_ENTRY_PATTERN,
    { timeout: STEP_TIMEOUT_MS },
  );
  const accounts = page
    .getByRole("region", { name: "Accounts" })
    .getByRole("listitem");
  await expect(accounts.filter({ hasText: /^B/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(accounts.filter({ hasText: /^A/ })).toContainText(/Exhausted ·/);
  await expect(
    page
      .getByRole("region", { name: "Limits" })
      .locator(".limit-block > .meter-head", { hasText: /^A/ }),
  ).toContainText("Exhausted");
  await expect(page.locator(".session-head .phase")).toContainText(
    /Idle on B/,
    { timeout: STEP_TIMEOUT_MS },
  );
  await expect(page.locator(".session-head .session-model")).toContainText(
    "mock-model",
    { timeout: STEP_TIMEOUT_MS },
  );
}

test("codex_rotation_ui_shows_switch_and_exhausted_account", async () => {
  const cleanup = createCleanupStack();
  try {
    const mock = await startResponsesMock(CODEX_ROTATION_SCENARIOS);
    cleanup.add(() => mock.close());
    const workspace = await createCodexRotationWorkspace(
      PermissionProfile.ask,
      mock.url,
    );
    cleanup.add(() => workspace.dispose());
    assertWorkspaceIsolated(workspace, mock.url);
    const app = await electron.launch({
      args: [".", ...SANDBOX_FLAGS],
      cwd: ROOT_DIR,
      env: launchEnv(workspace.userData),
    });
    cleanup.add(() => app.close());
    await app.evaluate(({ dialog }, repo) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [repo] });
    }, workspace.repo);
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );

    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByPlaceholder("Describe the task").fill(ROTATION_PROMPT);
    await page.getByRole("button", { name: "Send" }).click();

    const card = page.locator(".card.ask");
    await expect(card).toContainText(ROTATION_COMMAND, {
      timeout: STEP_TIMEOUT_MS,
    });
    await card.getByRole("button", { name: "Allow", exact: true }).click();

    await expectRotationShown(page);
    expect(await readEffectLines(workspace.repo)).toEqual([
      "deploy-side-effect",
    ]);
  } finally {
    await cleanup.run();
  }
});
