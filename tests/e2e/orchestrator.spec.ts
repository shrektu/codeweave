import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  MCP_TOOL_NAME_PREFIX,
  MCP_TOOL_NAME_SEPARATOR,
} from "../../src/backend/constants";
import {
  FlowToolName,
  FLOW_TOOL_NAMES,
} from "../../src/backend/flowTools/tools";
import { FLOW_TOOL_SERVER_NAME } from "../../src/domain/constants";
import {
  MockScenario,
  startAnthropicMock,
  userTexts,
  type AnthropicMock,
  type MessagesBody,
  type MockRequestRecord,
} from "../fakes/anthropicMock";
import { TurnKind, type MockTurn } from "../fakes/mockTurn";

import {
  BUILD_REPLY,
  FLOW_TASK,
  ROOT_DIR,
  bundledClaudeExecutable,
  createFlowWorkspace,
  createGate,
  isBuildNodePrompt,
  isReviewPrompt,
  launchFlowApp,
  promptOf,
  type FlowWorkspace,
  type Gate,
} from "./flowRunFixture";
import {
  DECISION_MARKER,
  DECISION_NOTE,
  FINAL_ANSWER,
  GREETING_CONTENT,
  GREETING_FILE,
  LastKind,
  WAITING_REPLY,
  anthropicTranscript,
  isOrchestratorRequest,
  nextOrchestratorStep,
  toolIs,
} from "./orchestratorScript";
import {
  KEY_A,
  ROTATION_COMMAND,
  createCleanupStack,
  type CleanupStack,
} from "./rotationFixture";

const SCREENSHOT_PATH = join(
  ROOT_DIR,
  "docs",
  "screenshots",
  "orchestrator.png",
);
const STEP_TIMEOUT_MS = 120_000;
const GRAPH_SETTLE_MS = 1000;
const ORCHESTRATOR_INTRO = "You are the Codeweave orchestrator.";
const REVIEW_REPLY_WITHOUT_VERDICT = "Looks correct.";
const WRITE_TOOL_NAME = "Write";
const FLOW_TOOL_PREFIX = `${MCP_TOOL_NAME_PREFIX}${FLOW_TOOL_SERVER_NAME}${MCP_TOOL_NAME_SEPARATOR}`;
const BEARER_MARKER = "Bearer";
const MIN_NODE_REQUESTS = 3;
const SUGGESTION_MARKER = "[SUGGESTION MODE";
const PROMPT_MISSING_MESSAGE =
  "The prompt field did not appear after choosing the folder. The page shows:\n";

function flowNode(page: Page, id: string): Locator {
  return page
    .locator(".flow-node")
    .filter({ has: page.locator(".flow-node-id", { hasText: id }) });
}

function toolNamesOf(body: MessagesBody): string[] {
  return (body.tools ?? []).map((tool) => tool.name);
}

function writeGreetingTurn(repo: string): MockTurn {
  return {
    kind: TurnKind.tool,
    name: WRITE_TOOL_NAME,
    input: {
      file_path: join(repo, GREETING_FILE),
      content: GREETING_CONTENT,
    },
  };
}

function nodeTurn(body: MessagesBody, repo: string): MockTurn | undefined {
  if (isBuildNodePrompt(promptOf(body))) {
    return anthropicTranscript(body).calls.length === 0
      ? writeGreetingTurn(repo)
      : { kind: TurnKind.text, text: BUILD_REPLY };
  }
  return isReviewPrompt(body)
    ? { kind: TurnKind.text, text: REVIEW_REPLY_WITHOUT_VERDICT }
    : undefined;
}

function isSuggestionRequest(body: MessagesBody): boolean {
  const { last } = anthropicTranscript(body);
  return (
    last.kind === LastKind.userText && last.text.includes(SUGGESTION_MARKER)
  );
}

function orchestratorRequests(
  requests: readonly MockRequestRecord[],
): MockRequestRecord[] {
  return requests.filter(
    (request) =>
      isOrchestratorRequest(toolNamesOf(request.body)) &&
      !isSuggestionRequest(request.body),
  );
}

function nodeRequests(
  requests: readonly MockRequestRecord[],
): MockRequestRecord[] {
  return requests.filter(
    (request) =>
      request.isMain && !isOrchestratorRequest(toolNamesOf(request.body)),
  );
}

function expectFlowDiffReachedModel(
  requests: readonly MockRequestRecord[],
): void {
  const results = orchestratorRequests(requests).flatMap((request) =>
    anthropicTranscript(request.body)
      .calls.filter((call) => toolIs(call.tool, FlowToolName.flowDiff))
      .map((call) => call.result),
  );
  expect(results.some((result) => result.includes(GREETING_FILE))).toBe(true);
}

function expectOrchestratorOffered(
  requests: readonly MockRequestRecord[],
): void {
  const offered = FLOW_TOOL_NAMES.map((name) => `${FLOW_TOOL_PREFIX}${name}`);
  const orchestrator = orchestratorRequests(requests);
  expect(orchestrator.length).toBeGreaterThan(0);
  for (const request of orchestrator) {
    expect(toolNamesOf(request.body)).toEqual(expect.arrayContaining(offered));
  }
  const [first] = orchestrator;
  const intro = userTexts(first?.body ?? { messages: [] }).join("\n");
  expect(intro).toContain(ORCHESTRATOR_INTRO);
  expect(intro).toContain(FLOW_TASK);
}

