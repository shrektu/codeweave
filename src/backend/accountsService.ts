import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ProviderId, type Account } from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type {
  AccountRuntimeView,
  AccountView,
  LimitView,
} from "../shared/views";

import type { ConnectionRegistry } from "./connections";
import {
  ACCOUNTS_DIR_NAME,
  CODEX_CONFIG_FILE_NAME,
  CODEX_FILE_CREDENTIAL_STORE_CONFIG,
} from "./constants";
import type { KeyStore } from "./secrets/keyStore";
import { createSerializer } from "./serialize";
import type { JsonStore } from "./storage";

export interface AccountsResult {
  accounts: AccountView[];
}

export interface AccountsServiceDeps {
  store: JsonStore;
  keyStore: KeyStore;
  userData: string;
  broadcast: ConnectionRegistry["broadcast"];
  runtimeOf: (id: string) => AccountRuntimeView;
  limitOf: (id: string) => LimitView | null;
  isInUse: (id: string) => boolean;
}

export interface AccountsService {
  list(): Promise<AccountsResult>;
  suggest(): { configDir: string };
  publish(): Promise<void>;
  add(params: ParamsMap["accounts/add"]): Promise<{ account: AccountView }>;
  setKey(params: ParamsMap["accounts/setKey"]): Promise<AccountView>;
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

interface AccountsServiceParts {
  readonly repository: Repository;
  readonly keyStore: KeyStore;
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
  const { store, keyStore, runtimeOf, limitOf, broadcast } = deps;
  const toView = (account: Account): AccountView => ({
    ...account,
    api: account.api ?? null,
    hasKey: keyStore.hint(account.id) !== null,
    keyHint: keyStore.hint(account.id),
    runtime: runtimeOf(account.id),
    limit: limitOf(account.id),
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

async function persistWithKey(
  {
    repository,
    keyStore,
  }: Pick<AccountsServiceParts, "repository" | "keyStore">,
  accounts: readonly Account[],
  account: Account,
  apiKey: string,
): Promise<void> {
  await keyStore.set(account.id, apiKey);
  try {
    await repository.persist([...accounts, account]);
  } catch (error) {
    await keyStore.remove(account.id).catch((removeError: unknown) => {
      console.error(
        "failed to remove the key of a rejected account",
        removeError,
      );
    });
    throw error;
  }
}

async function addAccount(
  parts: AccountsServiceParts,
  params: ParamsMap["accounts/add"],
): Promise<{ account: AccountView }> {
  const { repository } = parts;
  const directory = absoluteConfigDir(params.configDir);
  const accounts = await repository.readSorted();
  const account: Account = {
    id: randomUUID(),
    provider: params.provider ?? ProviderId.claude,
    label: params.label.trim(),
    configDir: directory,
    order: accounts.length,
    ...(params.provider === ProviderId.opencode ? { api: params.api } : {}),
  };
  await mkdir(directory, { recursive: true });
  if (params.provider === ProviderId.codex) {
    await writeCodexConfig(directory);
  }
  if (params.provider === ProviderId.opencode) {
    await persistWithKey(parts, accounts, account, params.apiKey);
  } else {
    await repository.persist([...accounts, account]);
  }
  return { account: repository.toView(account) };
}

async function setAccountKey(
  { repository, keyStore }: AccountsServiceParts,
  { id, apiKey }: ParamsMap["accounts/setKey"],
): Promise<AccountView> {
  const account = (await repository.readSorted()).find(
    (item) => item.id === id,
  );
  if (account === undefined) {
    throw accountNotFound();
  }
  if (account.provider !== ProviderId.opencode) {
    throw new IpcError(
      IpcErrorCode.VALIDATION,
      "Only API key accounts hold a key",
    );
  }
  await keyStore.set(id, apiKey);
  await repository.publish();
  return repository.toView(account);
}

async function removeAccount(
  { repository, keyStore }: AccountsServiceParts,
  isInUse: (id: string) => boolean,
  id: string,
): Promise<AccountsResult> {
  const accounts = await repository.readSorted();
  const target = accounts.find((account) => account.id === id);
  if (target === undefined) {
    throw accountNotFound();
  }
  if (isInUse(id)) {
    throw new IpcError(
      IpcErrorCode.CONFLICT,
      "Account is used by the running session",
    );
  }
  if (target.provider === ProviderId.opencode) {
    await keyStore.remove(id);
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
  const parts: AccountsServiceParts = { repository, keyStore: deps.keyStore };
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
    add: (params) => serialized(() => addAccount(parts, params)),
    setKey: (params) => serialized(() => setAccountKey(parts, params)),
    remove: (id) => serialized(() => removeAccount(parts, deps.isInUse, id)),
    move: (id, direction) =>
      serialized(() => moveAccount(repository, id, direction)),
  };
}
