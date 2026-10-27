import { statSync } from "node:fs";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  createAccountsService,
  type AccountsService,
} from "../../src/backend/accountsService";
import { createJsonStore, type JsonStore } from "../../src/backend/storage";
import { makeTempDir } from "../fakes/processHelpers";

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
    userData,
    broadcast,
    runtimeOf: () => ({ status: "ready" }),
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

it("accounts_add_creates_default_config_dir_and_broadcasts", async () => {
  const { service, store, userData, broadcast } = await setup();
  const { configDir } = service.suggest();
  expect(configDir.startsWith(join(userData, "accounts") + "/")).toBe(true);

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
    runtime: { status: "ready" },
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

it("accounts_move_unknown_rejected_with_not_found", async () => {
  const { service } = await setup();

  await expect(service.move("missing", "up")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
