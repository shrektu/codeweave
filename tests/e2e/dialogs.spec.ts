import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const USER_DATA_PREFIX = "codeweave-e2e-";
const ACCOUNTS_FILE = "accounts.json";
const ACCOUNT_COUNT = 40;
const VIEWPORT_HEIGHT = 800;
const BACKEND_READY_TEXT = "Connected";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];

interface FakeAccount {
  id: string;
  provider: string;
  label: string;
  configDir: string;
  order: number;
}

function fakeAccounts(baseDir: string): FakeAccount[] {
  return Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
    id: `fake-${String(index)}`,
    provider: "claude",
    label: `Fake account ${String(index)}`,
    configDir: join(baseDir, `account-${String(index)}`),
    order: index,
  }));
}

test("dialog_lists_do_not_shrink_in_dialog_body_e2e", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), USER_DATA_PREFIX));
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, ACCOUNTS_FILE),
    JSON.stringify({ version: 1, accounts: fakeAccounts(userDataDir) }),
  );
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: { ...process.env, [USER_DATA_DIR_ENV]: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: VIEWPORT_HEIGHT });
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      BACKEND_READY_TEXT,
    );

    await page.getByRole("button", { name: "Manage accounts" }).click();
    const dialog = page.getByRole("dialog", { name: "Accounts" });
    await expect(dialog).toBeVisible();
    const body = dialog.locator(".dialog-body");
    const lastRow = dialog
      .locator(".account-row")
      .filter({ hasText: `Fake account ${String(ACCOUNT_COUNT - 1)}` });
    await expect(lastRow).toHaveCount(1);

    const metrics = await body.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport();
    const rowBox = await lastRow.boundingBox();
    const bodyBox = await body.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(
      (bodyBox?.y ?? 0) + (bodyBox?.height ?? 0) + 1,
    );
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
