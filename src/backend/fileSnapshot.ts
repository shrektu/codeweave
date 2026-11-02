import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { DIFF_MAX_FILE_BYTES } from "./constants";

export const SnapshotKind = {
  missing: "missing",
  text: "text",
  binary: "binary",
  tooLarge: "too_large",
} as const;
export type SnapshotKind = (typeof SnapshotKind)[keyof typeof SnapshotKind];

export type FileSnapshot =
  | { readonly kind: typeof SnapshotKind.missing }
  | { readonly kind: typeof SnapshotKind.text; readonly text: string }
  | { readonly kind: typeof SnapshotKind.binary }
  | { readonly kind: typeof SnapshotKind.tooLarge };

const MISSING_ERRNO_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];
const NUL_BYTE = 0;
const READ_LIMIT_BYTES = DIFF_MAX_FILE_BYTES + 1;
const READ_BUFFER_OFFSET = 0;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    MISSING_ERRNO_CODES.includes(error.code)
  );
}

async function openOrUndefined(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, OPEN_FLAGS);
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readLimited(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(READ_LIMIT_BYTES);
  let total = READ_BUFFER_OFFSET;
  while (total < READ_LIMIT_BYTES) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      READ_LIMIT_BYTES - total,
      total,
    );
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
  }
  return buffer.subarray(READ_BUFFER_OFFSET, total);
}

function classify(bytes: Buffer): FileSnapshot {
  if (bytes.length > DIFF_MAX_FILE_BYTES) {
    return { kind: SnapshotKind.tooLarge };
  }
  if (bytes.includes(NUL_BYTE) || !isUtf8(bytes)) {
    return { kind: SnapshotKind.binary };
  }
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { kind: SnapshotKind.text, text };
}

async function snapshotOf(handle: FileHandle): Promise<FileSnapshot> {
  const stats = await handle.stat();
  if (!stats.isFile()) {
    return { kind: SnapshotKind.binary };
  }
  if (stats.size > DIFF_MAX_FILE_BYTES) {
    return { kind: SnapshotKind.tooLarge };
  }
  return classify(await readLimited(handle));
}

export async function readFileSnapshot(path: string): Promise<FileSnapshot> {
  const handle = await openOrUndefined(path);
  if (handle === undefined) {
    return { kind: SnapshotKind.missing };
  }
  try {
    return await snapshotOf(handle);
  } finally {
    await handle.close();
  }
}
