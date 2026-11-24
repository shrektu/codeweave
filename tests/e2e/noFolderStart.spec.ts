import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createJsonStore } from "../../src/backend/storage";
import { PermissionProfile } from "../../src/domain/types";
import {
  MockScenario,
  startAnthropicMock,
  type MessagesBody,
} from "../fakes/anthropicMock";
import { TurnKind, type MockTurn } from "../fakes/mockTurn";

import { ROOT_DIR } from "./flowRunFixture";
import { anthropicTranscript } from "./orchestratorScript";
import {
  KEY_A,
  ROTATION_COMMAND,
  WORKSPACE_PREFIX,
  account,
  createCleanupStack,
  createConfigDir,
  createRepo,
  rotationAgentEnv,
  rotationSettings,
} from "./rotationFixture";

const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const STEP_TIMEOUT_MS = 120_000;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];
const NOTES_FILE = "notes.txt";
const NOTES_BEFORE = "before\n";
const NOTES_AFTER = "after\n";
const BASH_TOOL_NAME = "Bash";
const TASK = "Update the notes in the repo";
const DONE_REPLY = "Updated the notes.";
const IDLE_PATTERN = /Idle on A/;

function editNotesTurn(body: MessagesBody): MockTurn {
  return anthropicTranscript(body).calls.length === 0
    ? {
        kind: TurnKind.tool,
        name: BASH_TOOL_NAME,
        input: {
          command: `printf 'after\\n' > repo/${NOTES_FILE}`,
          description: "update notes",
        },
      }
    : { kind: TurnKind.text, text: DONE_REPLY };
}

test("no_folder_start_runs_in_the_default_workspace_without_permission_cards", async () => {
  const cleanup = createCleanupStack();
  try {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX)),
    );
    cleanup.add(() => rm(root, { recursive: true, force: true }));
    const userData = join(root, "user-data");
    const workspace = join(root, "workspace");
    const repo = join(workspace, "repo");
    await createRepo(repo);
    await writeFile(join(repo, NOTES_FILE), NOTES_BEFORE);
    const configDir = join(root, "config-a");
    await createConfigDir(configDir, KEY_A);
    const store = createJsonStore(userData);
    await store.writeAccounts([account("acc-a", "A", configDir, 0)]);
    await store.writeSettings({
      ...rotationSettings(PermissionProfile.unattended),
      defaultWorkspace: workspace,
    });
    const mock = await startAnthropicMock({
      scenarios: { [KEY_A]: MockScenario.ok },
      toolCommand: ROTATION_COMMAND,
      respond: editNotesTurn,
    });
    cleanup.add(() => mock.close());
    const app = await electron.launch({
      args: [".", ...SANDBOX_FLAGS],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        [USER_DATA_DIR_ENV]: userData,
        [TEST_AGENT_ENV_VAR]: JSON.stringify(rotationAgentEnv(mock.url)),
      },
    });
    cleanup.add(() => app.close());
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );

    await page.getByRole("textbox", { name: "Task" }).fill(TASK);
    await page.getByRole("button", { name: "Start", exact: true }).click();

    await expect(page.locator(".session-head .phase")).toContainText(
      IDLE_PATTERN,
      { timeout: STEP_TIMEOUT_MS },
    );
    await expect(page.getByText(DONE_REPLY)).toBeVisible();
    expect(await readFile(join(repo, NOTES_FILE), "utf8")).toBe(NOTES_AFTER);
    await expect(page.locator(".card.ask")).toHaveCount(0);
  } finally {
    await cleanup.run();
  }
});
