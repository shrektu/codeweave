import type { Locator } from "@playwright/test";

export async function typeConfigDirectory(
  dialog: Locator,
  configDir: string,
): Promise<void> {
  await dialog.getByRole("button", { name: "Edit path" }).click();
  await dialog.getByLabel("Config directory", { exact: true }).fill(configDir);
  await dialog.getByRole("button", { name: "Use path" }).click();
}
