import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";

import { createCleanupStack } from "./rotationFixture";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const EXECUTABLE_ENV = "CODEWEAVE_E2E_EXECUTABLE";
const USER_DATA_PREFIX = "codeweave-e2e-";
const FOLDER_PREFIX = "codeweave-e2e-terminal-";
const DISABLE_GPU_FLAG = "--disable-gpu";
const GPU_COMPOSITING_ENABLED_PREFIX = "enabled";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];
const IS_WINDOWS = process.platform === "win32";
const OUTPUT_TEXT = "cw-ok";
const OUTPUT_COMMAND = IS_WINDOWS
  ? 'Write-Output ("cw-" + "ok")'
  : "printf 'cw-%s\\n' ok";
const MARKER_FILE = "cw-marker.txt";
const MARKER_COMMAND = IS_WINDOWS
  ? `Set-Content ${MARKER_FILE} ok`
  : `printf ok > ${MARKER_FILE}`;
const TOGGLE_SHORTCUT = "Control+Backquote";
const SCREENSHOT_PATH = "test-results/terminal.png";
const WEBGL_SCREENSHOT_PATH = "test-results/terminal-webgl.png";
const PACKED_WITHOUT_CI =
  process.env[EXECUTABLE_ENV] !== undefined && process.env.CI === undefined;

test.skip(
  PACKED_WITHOUT_CI,
  "A packed app ignores CODEWEAVE_USER_DATA_DIR and would use the real profile outside CI",
);
const STEP_TIMEOUT_MS = 30_000;
const MARKER_POLL_INTERVAL_MS = 1000;
const CURSOR_TEXTAREA = ".xterm-helper-textarea";
const CURSOR_PAST_LINE_START = /^[1-9]/;

interface Workspace {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly folder: string;
}

async function withTerminalApp(
  extraFlags: readonly string[],
  body: (workspace: Workspace) => Promise<void>,
): Promise<void> {
  const cleanup = createCleanupStack();
  try {
    const userDataDir = await mkdtemp(join(tmpdir(), USER_DATA_PREFIX));
    cleanup.add(() => rm(userDataDir, { recursive: true, force: true }));
    const folder = await realpath(await mkdtemp(join(tmpdir(), FOLDER_PREFIX)));
    cleanup.add(() => rm(folder, { recursive: true, force: true }));
    const flags = [...SANDBOX_FLAGS, ...extraFlags];
    const packed = process.env[EXECUTABLE_ENV];
    const env = {
      ...process.env,
      [USER_DATA_DIR_ENV]: userDataDir,
      XDG_CONFIG_HOME: userDataDir,
    };
    const app = await electron.launch(
      packed === undefined
        ? { args: [".", ...flags], cwd: ROOT_DIR, env }
        : { executablePath: packed, args: flags, env },
    );
    cleanup.add(() => app.close());
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [picked] });
    }, folder);
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );
    await body({ app, page, folder });
  } finally {
    await cleanup.run();
  }
}

async function openTerminalInFolder(page: Page): Promise<Locator> {
  const toggle = page.getByRole("button", { name: "Terminal" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  const dock = page.getByRole("region", { name: "Terminal" });
  await dock.getByRole("button", { name: "Open in folder…" }).click();
  const host = dock.locator(".terminal-host");
  await expect(host).toHaveAttribute("data-renderer", /^(webgl|dom)$/, {
    timeout: STEP_TIMEOUT_MS,
  });
  return host;
}

async function typeCommand(host: Locator, command: string): Promise<void> {
  await host.locator(CURSOR_TEXTAREA).focus();
  await host.page().keyboard.type(command);
  await host.page().keyboard.press("Enter");
}

async function waitForPrompt(host: Locator): Promise<void> {
  await expect(host.locator(CURSOR_TEXTAREA)).toHaveCSS(
    "left",
    CURSOR_PAST_LINE_START,
    { timeout: STEP_TIMEOUT_MS },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

test("terminal_dom_renderer_shows_typed_command_output", async () => {
  await withTerminalApp([DISABLE_GPU_FLAG], async ({ page }) => {
    const host = await openTerminalInFolder(page);
    await expect(host).toHaveAttribute("data-renderer", "dom");
    await waitForPrompt(host);

    await typeCommand(host, OUTPUT_COMMAND);

    await expect(host.locator(".xterm-rows")).toContainText(OUTPUT_TEXT, {
      timeout: STEP_TIMEOUT_MS,
    });

    await page.screenshot({ path: SCREENSHOT_PATH });
  });
});

test("terminal_runs_commands_with_default_renderer", async () => {
  await withTerminalApp([], async ({ app, page, folder }) => {
    const host = await openTerminalInFolder(page);
    const accelerated = await app.evaluate(
      ({ app: electronApp }, enabledPrefix) =>
        electronApp
          .getGPUFeatureStatus()
          .gpu_compositing.startsWith(enabledPrefix),
      GPU_COMPOSITING_ENABLED_PREFIX,
    );
    await expect(host).toHaveAttribute(
      "data-renderer",
      accelerated ? "webgl" : "dom",
    );

    await waitForPrompt(host);
    await typeCommand(host, MARKER_COMMAND);

    await expect
      .poll(() => exists(join(folder, MARKER_FILE)), {
        intervals: [MARKER_POLL_INTERVAL_MS],
        timeout: STEP_TIMEOUT_MS,
      })
      .toBe(true);

    await page.screenshot({ path: WEBGL_SCREENSHOT_PATH });
  });
});

test("terminal_replays_output_after_hiding_the_dock", async () => {
  await withTerminalApp([DISABLE_GPU_FLAG], async ({ page }) => {
    const host = await openTerminalInFolder(page);
    await waitForPrompt(host);
    await typeCommand(host, OUTPUT_COMMAND);
    await expect(host.locator(".xterm-rows")).toContainText(OUTPUT_TEXT, {
      timeout: STEP_TIMEOUT_MS,
    });

    await page.keyboard.press(TOGGLE_SHORTCUT);
    await expect(page.getByRole("region", { name: "Terminal" })).toBeHidden();
    await page.keyboard.press(TOGGLE_SHORTCUT);

    const reopened = page
      .getByRole("region", { name: "Terminal" })
      .locator(".terminal-host");
    await expect(reopened.locator(".xterm-rows")).toContainText(OUTPUT_TEXT, {
      timeout: STEP_TIMEOUT_MS,
    });
  });
});
