import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { buildAgentEnv } from "../../src/backend/env";
import { IpcErrorCode, type ParamsMap } from "../../src/shared/protocol";
import type { Account, ApiAccount } from "../../src/domain/types";
import {
  ACCOUNT_A,
  ACCOUNT_CODEX_A,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import { FAKE_VAULT_UNAVAILABLE_REASON } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const KEY = "sk-test-groq-0001";
const OTHER_KEY = "sk-test-groq-0002";
const KEYS_FILE = "api-keys.json";
const ACCOUNTS_FILE = "accounts.json";
const KEY_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;

const GROQ_API: ApiAccount = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  baseUrl: null,
  rotation: true,
};

interface KeysFile {
  version: number;
  keys: Record<string, { ciphertext: string; hint: string }>;
}

afterEach(closeRigs);

function opencodeParams(
  rig: BackendRig,
  apiKey = KEY,
): ParamsMap["accounts/add"] {
  return {
    label: "Groq main",
    configDir: join(rig.userData, "accounts", "groq-main"),
    provider: "opencode",
    api: GROQ_API,
    apiKey,
  };
}

async function readKeysFile(rig: BackendRig): Promise<KeysFile> {
  return JSON.parse(
    await readFile(join(rig.userData, KEYS_FILE), "utf8"),
  ) as KeysFile;
}

function keysFileExists(rig: BackendRig): boolean {
  return existsSync(join(rig.userData, KEYS_FILE));
}

it("api_key_account_add_stores_only_encrypted_key", async () => {
  const rig = await openRig({});

  const { account } = await rig.call("accounts/add", opencodeParams(rig));

  expect(account).toMatchObject({
    provider: "opencode",
    label: "Groq main",
    api: GROQ_API,
    hasKey: true,
    keyHint: "0001",
  });
  const stored = await readKeysFile(rig);
  expect(stored.version).toBe(1);
  expect(stored.keys[account.id]?.hint).toBe("0001");
  expect(stored.keys[account.id]?.ciphertext).not.toContain(KEY);
  expect(JSON.stringify(stored)).not.toContain(KEY);
  expect(
    await readFile(join(rig.userData, ACCOUNTS_FILE), "utf8"),
  ).not.toContain(KEY);
});

it.skipIf(process.platform === "win32")(
  "api_key_file_is_readable_by_owner_only",
  async () => {
    const rig = await openRig({});

    await rig.call("accounts/add", opencodeParams(rig));

    expect(statSync(join(rig.userData, KEYS_FILE)).mode & PERMISSION_BITS).toBe(
      KEY_FILE_MODE,
    );
  },
);

it("api_key_never_appears_in_ipc_responses_or_events", async () => {
  const rig = await openRig({});

  const added = await rig.call("accounts/add", opencodeParams(rig));
  const listed = await rig.call("accounts/list", {});
  const snapshot = await rig.call("sessions/snapshot", {});
  const keyed = await rig.call("accounts/setKey", {
    id: added.account.id,
    apiKey: OTHER_KEY,
  });

  const everything = JSON.stringify([
    added,
    listed,
    snapshot,
    keyed,
    rig.broadcasts,
  ]);
  expect(everything).not.toContain(KEY);
  expect(everything).not.toContain(OTHER_KEY);
  expect(listed.accounts[0]).toMatchObject({ hasKey: true, keyHint: "0001" });
});

it("api_key_account_add_fails_when_vault_unavailable", async () => {
  const rig = await openRig({});
  rig.vault.available = false;

  await expect(
    rig.call("accounts/add", opencodeParams(rig)),
  ).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: expect.stringContaining(FAKE_VAULT_UNAVAILABLE_REASON) as string,
  });

  expect(keysFileExists(rig)).toBe(false);
  expect(await rig.store.readAccounts()).toEqual([]);
});

