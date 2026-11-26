import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { DEFINITION_LIBRARY_DIR_NAME } from "../../src/backend/constants";
import { MockScenario, startAnthropicMock } from "../fakes/anthropicMock";

import {
  FLOW_TASK,
  createFlowWorkspace,
  flowReply,
  launchFlowApp,
  writeFlowFiles,
} from "./flowRunFixture";
import { KEY_A, ROTATION_COMMAND, createCleanupStack } from "./rotationFixture";

const STEP_TIMEOUT_MS = 120_000;
const LIBRARY_LABEL = "Library";

test("library_flow_is_listed_and_runs_without_project_definitions", async () => {
  const cleanup = createCleanupStack();
  try {
    const workspace = await createFlowWorkspace();
    cleanup.add(() => workspace.dispose());
    const library = join(workspace.userData, DEFINITION_LIBRARY_DIR_NAME);
    await rm(join(workspace.repo, "agents"), { recursive: true });
    await rm(join(workspace.repo, "flows"), { recursive: true });
    await mkdir(library, { recursive: true });
    await writeFlowFiles(library);
    const mock = await startAnthropicMock({
      scenarios: { [KEY_A]: MockScenario.ok },
      toolCommand: ROTATION_COMMAND,
      replyText: flowReply,
    });
    cleanup.add(() => mock.close());
    const page = await launchFlowApp(workspace, mock.url, cleanup);

    await page.getByRole("tab", { name: "Agents" }).click();
    const agents = page.getByRole("list", { name: "Agents" });
    await expect(agents.getByText("builder")).toBeVisible();
    await expect(
      agents.getByText(LIBRARY_LABEL, { exact: true }).first(),
    ).toBeVisible();

    await page.getByRole("tab", { name: "Flow" }).click();
    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByLabel("Task").fill(FLOW_TASK);
    await page.getByRole("button", { name: "Run flow" }).click();
    await expect(page.locator(".flow-run-outcome")).toHaveText(
      "Flow finished.",
      { timeout: STEP_TIMEOUT_MS },
    );
  } finally {
    await cleanup.run();
  }
});
