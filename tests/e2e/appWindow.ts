import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

const APP_STARTUP_TIMEOUT_MS = 30_000;
const BACKEND_READY_TEXT = "Connected";

export async function firstReadyWindow(
  app: ElectronApplication,
): Promise<Page> {
  const page = await app.firstWindow({ timeout: APP_STARTUP_TIMEOUT_MS });
  await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
    BACKEND_READY_TEXT,
    { timeout: APP_STARTUP_TIMEOUT_MS },
  );
  return page;
}
