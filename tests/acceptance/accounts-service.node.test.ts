import { statSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import {
  createAccountsService,
  type AccountsService,
} from "../../src/backend/accountsService";
import { createKeyStore } from "../../src/backend/secrets/keyStore";
import { createJsonStore, type JsonStore } from "../../src/backend/storage";
import { createFakeVault } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const QUEUE_SETTLE_MS = 50;
const READ_ONLY_DIR_MODE = 0o500;
const WRITABLE_DIR_MODE = 0o700;

interface Harness {
  service: AccountsService;
  store: JsonStore;
  userData: string;
  broadcast: ReturnType<typeof vi.fn>;
  inUse: Set<string>;
}

async function setup(): Promise<Harness> {
  const userData = await makeTempDir();
  const store = createJsonStore(userData);
  const broadcast = vi.fn();
  const inUse = new Set<string>();
  const service = createAccountsService({
    store,
    keyStore: createKeyStore({
      path: join(userData, "api-keys.json"),
      vault: createFakeVault(),
    }),
    userData,
    broadcast,
    runtimeOf: () => ({ status: "ready" }),
    limitOf: () => null,
    isInUse: (id) => inUse.has(id),
  });
  return { service, store, userData, broadcast, inUse };
}

async function addNamed(
  { service, userData }: Harness,
  name: string,
): Promise<string> {
  const { account } = await service.add({
    label: name,
    configDir: join(userData, "dirs", name),
  });
  return account.id;
}

it("accounts_publish_serialized_with_mutations", async () => {
  const harness = await setup();
  const keep = await addNamed(harness, "keep");
  const drop = await addNamed(harness, "drop");
  harness.broadcast.mockClear();
  const writeGate = Promise.withResolvers<undefined>();
  const realWrite = harness.store.writeAccounts.bind(harness.store);
  vi.spyOn(harness.store, "writeAccounts").mockImplementation(
    async (accounts) => {
      await writeGate.promise;
      await realWrite(accounts);
    },
  );

  const removal = harness.service.remove(drop);
  const published = harness.service.publish();
  await sleep(QUEUE_SETTLE_MS);
  writeGate.resolve(undefined);
  await Promise.all([removal, published]);

  expect(harness.broadcast).toHaveBeenCalledTimes(2);
  for (const [, payload] of harness.broadcast.mock.calls) {
    expect(payload).toEqual({
      accounts: [expect.objectContaining({ id: keep })],
    });
  }
});

it("accounts_add_creates_default_config_dir_and_broadcasts", async () => {
  const { service, store, userData, broadcast } = await setup();
  const { configDir } = service.suggest();
  expect(configDir.startsWith(join(userData, "accounts") + sep)).toBe(true);

  const { account } = await service.add({ label: "Work", configDir });

  expect(statSync(configDir, { throwIfNoEntry: false })?.isDirectory()).toBe(
    true,
  );
  expect(account).toEqual({
    id: expect.any(String) as string,
    provider: "claude",
    label: "Work",
    configDir,
    order: 0,
    api: null,
    hasKey: false,
    keyHint: null,
    runtime: { status: "ready" },
    limit: null,
  });
  expect(await store.readAccounts()).toEqual([
    { id: account.id, provider: "claude", label: "Work", configDir, order: 0 },
  ]);
  expect(broadcast).toHaveBeenCalledExactlyOnceWith("accounts/changed", {
    accounts: [account],
  });
});

it("account_remove_in_use_rejected_with_conflict", async () => {
  const harness = await setup();
  const id = await addNamed(harness, "a");
  harness.inUse.add(id);
  harness.broadcast.mockClear();

  await expect(harness.service.remove(id)).rejects.toMatchObject({
    code: "CONFLICT",
  });

  expect(await harness.store.readAccounts()).toHaveLength(1);
  expect(harness.broadcast).not.toHaveBeenCalled();
});

it("account_remove_unknown_rejected_with_not_found", async () => {
  const { service } = await setup();

  await expect(service.remove("missing")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("account_remove_renumbers_remaining_orders", async () => {
  const harness = await setup();
  const first = await addNamed(harness, "a");
  await addNamed(harness, "b");
  await addNamed(harness, "c");

  const { accounts } = await harness.service.remove(first);

  expect(accounts.map(({ label, order }) => [label, order])).toEqual([
    ["b", 0],
    ["c", 1],
  ]);
});

it("accounts_concurrent_adds_keep_both", async () => {
  const { service, store, userData } = await setup();

  await Promise.all([
    service.add({ label: "A", configDir: join(userData, "x", "a") }),
    service.add({ label: "B", configDir: join(userData, "x", "b") }),
  ]);

  const stored = await store.readAccounts();
  expect(stored.map(({ label, order }) => [label, order])).toEqual([
    ["A", 0],
    ["B", 1],
  ]);
});

it("accounts_mutation_broadcasts_changed", async () => {
  const harness = await setup();
  const first = await addNamed(harness, "a");
  await addNamed(harness, "b");
  harness.broadcast.mockClear();

  const { accounts } = await harness.service.move(first, "down");

  expect(accounts.map(({ label }) => label)).toEqual(["b", "a"]);
  expect(harness.broadcast).toHaveBeenCalledExactlyOnceWith(
    "accounts/changed",
    { accounts },
  );
});

it("accounts_move_at_the_edge_is_a_no_op_without_broadcast", async () => {
  const harness = await setup();
  const first = await addNamed(harness, "a");
  await addNamed(harness, "b");
  harness.broadcast.mockClear();

  const { accounts } = await harness.service.move(first, "up");

  expect(accounts.map(({ label, order }) => [label, order])).toEqual([
    ["a", 0],
    ["b", 1],
  ]);
  expect(harness.broadcast).not.toHaveBeenCalled();
});

it("accounts_add_rejects_relative_config_dir", async () => {
  const { service, store } = await setup();

  await expect(
    service.add({ label: "Rel", configDir: "relative/dir" }),
  ).rejects.toMatchObject({ code: "VALIDATION" });

  expect(await store.readAccounts()).toEqual([]);
});

const CODEX_CONFIG_BYTES = 'cli_auth_credentials_store = "file"\n';

it("codex_account_add_writes_file_credential_store", async () => {
  const { service, store, userData } = await setup();
  const configDir = join(userData, "codex", "main");

  const { account } = await service.add({
    label: "Codex",
    configDir,
    provider: "codex",
  });

  expect(account.provider).toBe("codex");
  expect(await readFile(join(configDir, "config.toml"), "utf8")).toBe(
    CODEX_CONFIG_BYTES,
  );
  expect(await readdir(configDir)).toEqual(["config.toml"]);
  expect((await store.readAccounts()).map(({ provider }) => provider)).toEqual([
    "codex",
  ]);
});

it("codex_account_add_keeps_existing_config", async () => {
  const { service, userData } = await setup();
  const configDir = join(userData, "codex", "existing");
  const existing = 'model = "gpt-5"\n';
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.toml"), existing);

  await service.add({ label: "Codex", configDir, provider: "codex" });

  expect(await readFile(join(configDir, "config.toml"), "utf8")).toBe(existing);
});

it("accounts_add_without_provider_creates_claude_account_without_config", async () => {
  const { service, userData } = await setup();
  const configDir = join(userData, "claude", "main");

  const { account } = await service.add({ label: "Claude", configDir });

  expect(account.provider).toBe("claude");
  expect(await readdir(configDir)).toEqual([]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "codex_account_add_propagates_config_write_error_and_persists_nothing",
  async () => {
    const { service, store, userData } = await setup();
    const configDir = join(userData, "codex", "readonly");
    await mkdir(configDir, { recursive: true });
    await chmod(configDir, READ_ONLY_DIR_MODE);

    await expect(
      service.add({ label: "Codex", configDir, provider: "codex" }),
    ).rejects.toMatchObject({ code: "EACCES" });

    await chmod(configDir, WRITABLE_DIR_MODE);
    expect(await store.readAccounts()).toEqual([]);
  },
);

it("api_key_account_add_removes_the_stored_key_when_persisting_fails", async () => {
  const harness = await setup();
  vi.spyOn(harness.store, "writeAccounts").mockRejectedValue(
    new Error("disk full"),
  );

  await expect(
    harness.service.add({
      label: "Groq",
      configDir: join(harness.userData, "dirs", "groq"),
      provider: "opencode",
      api: {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        baseUrl: null,
        rotation: true,
      },
      apiKey: "sk-test-groq-0001",
    }),
  ).rejects.toThrow("disk full");

  expect(
    JSON.parse(await readFile(join(harness.userData, "api-keys.json"), "utf8")),
  ).toEqual({ version: 1, keys: {} });
  expect(harness.broadcast).not.toHaveBeenCalled();
});

const OUTSIDE_MANAGED_DIR_MESSAGE =
  "A Gemini account directory must be inside the Codeweave accounts directory";
const SECOND_GEMINI_MESSAGE =
  "Only one Gemini account is supported: agy keeps a single Google login per user";

function geminiParams(
  configDir: string,
  label = "Gemini",
): Parameters<AccountsService["add"]>[0] {
  return { label, configDir, provider: "gemini" };
}

function exists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

it("first_gemini_account_is_added_and_its_dir_created", async () => {
  const harness = await setup();
  const configDir = join(harness.userData, "accounts", "g1");

  const { account } = await harness.service.add(geminiParams(configDir));

  expect(account).toMatchObject({
    provider: "gemini",
    label: "Gemini",
    configDir,
    order: 0,
  });
  expect(exists(configDir)).toBe(true);
  expect((await harness.store.readAccounts()).map((item) => item.id)).toEqual([
    account.id,
  ]);
});

it("second_gemini_account_rejected", async () => {
  const harness = await setup();
  await harness.service.add(
    geminiParams(join(harness.userData, "accounts", "g1")),
  );
  const secondDir = join(harness.userData, "accounts", "g2");
  harness.broadcast.mockClear();

  await expect(
    harness.service.add(geminiParams(secondDir, "Second")),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    message: SECOND_GEMINI_MESSAGE,
  });

  expect(await harness.store.readAccounts()).toHaveLength(1);
  expect(exists(secondDir)).toBe(false);
  expect(harness.broadcast).not.toHaveBeenCalled();
});

it("gemini_account_is_allowed_next_to_other_providers", async () => {
  const harness = await setup();
  await harness.service.add({
    label: "Codex",
    configDir: join(harness.userData, "dirs", "codex"),
    provider: "codex",
  });

  const { account } = await harness.service.add(
    geminiParams(join(harness.userData, "accounts", "g1")),
  );

  expect(account.order).toBe(1);
  expect(await harness.store.readAccounts()).toHaveLength(2);
});

it("gemini_account_config_dir_is_managed", async () => {
  const harness = await setup();
  const outside = [
    join(harness.userData, "dirs", "g"),
    join(harness.userData, "accounts"),
    join(harness.userData, "accounts-evil", "g"),
    join(harness.userData, "accounts", "..", "..", "evil"),
    join(harness.userData, "accounts", "..", "g"),
  ];

  for (const configDir of outside) {
    await expect(
      harness.service.add(geminiParams(configDir)),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: OUTSIDE_MANAGED_DIR_MESSAGE,
    });
  }

  expect(await harness.store.readAccounts()).toEqual([]);
  expect(exists(join(harness.userData, "dirs"))).toBe(false);
  expect(exists(join(harness.userData, "accounts-evil"))).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "gemini_symlinked_dir_outside_accounts_rejected",
  async () => {
    const harness = await setup();
    const outside = join(harness.userData, "outside");
    const link = join(harness.userData, "accounts", "link");
    await mkdir(outside, { recursive: true });
    await mkdir(join(harness.userData, "accounts"), { recursive: true });
    await symlink(outside, link, "dir");

    await expect(harness.service.add(geminiParams(link))).rejects.toMatchObject(
      {
        code: "VALIDATION",
        message: OUTSIDE_MANAGED_DIR_MESSAGE,
      },
    );

    expect(await harness.store.readAccounts()).toEqual([]);
    expect((await harness.service.list()).accounts).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "gemini_symlinked_nested_new_dir_rejected_without_creating_it",
  async () => {
    const harness = await setup();
    const outside = join(harness.userData, "outside");
    const link = join(harness.userData, "accounts", "link");
    await mkdir(outside, { recursive: true });
    await mkdir(join(harness.userData, "accounts"), { recursive: true });
    await symlink(outside, link, "dir");

    await expect(
      harness.service.add(geminiParams(join(link, "new"))),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: OUTSIDE_MANAGED_DIR_MESSAGE,
    });

    expect(exists(join(outside, "new"))).toBe(false);
    expect(await harness.store.readAccounts()).toEqual([]);
  },
);

it("gemini_new_dir_inside_accounts_accepted", async () => {
  const harness = await setup();
  const configDir = join(harness.userData, "accounts", "fresh");

  const { account } = await harness.service.add(geminiParams(configDir));

  expect(account.configDir).toBe(configDir);
  expect(exists(configDir)).toBe(true);
  expect(await harness.store.readAccounts()).toHaveLength(1);
});

it("gemini_account_dir_with_trailing_slash_or_dotdot_normalised", async () => {
  const harness = await setup();
  const normalised = join(harness.userData, "accounts", "g1");

  const { account } = await harness.service.add(
    geminiParams(
      `${join(harness.userData, "accounts", "tmp", "..", "g1")}${sep}`,
    ),
  );

  expect(account.configDir).toBe(normalised);
  expect((await harness.store.readAccounts())[0]?.configDir).toBe(normalised);
  expect(exists(normalised)).toBe(true);
});

it("relative_gemini_config_dir_rejected", async () => {
  const harness = await setup();

  await expect(
    harness.service.add(geminiParams(join("accounts", "g1"))),
  ).rejects.toMatchObject({ code: "VALIDATION" });
});

it("accounts_move_unknown_rejected_with_not_found", async () => {
  const { service } = await setup();

  await expect(service.move("missing", "up")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
