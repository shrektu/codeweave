import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createFakeVault } from "../../../tests/fakes/fakeVault";
import { makeTempDir } from "../../../tests/fakes/processHelpers";
import { IpcError, IpcErrorCode } from "../../shared/protocol";
import { StorageCorruptError } from "../storage";

import { createKeyStore } from "./keyStore";

const KEY = "sk-test-groq-0001";
const OTHER_KEY = "sk-test-groq-0002";
const KEY_RETRY_WAIT_MS = 10_000;
const PERMISSION_BITS = 0o777;
const OWNER_ONLY_MODE = 0o600;
const WORLD_READABLE_MODE = 0o644;

async function fixture(): Promise<{
  readonly dir: string;
  readonly path: string;
  readonly vault: ReturnType<typeof createFakeVault>;
}> {
  const dir = await makeTempDir();
  return { dir, path: join(dir, "api-keys.json"), vault: createFakeVault() };
}

const StoredKeysFile = z.object({ keys: z.record(z.string(), z.unknown()) });

async function storedAccountIds(path: string): Promise<string[]> {
  const file = StoredKeysFile.parse(JSON.parse(await readFile(path, "utf8")));
  return Object.keys(file.keys);
}

describe("key store persistence", () => {
  it("stores_ciphertext_and_hint_never_the_plaintext", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });

    await store.set("acc-1", KEY);

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      keys: {
        "acc-1": {
          ciphertext: Buffer.from("1000-qorg-tset-ks").toString("base64"),
          hint: "0001",
        },
      },
    });
    expect(store.hint("acc-1")).toBe("0001");
    expect(await store.get("acc-1")).toBe(KEY);
  });

  it.skipIf(process.platform === "win32")(
    "writes_the_file_readable_by_the_owner_only",
    async () => {
      const { path, vault } = await fixture();

      await createKeyStore({ path, vault }).set("acc-1", KEY);

      expect((await stat(path)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_MODE);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens_the_mode_of_an_existing_file_on_load",
    async () => {
      const { path, vault } = await fixture();
      await createKeyStore({ path, vault }).set("acc-1", KEY);
      await chmod(path, WORLD_READABLE_MODE);

      await createKeyStore({ path, vault }).ready();

      expect((await stat(path)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_MODE);
    },
  );

  it("leaves_no_temp_files_behind", async () => {
    const { dir, path, vault } = await fixture();
    const store = createKeyStore({ path, vault });

    await store.set("acc-1", KEY);
    await store.set("acc-1", OTHER_KEY);

    expect(await readdir(dir)).toEqual(["api-keys.json"]);
  });

  it("set_replaces_the_key_and_hint_of_an_account", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);

    await store.set("acc-1", OTHER_KEY);

    expect(store.hint("acc-1")).toBe("0002");
    expect(await store.get("acc-1")).toBe(OTHER_KEY);
    expect(store.knownValues()).toEqual(new Set([KEY, OTHER_KEY]));
  });
});

describe("key store loading", () => {
  it("a_missing_file_is_an_empty_store", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });

    await store.ready();

    expect(store.hint("acc-1")).toBeNull();
    expect(await store.get("acc-1")).toBeNull();
    expect(store.knownValues()).toEqual(new Set());
    expect(store.knownEntries()).toEqual([]);
  });

  it("decrypts_all_stored_keys_at_start", async () => {
    const { path, vault } = await fixture();
    const writer = createKeyStore({ path, vault });
    await writer.set("acc-1", KEY);
    await writer.set("acc-2", OTHER_KEY);

    const reader = createKeyStore({ path, vault });
    await reader.ready();

    expect(reader.knownEntries()).toEqual([
      { accountId: "acc-1", value: KEY },
      { accountId: "acc-2", value: OTHER_KEY },
    ]);
    expect(reader.hint("acc-2")).toBe("0002");
  });

  it("a_key_that_cannot_be_decrypted_keeps_its_hint_but_has_no_value", async () => {
    const { path, vault } = await fixture();
    await createKeyStore({ path, vault }).set("acc-1", KEY);
    await createKeyStore({ path, vault }).set("acc-2", OTHER_KEY);
    vault.available = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reader = createKeyStore({ path, vault });
    await reader.ready();

    expect(reader.hint("acc-1")).toBe("0001");
    expect(reader.knownValues()).toEqual(new Set());
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it.each([
    ["invalid json", "{ not json"],
    ["a wrong version", '{"version":2,"keys":{}}'],
    ["a key without ciphertext", '{"version":1,"keys":{"a":{"hint":"0001"}}}'],
    ["an extra field", '{"version":1,"keys":{},"extra":1}'],
  ])("%s_is_reported_as_a_corrupt_store", async (_label, bytes) => {
    const { path, vault } = await fixture();
    await writeFile(path, bytes);
    const store = createKeyStore({ path, vault });

    await expect(store.ready()).rejects.toBeInstanceOf(StorageCorruptError);
    await expect(store.set("acc-1", KEY)).rejects.toBeInstanceOf(
      StorageCorruptError,
    );

    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});

describe("key store removal and failure", () => {
  it("remove_deletes_the_key_from_file_and_memory", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);
    await store.set("acc-2", OTHER_KEY);

    await store.remove("acc-1");

    expect(await storedAccountIds(path)).toEqual(["acc-2"]);
    expect(store.hint("acc-1")).toBeNull();
    expect(await store.get("acc-1")).toBeNull();
    expect(store.knownValues()).toEqual(new Set([KEY, OTHER_KEY]));
  });

  it("remove_is_idempotent_and_ignores_unknown_accounts", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);

    await store.remove("acc-1");
    await store.remove("acc-1");
    await store.remove("never-existed");

    expect(await storedAccountIds(path)).toEqual([]);
  });

  it("remove_on_a_missing_file_writes_nothing", async () => {
    const { dir, path, vault } = await fixture();

    await createKeyStore({ path, vault }).remove("acc-1");

    expect(await readdir(dir)).toEqual([]);
  });
});