it("api_key_set_key_fails_when_vault_unavailable_and_keeps_old_key", async () => {
  const rig = await openRig({});
  const { account } = await rig.call("accounts/add", opencodeParams(rig));
  const before = await readFile(join(rig.userData, KEYS_FILE), "utf8");
  rig.vault.available = false;

  await expect(
    rig.call("accounts/setKey", { id: account.id, apiKey: OTHER_KEY }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: expect.stringContaining(FAKE_VAULT_UNAVAILABLE_REASON) as string,
  });

  expect(await readFile(join(rig.userData, KEYS_FILE), "utf8")).toBe(before);
});

it("api_key_set_key_replaces_stored_key_and_hint", async () => {
  const rig = await openRig({});
  const { account } = await rig.call("accounts/add", opencodeParams(rig));
  const before = (await readKeysFile(rig)).keys[account.id];

  const updated = await rig.call("accounts/setKey", {
    id: account.id,
    apiKey: OTHER_KEY,
  });

  expect(updated).toMatchObject({
    id: account.id,
    hasKey: true,
    keyHint: "0002",
  });
  const after = (await readKeysFile(rig)).keys[account.id];
  expect(after?.hint).toBe("0002");
  expect(after?.ciphertext).not.toBe(before?.ciphertext);
});

it("api_key_set_key_rejected_for_non_api_account", async () => {
  const rig = await openRig({});
  const { account } = await rig.call("accounts/add", {
    label: "Plain",
    configDir: join(rig.userData, "accounts", "plain"),
  });

  await expect(
    rig.call("accounts/setKey", { id: account.id, apiKey: KEY }),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });

  expect(keysFileExists(rig)).toBe(false);
});

it("api_key_account_remove_deletes_stored_key", async () => {
  const rig = await openRig({});
  const { account } = await rig.call("accounts/add", opencodeParams(rig));

  await rig.call("accounts/remove", { id: account.id });

  expect((await readKeysFile(rig)).keys).toEqual({});
  expect(await rig.store.readAccounts()).toEqual([]);
});

it("legacy_storage_files_load_unchanged", async () => {
  const userData = await makeTempDir();
  const legacy: Account = {
    id: "old-1",
    provider: "claude",
    label: "Old",
    configDir: "/cfg/old",
    order: 0,
  };
  await writeFile(
    join(userData, ACCOUNTS_FILE),
    JSON.stringify({ version: 1, accounts: [legacy] }),
  );
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      version: 1,
      permissionProfile: "ask",
      effectLevel: "low",
      claudeExecutable: null,
    }),
  );
  const rig = await openRig({ userData });

  const { accounts } = await rig.call("accounts/list", {});
  const settings = await rig.call("settings/get", {});

  expect(accounts).toEqual([
    {
      ...legacy,
      api: null,
      hasKey: false,
      keyHint: null,
      runtime: { status: "ready" },
      limit: null,
    },
  ]);
  expect(settings).toEqual({
    permissionProfile: "ask",
    effectLevel: "low",
    claudeExecutable: null,
    codexExecutable: null,
    agyExecutable: null,
    opencodeExecutable: null,
    terminalShell: null,
    updateCheck: true,
    updateChannel: "stable",
  });
});

it("claude_and_codex_account_add_keep_working_without_api_data", async () => {
  const rig = await openRig({});

  const claude = await rig.call("accounts/add", {
    label: "Claude",
    configDir: join(rig.userData, "accounts", "claude"),
  });
  const codex = await rig.call("accounts/add", {
    label: "Codex",
    configDir: join(rig.userData, "accounts", "codex"),
    provider: "codex",
  });

  expect(claude.account).toMatchObject({
    provider: "claude",
    api: null,
    hasKey: false,
    keyHint: null,
  });
  expect(codex.account).toMatchObject({
    provider: "codex",
    api: null,
    hasKey: false,
    keyHint: null,
  });
  const persisted = JSON.parse(
    await readFile(join(rig.userData, ACCOUNTS_FILE), "utf8"),
  ) as { accounts: object[] };
  expect(persisted.accounts.every((entry) => !("api" in entry))).toBe(true);
});

it("corrupt_key_store_is_reported", async () => {
  const userData = await makeTempDir();
  await writeFile(join(userData, KEYS_FILE), "{ not json");
  const rig = await openRig({ userData });

  await expect(rig.call("accounts/add", opencodeParams(rig))).rejects.toThrow(
    /corrupt/i,
  );

  expect(await rig.store.readAccounts()).toEqual([]);
});

