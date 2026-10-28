import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ProviderId, type Account } from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type { AccountRuntimeView, AccountView } from "../shared/views";

import type { ConnectionRegistry } from "./connections";
import {
  ACCOUNTS_DIR_NAME,
  CODEX_CONFIG_FILE_NAME,
  CODEX_FILE_CREDENTIAL_STORE_CONFIG,
} from "./constants";
import { createSerializer } from "./serialize";
import type { JsonStore } from "./storage";

export interface AccountsResult {
  accounts: AccountView[];
}

export interface AccountsServiceDeps {
  store: JsonStore;
  userData: string;
  broadcast: ConnectionRegistry["broadcast"];
  runtimeOf: (id: string) => AccountRuntimeView;
  isInUse: (id: string) => boolean;
}

export interface AccountsService {
  list(): Promise<AccountsResult>;
  suggest(): { configDir: string };
  publish(): Promise<void>;
  add(params: ParamsMap["accounts/add"]): Promise<{ account: AccountView }>;
  remove(id: string): Promise<AccountsResult>;
  move(
    id: string,
    direction: ParamsMap["accounts/move"]["direction"],
  ): Promise<AccountsResult>;
}

interface Repository {
  readSorted(): Promise<Account[]>;
  persist(accounts: readonly Account[]): Promise<AccountsResult>;
  publish(): Promise<void>;
  toView: (account: Account) => AccountView;
}

function byOrder(left: Account, right: Account): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function accountNotFound(): IpcError {
  return new IpcError(IpcErrorCode.NOT_FOUND, "Account not found");
}

function absoluteConfigDir(configDir: string): string {
  if (!isAbsolute(configDir)) {
    throw new IpcError(
      IpcErrorCode.VALIDATION,
      "Account directory must be an absolute path",
    );
  }
  return resolve(configDir);
}

function createRepository(deps: AccountsServiceDeps): Repository {
  const { store, runtimeOf, broadcast } = deps;
  const toView = (account: Account): AccountView => ({
    ...account,
    runtime: runtimeOf(account.id),
  });
  return {
    toView,
    async readSorted(): Promise<Account[]> {
      return (await store.readAccounts()).toSorted(byOrder);
    },
    async persist(accounts): Promise<AccountsResult> {
      const ordered = accounts.map((account, order) => ({ ...account, order }));
      await store.writeAccounts(ordered);
      const result = { accounts: ordered.map(toView) };
      broadcast("accounts/changed", result);
      return result;
    },
    async publish(): Promise<void> {
      const accounts = (await store.readAccounts()).toSorted(byOrder);
      broadcast("accounts/changed", { accounts: accounts.map(toView) });
    },
  };
}

async function writeCodexConfig(directory: string): Promise<void> {
  try {
    await writeFile(
      join(directory, CODEX_CONFIG_FILE_NAME),
      CODEX_FILE_CREDENTIAL_STORE_CONFIG,
      { flag: "wx" },
    );
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
  }
}

async function addAccount(
  repository: Repository,
  { label, configDir, provider = ProviderId.claude }: ParamsMap["accounts/add"],
): Promise<{ account: AccountView }> {
  const directory = absoluteConfigDir(configDir);
  const accounts = await repository.readSorted();
  const account: Account = {
    id: randomUUID(),
    provider,
    label: label.trim(),
    configDir: directory,
    order: accounts.length,
  };
  await mkdir(directory, { recursive: true });
  if (provider === ProviderId.codex) {
    await writeCodexConfig(directory);
  }
  await repository.persist([...accounts, account]);
  return { account: repository.toView(account) };
}

async function removeAccount(
  repository: Repository,
  isInUse: (id: string) => boolean,
  id: string,
): Promise<AccountsResult> {
  const accounts = await repository.readSorted();
  if (!accounts.some((account) => account.id === id)) {
    throw accountNotFound();
  }
  if (isInUse(id)) {
    throw new IpcError(
      IpcErrorCode.CONFLICT,
      "Account is used by the running session",
    );
  }
  return repository.persist(accounts.filter((account) => account.id !== id));
}

async function moveAccount(
  repository: Repository,
  id: string,
  direction: ParamsMap["accounts/move"]["direction"],
): Promise<AccountsResult> {
  const accounts = await repository.readSorted();
  const index = accounts.findIndex((account) => account.id === id);
  const current = accounts[index];
  if (current === undefined) {
    throw accountNotFound();
  }
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  const neighbour = accounts[targetIndex];
  if (neighbour === undefined) {
    return { accounts: accounts.map(repository.toView) };
  }
  return repository.persist(
    accounts.with(index, neighbour).with(targetIndex, current),
  );
}

export function createAccountsService(
  deps: AccountsServiceDeps,
): AccountsService {
  const repository = createRepository(deps);
  const serialized = createSerializer();
  return {
    async list(): Promise<AccountsResult> {
      return {
        accounts: (await repository.readSorted()).map(repository.toView),
      };
    },
    suggest: () => ({
      configDir: join(deps.userData, ACCOUNTS_DIR_NAME, randomUUID()),
    }),
    publish: () => serialized(() => repository.publish()),
    add: (params) => serialized(() => addAccount(repository, params)),
    remove: (id) =>
      serialized(() => removeAccount(repository, deps.isInUse, id)),
    move: (id, direction) =>
      serialized(() => moveAccount(repository, id, direction)),
  };
}
