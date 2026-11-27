import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createSettingsService } from "../../src/backend/settingsService";
import { createJsonStore } from "../../src/backend/storage";
import { makeTempDir } from "../fakes/processHelpers";

const SETTINGS_WITHOUT_NOTIFICATIONS =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null}';

async function seededDir(content: string): Promise<string> {
  const dir = await makeTempDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), content);
  return dir;
}

function serviceOver(dir: string): ReturnType<typeof createSettingsService> {
  return createSettingsService({
    store: createJsonStore(dir),
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
    homeDir: tmpdir(),
  });
}

it("notifications_setting_defaults_on_and_persists", async () => {
  const dir = await seededDir(SETTINGS_WITHOUT_NOTIFICATIONS);

  const initial = await serviceOver(dir).get();
  const afterSet = await serviceOver(dir).set({ notifications: false });
  const reloaded = await serviceOver(dir).get();
  const stored = await createJsonStore(dir).readSettings();

  expect(initial.notifications).toBe(true);
  expect(afterSet.notifications).toBe(false);
  expect(reloaded.notifications).toBe(false);
  expect(stored.notifications).toBe(false);
});

it("stored_settings_without_notifications_load_as_on", async () => {
  const dir = await seededDir(SETTINGS_WITHOUT_NOTIFICATIONS);

  const stored = await createJsonStore(dir).readSettings();
  const view = await serviceOver(dir).get();

  expect(stored.notifications).toBe(true);
  expect(view.notifications).toBe(true);
});

it("settings_set_without_notifications_keeps_them", async () => {
  const dir = await seededDir(SETTINGS_WITHOUT_NOTIFICATIONS);
  await serviceOver(dir).set({ notifications: false });

  const view = await serviceOver(dir).set({ effectLevel: "full" });

  expect(view.notifications).toBe(false);
});
