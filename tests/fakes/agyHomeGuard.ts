import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const ISOLATED_DBUS_ADDRESS = "unix:path=/nonexistent";

const REAL_AGY_DIR = ".gemini";
const LOOPBACK_HOSTNAME = "127.0.0.1";
const PARENT_SEGMENT = "..";
const NOT_FOUND_CODE = "ENOENT";

export interface AgyEnvIsolation {
  readonly home: string;
  readonly geminiDir: string;
  readonly baseUrl: string;
  readonly dbusAddress: string;
  readonly xdgDirs: Readonly<Record<string, string>>;
}

function resolveReal(path: string): string {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(realpathSync(existing), ...missing.toReversed());
    } catch (error) {
      const parent = dirname(existing);
      const notFound =
        error instanceof Error &&
        "code" in error &&
        error.code === NOT_FOUND_CODE;
      if (!notFound || parent === existing) {
        throw error;
      }
      missing.push(relative(parent, existing));
      existing = parent;
    }
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

function assertDirectoryIsolated(label: string, directory: string): void {
  const real = resolveReal(directory);
  if (isInside(real, resolveReal(join(homedir(), REAL_AGY_DIR)))) {
    throw new Error(`Refusing to use the real agy directory: ${real}`);
  }
  if (!isInside(real, resolveReal(tmpdir()))) {
    throw new Error(
      `The agy ${label} must be in the temporary directory: ${real}`,
    );
  }
}

export function assertIsolatedAgyEnv(isolation: AgyEnvIsolation): void {
  assertDirectoryIsolated("home", isolation.home);
  assertDirectoryIsolated("gemini directory", isolation.geminiDir);
  for (const [name, directory] of Object.entries(isolation.xdgDirs)) {
    assertDirectoryIsolated(name, directory);
  }
  if (new URL(isolation.baseUrl).hostname !== LOOPBACK_HOSTNAME) {
    throw new Error(`The agy base URL must point at ${LOOPBACK_HOSTNAME}`);
  }
  if (isolation.dbusAddress !== ISOLATED_DBUS_ADDRESS) {
    throw new Error(
      `The agy D-Bus address must be ${ISOLATED_DBUS_ADDRESS} so the real keyring stays untouched`,
    );
  }
}