function expectDecisionWakeUpAfterSettledTurn(
  requests: readonly MockRequestRecord[],
): void {
  const lasts = orchestratorRequests(requests).map(
    (request) => anthropicTranscript(request.body).last,
  );
  const waiting = lasts.findIndex(
    (last) =>
      last.kind === LastKind.toolResult &&
      toolIs(last.tool, FlowToolName.startFlow),
  );
  const wakeUps = lasts.flatMap((last, index) =>
    last.kind === LastKind.userText && last.text.includes(DECISION_MARKER)
      ? [index]
      : [],
  );
  expect(waiting).toBeGreaterThanOrEqual(0);
  expect(wakeUps, "decision wake-up after settled turn").toEqual([waiting + 1]);
}

function expectModelRequests(mock: AnthropicMock): void {
  expectFlowDiffReachedModel(mock.requests);
  expectOrchestratorOffered(mock.requests);
  const nodes = nodeRequests(mock.requests);
  expect(
    nodes.length,
    "node sessions get no flow tools",
  ).toBeGreaterThanOrEqual(MIN_NODE_REQUESTS);
  for (const request of nodes) {
    expect(
      toolNamesOf(request.body).filter((name) =>
        name.startsWith(FLOW_TOOL_PREFIX),
      ),
      "node sessions get no flow tools",
    ).toEqual([]);
  }
  for (const request of mock.requests) {
    expect(
      JSON.stringify(request.body),
      "no bearer token in model requests",
    ).not.toContain(BEARER_MARKER);
  }
  expectDecisionWakeUpAfterSettledTurn(mock.requests);
}

async function startMock(
  workspace: FlowWorkspace,
  reviewerGate: Gate,
): Promise<AnthropicMock> {
  return startAnthropicMock({
    scenarios: { [KEY_A]: MockScenario.ok },
    toolCommand: ROTATION_COMMAND,
    respond: (body) => {
      if (isSuggestionRequest(body)) {
        return undefined;
      }
      const transcript = anthropicTranscript(body);
      return isOrchestratorRequest(transcript.toolNames)
        ? nextOrchestratorStep(transcript)
        : nodeTurn(body, workspace.repo);
    },
    onMainRequest: async (_key, body) => {
      if (isReviewPrompt(body)) {
        await reviewerGate.opened;
      }
    },
  });
}

async function fillPrompt(page: Page): Promise<void> {
  try {
    await page.getByPlaceholder("Describe the task").fill(FLOW_TASK);
  } catch (error) {
    const shown = await page.locator("body").innerText();
    throw new Error(`${PROMPT_MISSING_MESSAGE}${shown}`, { cause: error });
  }
}

async function startSession(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: "Orchestrate" }).check();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await fillPrompt(page);
  await page.getByRole("button", { name: "Send" }).click();
}

async function inspectNodeSession(
  page: Page,
  timeline: Locator,
): Promise<void> {
  const session = page.getByRole("region", { name: "Session" });
  await expect(session.getByText(WAITING_REPLY)).toBeVisible({
    timeout: STEP_TIMEOUT_MS,
  });
  await timeline.getByRole("button", { name: "Show graph" }).click();
  await expect(flowNode(page, "review")).toContainText("Working", {
    timeout: STEP_TIMEOUT_MS,
  });
  await flowNode(page, "review").click();
  await expect(
    page.getByText("Node session of Build and review"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to orchestrator" }).click();
  await expect(session.getByText(WAITING_REPLY)).toBeVisible();
}

async function expectTimelineFinished(
  page: Page,
  timeline: Locator,
): Promise<void> {
  for (const text of [
    "Build and review",
    "Done",
    "Flow finished.",
    "Approve at review",
    DECISION_NOTE,
  ]) {
    await expect(timeline).toContainText(text);
  }
  await page.waitForTimeout(GRAPH_SETTLE_MS);
  await page.screenshot({ path: SCREENSHOT_PATH });
}

async function runLoop(
  workspace: FlowWorkspace,
  cleanup: CleanupStack,
): Promise<AnthropicMock> {
  const reviewerGate = createGate();
  cleanup.add(() => {
    reviewerGate.open();
    return Promise.resolve();
  });
  const mock = await startMock(workspace, reviewerGate);
  cleanup.add(() => mock.close());
  const page = await launchFlowApp(workspace, mock.url, cleanup);
  await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
    "Connected",
  );
  await startSession(page);
  const timeline = page.getByRole("region", { name: "Orchestrator timeline" });
  await inspectNodeSession(page, timeline);
  reviewerGate.open();
  await expect(
    page.getByRole("region", { name: "Session" }).getByText(FINAL_ANSWER),
  ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
  await expectTimelineFinished(page, timeline);
  return mock;
}

test("orchestrator_completes_the_flow_loop_through_the_ui", async () => {
  const cleanup = createCleanupStack();
  try {
    const workspace = await createFlowWorkspace({
      claudeExecutable: bundledClaudeExecutable(),
    });
    cleanup.add(() => workspace.dispose());

    const mock = await runLoop(workspace, cleanup);

    expect(await readFile(join(workspace.repo, GREETING_FILE), "utf8")).toBe(
      GREETING_CONTENT,
    );
    expectModelRequests(mock);
  } finally {
    await cleanup.run();
  }
});
