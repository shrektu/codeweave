import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { MockScenario, startAnthropicMock } from "../fakes/anthropicMock";

import {
  FLOW_FILE,
  FLOW_TASK,
  createFlowWorkspace,
  flowReply,
  isDocsNodePrompt,
  launchFlowApp,
  promptOf,
} from "./flowRunFixture";
import { KEY_A, ROTATION_COMMAND, createCleanupStack } from "./rotationFixture";

const STEP_TIMEOUT_MS = 120_000;
const AGENT_ID = "docs-writer";
const AGENT_ROLE = "Writes the docs";
const AGENT_FILE = join("agents", `${AGENT_ID}.md`);
const MARKER_ONE = "MARKER-ONE";
const MARKER_TWO = "MARKER-TWO";
const INSTRUCTIONS_PREFIX = "Write the docs.";
const DOCS_NODE_ID = "docs";

async function readRepoFile(repo: string, file: string): Promise<string> {
  return readFile(join(repo, file), "utf8");
}

async function createAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("textbox", { name: "Id", exact: true }).fill(AGENT_ID);
  await page.getByRole("textbox", { name: "Role" }).fill(AGENT_ROLE);
  await page.getByRole("combobox", { name: "Provider" }).selectOption("claude");
  await page
    .getByRole("combobox", { name: "Permission profile" })
    .selectOption("accept-edits");
  await page
    .getByRole("textbox", { name: "Instructions" })
    .fill(`${INSTRUCTIONS_PREFIX} ${MARKER_ONE}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

async function addDocsNodeToFlow(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const nodeForm = page.getByRole("form", { name: "Add node" });
  await nodeForm.getByLabel("Node id").fill(DOCS_NODE_ID);
  await nodeForm.getByRole("combobox").first().selectOption(AGENT_ID);
  await nodeForm.getByRole("button", { name: "Add node" }).click();
  const edgeForm = page.getByRole("form", { name: "Add edge" });
  await edgeForm.getByRole("combobox").nth(0).selectOption("review");
  await edgeForm.getByRole("combobox").nth(1).selectOption(DOCS_NODE_ID);
  await edgeForm.getByRole("button", { name: "Add edge" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

test("agent_editor_creates_edits_and_flow_uses_agent", async () => {
  const cleanup = createCleanupStack();
  try {
    const workspace = await createFlowWorkspace();
    cleanup.add(() => workspace.dispose());
    const mock = await startAnthropicMock({
      scenarios: { [KEY_A]: MockScenario.ok },
      toolCommand: ROTATION_COMMAND,
      replyText: flowReply,
    });
    cleanup.add(() => mock.close());
    const page = await launchFlowApp(workspace, mock.url, cleanup);
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );

    await page.getByRole("tab", { name: "Agents" }).click();
    await page.getByRole("button", { name: "Choose folder…" }).click();
    await createAgent(page);
    await expect(
      page.getByRole("list", { name: "Agents" }).getByText(AGENT_ID),
    ).toBeVisible();
    await expect
      .poll(() => readRepoFile(workspace.repo, AGENT_FILE))
      .toContain(MARKER_ONE);
    expect(await readRepoFile(workspace.repo, AGENT_FILE)).toContain(
      `id: ${AGENT_ID}`,
    );

    await page
      .getByRole("textbox", { name: "Instructions" })
      .fill(`${INSTRUCTIONS_PREFIX} ${MARKER_TWO}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => readRepoFile(workspace.repo, AGENT_FILE))
      .toContain(MARKER_TWO);
    expect(await readRepoFile(workspace.repo, AGENT_FILE)).not.toContain(
      MARKER_ONE,
    );

    await addDocsNodeToFlow(page);
    await expect
      .poll(() => readRepoFile(workspace.repo, FLOW_FILE))
      .toContain(`agent: ${AGENT_ID}`);

    await page.getByLabel("Task").fill(FLOW_TASK);
    await page.getByRole("button", { name: "Run flow" }).click();
    await expect(page.locator(".flow-run-outcome")).toHaveText(
      "Flow finished.",
      { timeout: STEP_TIMEOUT_MS },
    );

    const docsPrompts = mock.requests
      .filter((request) => request.isMain)
      .map((request) => promptOf(request.body))
      .filter(isDocsNodePrompt);
    expect(docsPrompts).toHaveLength(1);
    expect(docsPrompts[0]).toContain(MARKER_TWO);
    expect(docsPrompts[0]).not.toContain(MARKER_ONE);
  } finally {
    await cleanup.run();
  }
});
