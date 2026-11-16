import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createSettingsService } from "../../src/backend/settingsService";
import { createJsonStore } from "../../src/backend/storage";
import { createBackendRig } from "../fakes/backendRig";
import { makeTempDir } from "../fakes/processHelpers";

const SETTINGS_WITHOUT_UPDATE_FIELDS =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null}';
const SETTINGS_WITH_CHECK_OFF_ON_BETA =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null,"updateCheck":false,"updateChannel":"beta"}';

interface PostedConfig {
  readonly type: string;
  readonly enabled: boolean;
  readonly channel: string;
}

async function seededDir(content: string): Promise<string> {
  const dir = await makeTempDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), content);
  return dir;
}

it("settings_without_update_fields_load_with_defaults", async () => {
  const dir = await seededDir(SETTINGS_WITHOUT_UPDATE_FIELDS);
  const store = createJsonStore(dir);

  const settings = await store.readSettings();
  const view = await createSettingsService({
    store,
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  }).get();

  expect(settings.updateCheck).toBe(true);
  expect(settings.updateChannel).toBe("stable");
  expect(view.updateCheck).toBe(true);
  expect(view.updateChannel).toBe("stable");
});

it("settings_round_trip_update_fields", async () => {
  const dir = await seededDir(SETTINGS_WITHOUT_UPDATE_FIELDS);
  const service = createSettingsService({
    store: createJsonStore(dir),
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  });

  const afterSet = await service.set({
    updateCheck: false,
    updateChannel: "beta",
  });
  const reloaded = await createSettingsService({
    store: createJsonStore(dir),
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  }).get();

  expect(afterSet.updateCheck).toBe(false);
  expect(afterSet.updateChannel).toBe("beta");
  expect(reloaded.updateCheck).toBe(false);
  expect(reloaded.updateChannel).toBe("beta");
});

it("explicit_false_survives_reload", async () => {
  const dir = await seededDir(SETTINGS_WITH_CHECK_OFF_ON_BETA);

  const settings = await createJsonStore(dir).readSettings();

  expect(settings.updateCheck).toBe(false);
  expect(settings.updateChannel).toBe("beta");
});

it("settings_set_without_update_fields_keeps_them", async () => {
  const dir = await seededDir(SETTINGS_WITH_CHECK_OFF_ON_BETA);
  const service = createSettingsService({
    store: createJsonStore(dir),
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  });

  const view = await service.set({ effectLevel: "full" });

  expect(view.updateCheck).toBe(false);
  expect(view.updateChannel).toBe("beta");
});

it("backend_posts_updater_config_at_startup", async () => {
  const posted: PostedConfig[] = [];
  const userData = await seededDir(SETTINGS_WITH_CHECK_OFF_ON_BETA);

  await createBackendRig({
    userData,
    postUpdaterConfig: (message) => {
      posted.push(message);
    },
  });

  expect(posted).toEqual([
    { type: "updater/config", enabled: false, channel: "beta" },
  ]);
});

it("backend_posts_updater_config_after_settings_change", async () => {
  const posted: PostedConfig[] = [];
  const rig = await createBackendRig({
    postUpdaterConfig: (message) => {
      posted.push(message);
    },
  });

  await rig.call("settings/set", { updateChannel: "beta" });

  expect(posted).toEqual([
    { type: "updater/config", enabled: true, channel: "stable" },
    { type: "updater/config", enabled: true, channel: "beta" },
  ]);
});
