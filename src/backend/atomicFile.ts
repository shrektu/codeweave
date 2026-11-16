import { randomUUID } from "node:crypto";
import { chmod, rename, rm, stat, writeFile } from "node:fs/promises";

const TEMP_SUFFIX = ".tmp";
const PERMISSION_MASK = 0o7777;

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
