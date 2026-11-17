import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

const TEMP_SUFFIX = ".tmp";
const PERMISSION_MASK = 0o7777;
const LINK_UNSUPPORTED: ReadonlySet<unknown> = new Set([
  "EPERM",
  "ENOTSUP",
  "EXDEV",
  "EISDIR",
]);

function isLinkUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    LINK_UNSUPPORTED.has(error.code)
  );
}

async function reserveAndRename(temp: string, target: string): Promise<void> {
  const handle = await open(target, "wx");
  try {
    await handle.close();
    await rename(temp, target);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

export async function createFileExclusively(
  target: string,
  text: string,
): Promise<void> {
  const temp = `${target}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    await writeFile(temp, text);
    try {
      await link(temp, target);
    } catch (error) {
      if (!isLinkUnsupported(error)) {
        throw error;
      }
      await reserveAndRename(temp, target);
    }
  } finally {
    await rm(temp, { force: true });
  }
}

export async function replaceFileAtomically(
  target: string,
  text: string,
): Promise<void> {
  const { mode } = await stat(target);
  const temp = `${target}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    await writeFile(temp, text);
    if (process.platform !== "win32") {
      await chmod(temp, mode & PERMISSION_MASK);
    }
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
