import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const REGION_NAMES = ["Konta", "Sesja", "Limity"] as const;
const BACKEND_PID_PATTERN = /^PID \d+$/;
const FOREIGN_DATA_URL = "data:text/html,<h1>foreign</h1>";
const FOREIGN_FILE_URL = pathToFileURL(join(ROOT_DIR, "package.json")).href;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

async function expectRegionsVisible(page: Page): Promise<void> {
  for (const name of REGION_NAMES) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }
}

test("app_starts_with_three_columns_and_backend_survives_reload", async () => {
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
  });
  try {
    const page = await app.firstWindow();
    await expectRegionsVisible(page);

    const backend = page.getByRole("status", { name: "Backend" });
    await expect(backend).toHaveText(BACKEND_PID_PATTERN);
    const pidBeforeReload = await backend.innerText();

    await page.reload();

    await expectRegionsVisible(page);
    await expect(backend).toHaveText(pidBeforeReload);
  } finally {
    await app.close();
  }
});

test("navigation_to_foreign_url_is_blocked", async () => {
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
  });
  try {
    const page = await app.firstWindow();
    const backend = page.getByRole("status", { name: "Backend" });
    await expect(backend).toHaveText(BACKEND_PID_PATTERN);
    const entryUrl = page.url();
    const pidBeforeAttacks = await backend.innerText();

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
    await expect(backend).toHaveText(pidBeforeAttacks);
    expect(page.url()).toBe(entryUrl);
  } finally {
    await app.close();
  }
});