it("provider_keys_and_opencode_variables_are_not_passed_to_any_agent", () => {
  const parent = {
    PATH: "/usr/bin",
    GROQ_API_KEY: KEY,
    CEREBRAS_API_KEY: KEY,
    OPENROUTER_API_KEY: KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: KEY,
    GEMINI_API_KEY: KEY,
    GOOGLE_API_KEY: KEY,
    MISTRAL_API_KEY: KEY,
    ZHIPU_API_KEY: KEY,
    DEEPSEEK_API_KEY: KEY,
    MOONSHOT_API_KEY: KEY,
    OPENCODE_CONFIG: "/tmp/opencode.json",
    OPENCODE_API_KEY: KEY,
  };
  const providers = ["claude", "codex", "opencode"] as const;

  for (const provider of providers) {
    const env = buildAgentEnv({
      parent,
      platform: "linux",
      homeDir: "/home/jane",
      account: {
        id: "a",
        provider,
        label: "A",
        configDir: "/cfg/a",
        order: 0,
      },
      executable: "/usr/bin/agent",
      runMarker: "run-1",
      testMode: false,
    });
    expect(Object.keys(env).filter((name) => name in parent)).toEqual(["PATH"]);
  }
});

const CORRUPT_KEYS = "{ not json";
const EMPTY_KEYS = '{"version":1,"keys":{}}';
const STORED_OPENCODE: Account = {
  id: "oc-1",
  provider: "opencode",
  label: "Groq main",
  configDir: "/tmp/codeweave-oc-1",
  order: 1,
  api: GROQ_API,
};

async function rigWithCorruptKeyStore(
  accounts: readonly Account[],
): Promise<BackendRig> {
  const userData = await makeTempDir();
  await writeFile(join(userData, KEYS_FILE), CORRUPT_KEYS);
  return openRig({ userData, accounts });
}

it("remove_claude_account_ignores_corrupt_key_store", async () => {
  const rig = await rigWithCorruptKeyStore([ACCOUNT_A, ACCOUNT_CODEX_A]);

  const broadcastsBefore = rig.broadcastsOf("accounts/changed").length;

  const claude = await rig.call("accounts/remove", { id: ACCOUNT_A.id });
  const codex = await rig.call("accounts/remove", { id: ACCOUNT_CODEX_A.id });

  expect(claude.accounts.map(({ id }) => id)).toEqual([ACCOUNT_CODEX_A.id]);
  expect(codex.accounts).toEqual([]);
  expect(await rig.store.readAccounts()).toEqual([]);
  expect(rig.broadcastsOf("accounts/changed").length).toBeGreaterThan(
    broadcastsBefore,
  );
});

it("remove_opencode_account_fails_before_persist", async () => {
  const rig = await rigWithCorruptKeyStore([ACCOUNT_A, STORED_OPENCODE]);
  const before = await readFile(join(rig.userData, ACCOUNTS_FILE), "utf8");
  const broadcastsBefore = rig.broadcastsOf("accounts/changed").length;

  await expect(
    rig.call("accounts/remove", { id: STORED_OPENCODE.id }),
  ).rejects.toThrow(/corrupt/i);

  expect(await readFile(join(rig.userData, ACCOUNTS_FILE), "utf8")).toBe(
    before,
  );
  expect(rig.broadcastsOf("accounts/changed")).toHaveLength(broadcastsBefore);
});

it("key_store_reload_after_corrupt_file_fixed", async () => {
  const rig = await rigWithCorruptKeyStore([STORED_OPENCODE]);
  await expect(
    rig.call("accounts/remove", { id: STORED_OPENCODE.id }),
  ).rejects.toThrow(/corrupt/i);

  await writeFile(join(rig.userData, KEYS_FILE), EMPTY_KEYS);

  const result = await rig.call("accounts/remove", { id: STORED_OPENCODE.id });
  expect(result.accounts).toEqual([]);
  expect(await rig.store.readAccounts()).toEqual([]);
});
