import { IpcError, IpcErrorCode } from "../shared/protocol";

import { isDirectoryOrThrow } from "./directory";

const DEFAULT_WORKSPACE_MISSING_PREFIX = "Default workspace does not exist: ";
const DEFAULT_WORKSPACE_INACCESSIBLE_PREFIX =
  "Default workspace is not accessible: ";

export interface WorkspaceSettings {
  readonly defaultWorkspace: string | null;
}

function validationError(prefix: string, path: string): IpcError {
  return new IpcError(IpcErrorCode.VALIDATION, `${prefix}${path}`);
}

function directoryExists(path: string): boolean {
  try {
    return isDirectoryOrThrow(path);
  } catch (error: unknown) {
    console.warn(`default workspace could not be inspected: ${path}`, error);
    throw validationError(DEFAULT_WORKSPACE_INACCESSIBLE_PREFIX, path);
  }
}

function resolveFallback(fallback: string): string {
  if (!directoryExists(fallback)) {
    throw validationError(DEFAULT_WORKSPACE_MISSING_PREFIX, fallback);
  }
  return fallback;
}

export function resolveSessionFolder(
  requested: string | undefined,
  settings: WorkspaceSettings,
  homeDir: string,
): Promise<string> {
  return new Promise((resolve) => {
    resolve(requested ?? resolveFallback(settings.defaultWorkspace ?? homeDir));
  });
}
