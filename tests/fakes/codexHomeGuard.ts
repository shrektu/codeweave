import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_CODEX_DIR = ".codex";
const LOCAL_HOSTNAME = "127.0.0.1";
const PARENT_SEGMENT = "..";
const NOT_FOUND_CODE = "ENOENT";

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === NOT_FOUND_CODE
  );
}

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (!isNotFound(error) || parent === path) {
      throw error;
    }
    return join(resolveReal(parent), basename(path));
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== PARENT_SEGMENT &&
      !rel.startsWith(`${PARENT_SEGMENT}${sep}`) &&
      !isAbsolute(rel))
  );
}

export function assertIsolatedCodexHome(home: string, baseUrl: string): void {
  const real = resolveReal(home);
  const defaultHome = resolveReal(join(homedir(), DEFAULT_CODEX_DIR));
  if (isInside(real, defaultHome)) {
    throw new Error(`Refusing to use the real codex home: ${real}`);
  }
  if (!isInside(real, resolveReal(tmpdir()))) {
    throw new Error(`Codex home must be in the temporary directory: ${real}`);
  }
  const { hostname } = new URL(baseUrl);
  if (hostname !== LOCAL_HOSTNAME) {
    throw new Error(`Codex base URL must point at ${LOCAL_HOSTNAME}`);
  }
}
