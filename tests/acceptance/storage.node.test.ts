import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createSettingsService } from "../../src/backend/settingsService";
import {
  createJsonStore,
  StorageCorruptError,
} from "../../src/backend/storage";
import { makeTempDir } from "../fakes/processHelpers";

const CORRUPT_BYTES = '{"version":1,"accounts":[{"id":';
const V1_SETTINGS_WITHOUT_CODEX =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":"/usr/bin/claude"}';

it("settings_without_codex_executable_loads", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "settings.json");
  await writeFile(file, V1_SETTINGS_WITHOUT_CODEX);
  const store = createJsonStore(dir);

  const settings = await store.readSettings();
  expect(settings.codexExecutable).toBeNull();
  expect(settings.claudeExecutable).toBe("/usr/bin/claude");

  const service = createSettingsService({
    store,
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  });
  const view = await service.set({ codexExecutable: "/opt/codex" });

  expect(view.codexExecutable).toBe("/opt/codex");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    version: 1,
    permissionProfile: "plan",
    effectLevel: "low",
    claudeExecutable: "/usr/bin/claude",
    codexExecutable: "/opt/codex",
    agyExecutable: null,
    opencodeExecutable: null,
    terminalShell: null,
    updateCheck: true,
    updateChannel: "stable",
    defaultTaskClass: "standard",
  });
});

it("settings_without_agy_executable_loads", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "settings.json");
  await writeFile(
    file,
    '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null,"codexExecutable":"/usr/bin/codex","opencodeExecutable":null}',
  );
  const store = createJsonStore(dir);

  const settings = await store.readSettings();
  const service = createSettingsService({
    store,
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  });
  const view = await service.set({ agyExecutable: "/opt/agy" });

  expect(settings.agyExecutable).toBeNull();
  expect(view.agyExecutable).toBe("/opt/agy");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    codexExecutable: "/usr/bin/codex",
    agyExecutable: "/opt/agy",
  });
});

it("settings_without_terminal_shell_still_load", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "settings.json");
  await writeFile(
    file,
    '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null,"codexExecutable":null,"agyExecutable":null,"opencodeExecutable":null}',
  );
  const store = createJsonStore(dir);

  const settings = await store.readSettings();
  const service = createSettingsService({
    store,
    broadcast: () => undefined,
    postUpdaterConfig: () => undefined,
  });
  const view = await service.set({ terminalShell: "/bin/zsh" });

  expect(settings.terminalShell).toBeNull();
  expect(view.terminalShell).toBe("/bin/zsh");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    permissionProfile: "plan",
    terminalShell: "/bin/zsh",
  });
});

it("settings_without_opencode_executable_loads", async () => {
  const dir = await makeTempDir();
  await writeFile(
    join(dir, "settings.json"),
    '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":null,"codexExecutable":"/usr/bin/codex"}',
  );

  const settings = await createJsonStore(dir).readSettings();

  expect(settings.opencodeExecutable).toBeNull();
  expect(settings.codexExecutable).toBe("/usr/bin/codex");
});

it("storage_refuses_to_overwrite_corrupt_file", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "settings.json");
  await writeFile(file, CORRUPT_BYTES);
  const store = createJsonStore(dir);

  await expect(
    store.writeSettings({
      version: 1,
      permissionProfile: "plan",
      effectLevel: "auto",
      claudeExecutable: null,
      codexExecutable: null,
      agyExecutable: null,
      opencodeExecutable: null,
      terminalShell: null,
      updateCheck: true,
      updateChannel: "stable",
      defaultTaskClass: "standard",
    }),
  ).rejects.toBeInstanceOf(StorageCorruptError);

  expect(await readFile(file, "utf8")).toBe(CORRUPT_BYTES);
});

it("storage_rejects_corrupt_accounts_file_without_overwrite", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "accounts.json");
  await writeFile(file, CORRUPT_BYTES);
  const store = createJsonStore(dir);

  await expect(store.readAccounts()).rejects.toBeInstanceOf(
    StorageCorruptError,
  );

  expect(await readFile(file, "utf8")).toBe(CORRUPT_BYTES);
});
