import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { PermissionProfile } from "../../src/domain/types";
import { startAnthropicMock } from "../fakes/anthropicMock";

import {
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  ROTATION_SCENARIOS,
  createCleanupStack,
  createRotationWorkspace,
  rotationAgentEnv,
  readEffectLines,
} from "./rotationFixture";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const STEP_TIMEOUT_MS = 120_000;
const SWITCH_ENTRY_PATTERN = /A → B · rate limit/;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

test("rotation_ui_shows_switch_after_card_click", async () => {
  const cleanup = createCleanupStack();
  try {
    const workspace = await createRotationWorkspace(PermissionProfile.ask);
    cleanup.add(() => workspace.dispose());
    const mock = await startAnthropicMock({
      scenarios: ROTATION_SCENARIOS,
      toolCommand: ROTATION_COMMAND,
    });
    cleanup.add(() => mock.close());
    const app = await electron.launch({
      args: [".", ...SANDBOX_FLAGS],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        [USER_DATA_DIR_ENV]: workspace.userData,
        [TEST_AGENT_ENV_VAR]: JSON.stringify(rotationAgentEnv(mock.url)),
      },
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
    await card.getByRole("button", { name: "Yes", exact: true }).click();

    await expect(
      page.getByRole("region", { name: "Switch log" }),
    ).toContainText(SWITCH_ENTRY_PATTERN, { timeout: STEP_TIMEOUT_MS });
    await expect(
      page
        .getByRole("region", { name: "Accounts" })
        .getByRole("listitem")
        .filter({ hasText: /^B/ }),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      page
        .getByRole("region", { name: "Accounts" })
        .getByRole("listitem")
        .filter({ hasText: /^A/ }),
    ).toContainText(/Exhausted ·/);
    await expect(page.locator(".session-head .phase")).toContainText(
      /Idle on B/,
      { timeout: STEP_TIMEOUT_MS },
    );
    const toolTexts = await page.locator(".card.tool").allInnerTexts();
    expect(toolTexts.length).toBeGreaterThan(0);
    expect(toolTexts.join("\n")).not.toContain("```");
    expect(await readEffectLines(workspace.repo)).toEqual([
      "deploy-side-effect",
    ]);
  } finally {
    await cleanup.run();
  }
});
