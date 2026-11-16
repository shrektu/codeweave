import { IpcErrorCode } from "../shared/protocol";

import { IpcRemoteError } from "./ipc";

export async function requestUnlessConflict<T>(
  request: () => Promise<T>,
  onConflict: () => void,
): Promise<T | null> {
  try {
    return await request();
  } catch (error: unknown) {
    if (
      error instanceof IpcRemoteError &&
      error.code === IpcErrorCode.CONFLICT
    ) {
      onConflict();
      return null;
    }
    throw error;
  }
}
