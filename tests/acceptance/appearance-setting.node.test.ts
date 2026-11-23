import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createSettingsService } from "../../src/backend/settingsService";
import { createJsonStore } from "../../src/backend/storage";
import { makeTempDir } from "../fakes/processHelpers";

const SETTINGS_WITH_UNKNOWN_APPEARANCE =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null,"appearance":"neon"}';

function serviceOn(dir: string): ReturnType<typeof createSettingsService> {
  return createSettingsService({
    store: createJsonStore(dir),
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
    homeDir: tmpdir(),
  });
}

it("appearance_setting_round_trips_and_defaults", async () => {
  const dir = await makeTempDir();
  const service = serviceOn(dir);

  const initial = await service.get();
  const afterSet = await service.set({ appearance: "light" });
  const reread = await serviceOn(dir).get();
  const onDisk = await readFile(join(dir, "settings.json"), "utf8");

  expect(initial.appearance).toBe("system");
  expect(afterSet.appearance).toBe("light");
  expect(reread.appearance).toBe("light");
  expect(onDisk).toContain('"appearance": "light"');
});

it("settings_file_with_unknown_appearance_falls_back_to_system", async () => {
  const dir = await makeTempDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), SETTINGS_WITH_UNKNOWN_APPEARANCE);

  const view = await serviceOn(dir).get();

  expect(view.appearance).toBe("system");
  expect(view.effectLevel).toBe("low");
  expect(view.permissionProfile).toBe("plan");
});
