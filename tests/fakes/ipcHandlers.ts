import type { IpcHandlers } from "../../src/backend/ipcServer";
import { IpcError, IpcErrorCode } from "../../src/shared/protocol";

function unavailable(): never {
  throw new IpcError(IpcErrorCode.UNAVAILABLE, "Not available in this test");
}

export function fakeHandlers(
  overrides: Partial<IpcHandlers> = {},
): IpcHandlers {
  return {
    ping: () => ({ pong: true, backendPid: process.pid }),
    "sessions/snapshot": unavailable,
    "session/start": unavailable,
    "session/prompt": unavailable,
    "session/stop": unavailable,
    "permission/answer": unavailable,
    "accounts/list": unavailable,
    "accounts/suggest": unavailable,
    "accounts/add": unavailable,
    "accounts/setKey": unavailable,
    "vault/status": unavailable,
    "models/catalog": unavailable,
    "accounts/remove": unavailable,
    "accounts/move": unavailable,
    "settings/get": unavailable,
    "settings/set": unavailable,
    "switchLog/list": unavailable,
    "flows/list": unavailable,
    ...overrides,
  };
}
