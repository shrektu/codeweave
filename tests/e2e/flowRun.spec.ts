import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  MockScenario,
  startAnthropicMock,
  type MockRequestRecord,
} from "../fakes/anthropicMock";

import {
  FLOW_TASK,
  ROOT_DIR,
  createFlowWorkspace,
  createGate,
  flowReply,
  hasBuildHandoff,
  isBuildNodePrompt,
  isReviewNodePrompt,
  isReviewPrompt,
  launchFlowApp,
  promptOf,
} from "./flowRunFixture";
import { KEY_A, ROTATION_COMMAND, createCleanupStack } from "./rotationFixture";

const SCREENSHOT_PATH = join(ROOT_DIR, "docs", "screenshots", "flow-run.png");
const STEP_TIMEOUT_MS = 120_000;
const GRAPH_SETTLE_MS = 1000;

function flowNode(page: Page, id: string): Locator {
  return page
    .locator(".flow-node")
    .filter({ has: page.locator(".flow-node-id", { hasText: id }) });
}

function expectNodePrompts(requests: readonly MockRequestRecord[]): void {
  const prompts = requests
    .filter((request) => request.isMain)
    .map((request) => promptOf(request.body));
  expect(prompts).toHaveLength(2);
  const [buildPrompt = "", reviewPrompt = ""] = prompts;
  expect(isBuildNodePrompt(buildPrompt)).toBe(true);
  expect(buildPrompt).toContain(FLOW_TASK);
  expect(hasBuildHandoff(buildPrompt)).toBe(false);
  expect(isReviewNodePrompt(reviewPrompt)).toBe(true);
  expect(hasBuildHandoff(reviewPrompt)).toBe(true);
}

test("flow_run_shows_live_states_hands_off_and_finishes_on_approval", async () => {
  const cleanup = createCleanupStack();
  try {
    const workspace = await createFlowWorkspace();
    cleanup.add(() => workspace.dispose());
    const reviewerGate = createGate();
    cleanup.add(() => {
      reviewerGate.open();
      return Promise.resolve();
    });
    const mock = await startAnthropicMock({
      scenarios: { [KEY_A]: MockScenario.ok },
      toolCommand: ROTATION_COMMAND,
      replyText: flowReply,
      onMainRequest: async (_key, body) => {
        if (isReviewPrompt(body)) {
          await reviewerGate.opened;
        }
      },
    });
    cleanup.add(() => mock.close());
    const page = await launchFlowApp(workspace, mock.url, cleanup);
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );

    await page.getByRole("tab", { name: "Flow" }).click();
    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByLabel("Task").fill(FLOW_TASK);
    await page.getByRole("button", { name: "Run flow" }).click();

    await expect(flowNode(page, "build")).toContainText("Done", {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(flowNode(page, "review")).toContainText("Working", {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(page.locator(".flow-run-head")).toContainText("Running");
    await page.waitForTimeout(GRAPH_SETTLE_MS);
    await page.screenshot({ path: SCREENSHOT_PATH });

    reviewerGate.open();
    await expect(page.locator(".flow-run-outcome")).toHaveText(
      "Flow finished.",
      { timeout: STEP_TIMEOUT_MS },
    );
    await expect(flowNode(page, "review")).toContainText("Done");
    const summaries = page.locator(".flow-run-results summary");
    await expect(summaries).toHaveText([
      "build · visits 1",
      "review · visits 1",
    ]);

    expectNodePrompts(mock.requests);
  } finally {
    await cleanup.run();
  }
});
