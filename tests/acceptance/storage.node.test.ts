import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createJsonStore,
  StorageCorruptError,
} from "../../src/backend/storage";
import { makeTempDir } from "../fakes/processHelpers";

const CORRUPT_BYTES = '{"version":1,"accounts":[{"id":';

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