describe("key store failure", () => {
  it("set_fails_with_the_vault_reason_and_writes_nothing", async () => {
    const { dir, path, vault } = await fixture();
    vault.available = false;
    vault.reason = "the OS keyring is not available (basic_text backend)";
    const store = createKeyStore({ path, vault });

    const failure = await store
      .set("acc-1", KEY)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IpcError);
    expect(failure).toMatchObject({
      code: IpcErrorCode.UNAVAILABLE,
      message: "the OS keyring is not available (basic_text backend)",
    });
    expect(await readdir(dir)).toEqual([]);
    expect(store.hint("acc-1")).toBeNull();
  });

  it("a_failed_replacement_keeps_the_previous_key", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);
    const before = await readFile(path, "utf8");
    vault.available = false;

    await expect(store.set("acc-1", OTHER_KEY)).rejects.toBeInstanceOf(
      IpcError,
    );

    expect(await readFile(path, "utf8")).toBe(before);
    expect(store.hint("acc-1")).toBe("0001");
    expect(await store.get("acc-1")).toBe(KEY);
  });

  it("concurrent_sets_for_different_accounts_are_both_kept", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });

    await Promise.all([store.set("acc-1", KEY), store.set("acc-2", OTHER_KEY)]);

    expect(await storedAccountIds(path)).toEqual(["acc-1", "acc-2"]);
  });
});

describe("key store retired keys", () => {
  it("replaced_key_stays_masked", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);

    await store.set("acc-1", OTHER_KEY);

    expect(store.knownEntries()).toEqual([
      { accountId: "acc-1", value: OTHER_KEY },
      { accountId: "acc-1", value: KEY },
    ]);
  });

  it("removed_key_stays_masked", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);

    await store.remove("acc-1");

    expect(store.knownEntries()).toEqual([{ accountId: "acc-1", value: KEY }]);
  });

  it("retired_keys_are_never_persisted", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);
    await store.set("acc-1", OTHER_KEY);
    await store.remove("acc-1");

    const reader = createKeyStore({ path, vault });
    await reader.ready();

    expect(reader.knownEntries()).toEqual([]);
    expect(await readFile(path, "utf8")).not.toContain(KEY);
  });

  it("setting_the_same_key_again_retires_nothing_twice", async () => {
    const { path, vault } = await fixture();
    const store = createKeyStore({ path, vault });
    await store.set("acc-1", KEY);

    await store.set("acc-1", KEY);

    expect(store.knownEntries()).toEqual([{ accountId: "acc-1", value: KEY }]);
  });
});

describe("key store recovery", () => {
  it("key_store_reload_after_corrupt_file_fixed", async () => {
    const { path, vault } = await fixture();
    await writeFile(path, "{ not json");
    const store = createKeyStore({ path, vault });
    await expect(store.ready()).rejects.toBeInstanceOf(StorageCorruptError);

    await writeFile(path, '{"version":1,"keys":{}}');

    await expect(store.ready()).resolves.toBeUndefined();
    await store.set("acc-1", KEY);
    expect(await store.get("acc-1")).toBe(KEY);
  });

  it("failed_startup_decrypt_is_retried_for_masking", async () => {
    const { path, vault } = await fixture();
    await createKeyStore({ path, vault }).set("acc-1", KEY);
    vault.available = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reader = createKeyStore({ path, vault });
    await reader.ready();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(reader.knownValues()).toEqual(new Set());
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2);
    });

    vault.available = true;
    vi.setSystemTime(Date.now() + KEY_RETRY_WAIT_MS);
    reader.knownValues();

    await vi.waitFor(() => {
      expect(reader.knownValues()).toEqual(new Set([KEY]));
    });
    vi.useRealTimers();
    warn.mockRestore();
  });
});
