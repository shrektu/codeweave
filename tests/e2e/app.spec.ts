import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

import { firstReadyWindow } from "./appWindow";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const REGION_NAMES = ["Accounts", "Session", "Limits", "Switch log"] as const;
const BACKEND_READY_TEXT = "Connected";
const BACKEND_PID_PATTERN = /^\d+$/;
const PID_ATTRIBUTE = "data-pid";
const FOREIGN_DATA_URL = "data:text/html,<h1>foreign</h1>";
const FOREIGN_FILE_URL = pathToFileURL(join(ROOT_DIR, "package.json")).href;
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const USER_DATA_PREFIX = "codeweave-e2e-";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

async function expectRegionsVisible(page: Page): Promise<void> {
  for (const name of REGION_NAMES) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }
}

async function withApp(
  body: (app: ElectronApplication) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), USER_DATA_PREFIX));
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: { ...process.env, [USER_DATA_DIR_ENV]: userDataDir },
  });
  try {
    await body(app);
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

test("app_starts_with_three_columns_and_backend_survives_reload", async () => {
  await withApp(async (app) => {
    const page = await firstReadyWindow(app);
    await expectRegionsVisible(page);

    const backend = page.getByRole("status", { name: "Backend" });
    await expect(backend).toHaveText(BACKEND_READY_TEXT);
    await expect(backend).toHaveAttribute(PID_ATTRIBUTE, BACKEND_PID_PATTERN);
    const pidBeforeReload = await backend.getAttribute(PID_ATTRIBUTE);

    await page.reload();

    await expectRegionsVisible(page);
    await expect(backend).toHaveText(BACKEND_READY_TEXT);
    await expect(backend).toHaveAttribute(PID_ATTRIBUTE, pidBeforeReload ?? "");
  });
});

test("settings_dialog_opens_and_closes", async () => {
  await withApp(async (app) => {
    const page = await firstReadyWindow(app);

    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("radio", { name: "Unattended" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close" }).click();

    await expect(dialog).toHaveCount(0);
  });
});

test("app_switches_light_and_dark_appearance", async () => {
  await withApp(async (app) => {
    const page = await firstReadyWindow(app);
    const html = page.locator("html");
    const labelColor = (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.body).color);
    const nativeDark = (): Promise<boolean> =>
      app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);

    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect.poll(nativeDark).toBe(true);
    const darkLabel = await labelColor();

    await dialog.getByRole("radio", { name: "Light" }).click();

    await expect(html).toHaveAttribute("data-theme", "light");
    await expect.poll(nativeDark).toBe(false);
    expect(await labelColor()).not.toBe(darkLabel);

    await dialog.getByRole("radio", { name: "Dark" }).click();

    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect.poll(nativeDark).toBe(true);
    expect(await labelColor()).toBe(darkLabel);
  });
});

test("dialog_escape_closes_and_traps_focus", async () => {
  await withApp(async (app) => {
    const page = await firstReadyWindow(app);
    const background = page.getByRole("button", { name: "Manage accounts" });
    const box = await background.boundingBox();
    expect(box).not.toBeNull();

    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);

    await page.mouse.click(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await expect(page.getByRole("dialog", { name: "Accounts" })).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(dialog).toHaveCount(0);
  });
});

test("navigation_to_foreign_url_is_blocked", async () => {
  await withApp(async (app) => {
    const page = await firstReadyWindow(app);
    const backend = page.getByRole("status", { name: "Backend" });
    const entryUrl = page.url();
    const pidBeforeAttacks = await backend.getAttribute(PID_ATTRIBUTE);

    await page.evaluate((href) => {
      window.location.href = href;
    }, FOREIGN_DATA_URL);
    const attemptedUrl = await app.evaluate(
      ({ BrowserWindow }, href) =>
        new Promise<string>((resolve) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          contents?.once("will-navigate", (_event, url) => {
            resolve(url);
          });
          void contents?.executeJavaScript(
            `window.location.href = ${JSON.stringify(href)}`,
          );
        }),
      FOREIGN_FILE_URL,
    );
    const openedWindow = await page.evaluate(
      () => window.open("https://example.com/") !== null,
    );

    expect(attemptedUrl).toBe(FOREIGN_FILE_URL);
    expect(openedWindow).toBe(false);
    expect(app.windows()).toHaveLength(1);
    await page.reload();
    await expectRegionsVisible(page);
    await expect(backend).toHaveAttribute(
      PID_ATTRIBUTE,
      pidBeforeAttacks ?? "",
    );
    expect(page.url()).toBe(entryUrl);
  });
});
