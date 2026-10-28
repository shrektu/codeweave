import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";
import {
  PermissionProfile,
  ProviderId,
  SwitchReason,
  type Account,
} from "../domain/types";

import { createJsonStore, StorageCorruptError } from "./storage";

const account: Account = {
  id: "acc-1",
  provider: ProviderId.claude,
  label: "Work",
  configDir: "/home/jane/.claude-work",
  order: 1,
};

describe("json store", () => {
  it("missing_files_yield_defaults", async () => {
    const store = createJsonStore(await makeTempDir());

    expect(await store.readAccounts()).toEqual([]);
    expect(await store.readSettings()).toEqual({
      version: 1,
      permissionProfile: "bypass",
      effectLevel: "auto",
      claudeExecutable: null,
      codexExecutable: null,
    });
  });

  it("accounts_and_settings_round_trip", async () => {
    const dir = join(await makeTempDir(), "nested");
    const store = createJsonStore(dir);
    const settings = {
      version: 1,
      permissionProfile: PermissionProfile.plan,
      effectLevel: "low",
      claudeExecutable: "/usr/bin/claude",
      codexExecutable: "/usr/bin/codex",
    } as const;

    await store.writeAccounts([account]);
    await store.writeSettings(settings);

    expect(await store.readAccounts()).toEqual([account]);
    expect(await store.readSettings()).toEqual(settings);
    expect((await readdir(dir)).sort()).toEqual([
      "accounts.json",
      "settings.json",
    ]);
  });

  it("schema_invalid_version_is_corrupt_and_left_untouched", async () => {
    const dir = await makeTempDir();
    const bytes = '{"version":2,"accounts":[]}';
    await writeFile(join(dir, "accounts.json"), bytes);
    const store = createJsonStore(dir);

    await expect(store.readAccounts()).rejects.toBeInstanceOf(
      StorageCorruptError,
    );

    expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(bytes);
  });

  it("unknown_permission_profile_in_settings_is_corrupt", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "settings.json"),
      '{"version":1,"permissionProfile":"yolo","effectLevel":"auto","claudeExecutable":null}',
    );

    await expect(createJsonStore(dir).readSettings()).rejects.toBeInstanceOf(
      StorageCorruptError,
    );
  });
});

describe("json store writes", () => {
  it("failed_write_leaves_no_temp_file_and_keeps_target", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "accounts.json");
    await mkdir(target);

    await expect(
      createJsonStore(dir).writeAccounts([account]),
    ).rejects.toThrow();

    expect(await readdir(dir)).toEqual(["accounts.json"]);
  });

  it("storage_refuses_to_overwrite_corrupt_file", async () => {
    const dir = await makeTempDir();
    const accountsBytes = '{"version":2,"accounts":[]}';
    const settingsBytes = '{"version":1,"permissionProfile":"yolo"';
    await writeFile(join(dir, "accounts.json"), accountsBytes);
    await writeFile(join(dir, "settings.json"), settingsBytes);
    const store = createJsonStore(dir);

    await expect(store.writeAccounts([account])).rejects.toBeInstanceOf(
      StorageCorruptError,
    );
    await expect(
      store.writeSettings({
        version: 1,
        permissionProfile: PermissionProfile.plan,
        effectLevel: "low",
        claudeExecutable: null,
        codexExecutable: null,
      }),
    ).rejects.toBeInstanceOf(StorageCorruptError);

    expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(
      accountsBytes,
    );
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(
      settingsBytes,
    );
    expect((await readdir(dir)).sort()).toEqual([
      "accounts.json",
      "settings.json",
    ]);
  });

  it("valid_existing_file_is_overwritten", async () => {
    const dir = await makeTempDir();
    const store = createJsonStore(dir);
    await store.writeAccounts([account]);

    await store.writeAccounts([{ ...account, label: "Home" }]);

    expect(await store.readAccounts()).toEqual([{ ...account, label: "Home" }]);
  });

  it("switch_log_appends_one_json_line_per_entry", async () => {
    const dir = await makeTempDir();
    const store = createJsonStore(dir);
    const entry = {
      at: 1_700_000_000_000,
      sessionId: "s1",
      from: "acc-1",
      to: null,
      reason: SwitchReason.rateLimit,
      resetsAt: 1_700_003_600,
      contextPackageChars: 1200,
    };

    await store.appendSwitchLog(entry);
    await store.appendSwitchLog({ ...entry, to: "acc-2", sessionId: "s2" });

    const lines = (await readFile(join(dir, "switch-log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      entry,
      { ...entry, to: "acc-2", sessionId: "s2" },
    ]);
  });
});

describe("readSwitchLog", () => {
  const entry = {
    at: 1,
    sessionId: "s",
    from: "a",
    to: "b",
    reason: SwitchReason.resetReached,
    resetsAt: null,
    contextPackageChars: 5,
  };

  it("missing_file_yields_an_empty_list", async () => {
    const store = createJsonStore(await makeTempDir());

    expect(await store.readSwitchLog(10)).toEqual([]);
  });

  it("returns_the_last_entries_in_file_order", async () => {
    const store = createJsonStore(await makeTempDir());
    for (const at of [1, 2, 3, 4]) {
      await store.appendSwitchLog({ ...entry, at });
    }

    const entries = await store.readSwitchLog(2);

    expect(entries.map(({ at }) => at)).toEqual([3, 4]);
  });

  it("a_zero_limit_yields_nothing", async () => {
    const store = createJsonStore(await makeTempDir());
    await store.appendSwitchLog(entry);

    expect(await store.readSwitchLog(0)).toEqual([]);
  });

  it("skips_invalid_lines_with_their_line_number", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "switch-log.jsonl"),
      [
        JSON.stringify(entry),
        "{broken",
        JSON.stringify({ ...entry, reason: "whim" }),
        JSON.stringify({ ...entry, at: 9 }),
        "",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const entries = await createJsonStore(dir).readSwitchLog(10);

    expect(entries.map(({ at }) => at)).toEqual([1, 9]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "Skipping invalid switch log line 2",
      expect.anything(),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "Skipping invalid switch log line 3",
      expect.anything(),
    );
    warn.mockRestore();
  });
});
