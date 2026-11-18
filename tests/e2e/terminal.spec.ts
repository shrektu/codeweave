import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { createCleanupStack } from "./rotationFixture";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const EXECUTABLE_ENV = "CODEWEAVE_E2E_EXECUTABLE";
const USER_DATA_PREFIX = "codeweave-e2e-";
const FOLDER_PREFIX = "codeweave-e2e-terminal-";
const DISABLE_GPU_FLAG = "--disable-gpu";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];
const IS_WINDOWS = process.platform === "win32";
const OUTPUT_TEXT = "cw-ok";
const OUTPUT_COMMAND = IS_WINDOWS
  ? 'Write-Output ("cw-" + "ok")'
  : "printf 'cw-%s\\n' ok";
const RUN_MARKER_ENV = "CODEWEAVE_RUN_ID";
const PRINT_MARKER_COMMAND = IS_WINDOWS
  ? `$env:${RUN_MARKER_ENV}`
  : `echo $${RUN_MARKER_ENV}`;
const RUN_MARKER_PATTERN = /[0-9a-f]{32}:[A-Za-z0-9_-]+/;
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

interface Workspace {
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
    await body({ page, folder });
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
  await host.locator(".xterm-helper-textarea").focus();
  await host.page().keyboard.type(command);
  await host.page().keyboard.press("Enter");
}

async function waitForPrompt(host: Locator): Promise<void> {
  await expect
    .poll(async () => (await host.locator(".xterm-rows").innerText()).trim(), {
      timeout: STEP_TIMEOUT_MS,
    })
    .not.toBe("");
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

test("terminal_shell_carries_the_run_marker_on_windows_and_mac", async () => {
  test.skip(
    process.platform === "linux",
    "The systemd scope container sets no run marker",
  );
  await withTerminalApp([DISABLE_GPU_FLAG], async ({ page }) => {
    const host = await openTerminalInFolder(page);
    await waitForPrompt(host);

    await typeCommand(host, PRINT_MARKER_COMMAND);

    await expect(host.locator(".xterm-rows")).toContainText(
      RUN_MARKER_PATTERN,
      { timeout: STEP_TIMEOUT_MS },
    );
  });
});

test("terminal_runs_commands_with_default_renderer", async () => {
  await withTerminalApp([], async ({ page, folder }) => {
    const host = await openTerminalInFolder(page);
    const gpuAccelerated = await page.evaluate(
      () => window.codeweave.gpuAccelerated,
    );
    await expect(host).toHaveAttribute(
      "data-renderer",
      gpuAccelerated ? "webgl" : "dom",
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
