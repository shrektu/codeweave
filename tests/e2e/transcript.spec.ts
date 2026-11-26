import { join } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";

import { PermissionProfile } from "../../src/domain/types";
import {
  MARKDOWN_REPLY,
  MockScenario,
  startAnthropicMock,
} from "../fakes/anthropicMock";

import { firstReadyWindow } from "./appWindow";
import {
  KEY_A,
  KEY_B,
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  createCleanupStack,
  createRotationWorkspace,
  rotationAgentEnv,
} from "./rotationFixture";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const STEP_TIMEOUT_MS = 120_000;
const OPENED_LINKS_KEY = "codeweaveOpenedLinks";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

async function launchApp(
  userData: string,
  repo: string,
  mockUrl: string,
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [USER_DATA_DIR_ENV]: userData,
      [TEST_AGENT_ENV_VAR]: JSON.stringify(rotationAgentEnv(mockUrl)),
    },
  });
  await app.evaluate(
    ({ dialog, shell }, { folder, key }) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [folder] });
      const opened: string[] = [];
      Object.defineProperty(globalThis, key, { value: opened });
      shell.openExternal = (url) => {
        opened.push(url);
        return Promise.resolve();
      };
    },
    { folder: repo, key: OPENED_LINKS_KEY },
  );
  return app;
}

test("transcript_renders_markdown_and_copies_commands", async () => {
  const cleanup = createCleanupStack();
  try {
    const workspace = await createRotationWorkspace(PermissionProfile.ask);
    cleanup.add(() => workspace.dispose());
    const mock = await startAnthropicMock({
      scenarios: { [KEY_A]: MockScenario.ok, [KEY_B]: MockScenario.ok },
      toolCommand: ROTATION_COMMAND,
      replyText: () => MARKDOWN_REPLY,
    });
    cleanup.add(() => mock.close());
    const app = await launchApp(workspace.userData, workspace.repo, mock.url);
    cleanup.add(() => app.close());
    const page = await firstReadyWindow(app);

    await page.getByRole("button", { name: "Choose folder…" }).click();
    await page.getByPlaceholder("Describe the task").fill(ROTATION_PROMPT);
    await page.getByRole("button", { name: "Send" }).click();

    const message = page.locator(".stream .msg:not(.prompt)");
    await expect(message.locator("table td").first()).toHaveText("a.ts", {
      timeout: STEP_TIMEOUT_MS,
    });
    await expect(message.locator(".hljs-keyword").first()).toHaveText("const");
    await expect(message).toContainText("<b>raw html</b>");
    await expect(message.locator("b")).toHaveCount(0);

    await message.getByRole("button", { name: "Copy command" }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("echo codeweave-copy");

    await message.getByRole("link", { name: "the docs" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          (_electron, key): unknown => Reflect.get(globalThis, key),
          OPENED_LINKS_KEY,
        ),
      )
      .toEqual(["https://example.com/docs"]);
  } finally {
    await cleanup.run();
  }
});
