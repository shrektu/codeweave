import { SWITCH_LOG_SNAPSHOT_LIMIT } from "../shared/constants";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import { createAccountsService } from "./accountsService";
import type { ConnectionRegistry } from "./connections";
import type { IpcHandlers } from "./ipcServer";
import { createSettingsService } from "./settingsService";
import type { JsonStore } from "./storage";

export interface HandlerDeps {
  store: JsonStore;
  userData: string;
  broadcast: ConnectionRegistry["broadcast"];
}

function sessionsUnavailable(): never {
  throw new IpcError(
    IpcErrorCode.UNAVAILABLE,
    "Sessions are not available yet",
  );
}

export function createHandlers({
  store,
  userData,
  broadcast,
}: HandlerDeps): IpcHandlers {
  const accounts = createAccountsService({
    store,
    userData,
    broadcast,
    runtimeOf: () => ({ status: "ready" }),
    isInUse: () => false,
  });
  const settings = createSettingsService({ store, broadcast });
  return {
    ping: () => ({ pong: true, backendPid: process.pid }),
    "sessions/snapshot": async () => ({
      session: null,
      accounts: (await accounts.list()).accounts,
      settings: await settings.get(),
      switchLog: await store.readSwitchLog(SWITCH_LOG_SNAPSHOT_LIMIT),
      container: { available: true, message: null },
    }),
    "session/start": sessionsUnavailable,
    "session/prompt": sessionsUnavailable,
    "session/stop": sessionsUnavailable,
    "permission/answer": sessionsUnavailable,
    "accounts/list": () => accounts.list(),
    "accounts/suggest": () => accounts.suggest(),
    "accounts/add": (params) => accounts.add(params),
    "accounts/remove": ({ id }) => accounts.remove(id),
    "accounts/move": ({ id, direction }) => accounts.move(id, direction),
    "settings/get": () => settings.get(),
    "settings/set": (patch) => settings.set(patch),
    "switchLog/list": async () => ({
      entries: await store.readSwitchLog(SWITCH_LOG_SNAPSHOT_LIMIT),
    }),
  };
}
