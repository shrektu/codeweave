import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { isBelowRoot } from "../../domain/pathScope";
import {
  readFileSnapshot,
  SnapshotKind,
  type FileSnapshot,
} from "../fileSnapshot";

import {
  SNAPSHOT_CONVERSATION_ID_PATTERN,
  SNAPSHOT_RECORD_EXTENSION,
  SNAPSHOT_RECORD_SEPARATOR,
  SNAPSHOT_STEP_INDEX_PATTERN,
} from "./constants";
import { parseJson } from "./protocol";

const MISSING_ERRNO_CODE = "ENOENT";

const FileSnapshotSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal(SnapshotKind.missing) }),
  z.strictObject({ kind: z.literal(SnapshotKind.text), text: z.string() }),
  z.strictObject({ kind: z.literal(SnapshotKind.binary) }),
  z.strictObject({ kind: z.literal(SnapshotKind.tooLarge) }),
]);

const StepSnapshotRecordSchema = z.strictObject({
  entries: z.array(
    z.strictObject({ path: z.string(), snapshot: FileSnapshotSchema }),
  ),
});
export type StepSnapshotRecord = z.infer<typeof StepSnapshotRecordSchema>;

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === MISSING_ERRNO_CODE
  );
}

export function recordName(
  conversationId: string,
  stepIdx: number,
): string | null {
  return SNAPSHOT_CONVERSATION_ID_PATTERN.test(conversationId)
    ? `${conversationId}${SNAPSHOT_RECORD_SEPARATOR}${String(stepIdx)}${SNAPSHOT_RECORD_EXTENSION}`
    : null;
}

async function existsOnDisk(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function realLocation(path: string): Promise<string> {
  if (await existsOnDisk(path)) {
    return realpath(path);
  }
  const parent = dirname(path);
  return parent === path
    ? path
    : join(await realLocation(parent), basename(path));
}

async function isConfined(
  path: string,
  worktreeRoot: string,
  realRoot: string,
): Promise<boolean> {
  if (!isBelowRoot(path, worktreeRoot)) {
    return false;
  }
  try {
    return isBelowRoot(await realLocation(path), realRoot);
  } catch (error) {
    console.error("agy diff snapshot skipped a path", error);
    return false;
  }
}

export async function snapshotTargets(
  paths: readonly string[],
  worktreeRoot: string,
): Promise<string[]> {
  const realRoot = await realpath(worktreeRoot);
  const confined = await Promise.all(
    paths.map((path) => isConfined(path, worktreeRoot, realRoot)),
  );
  return paths.filter((_path, index) => confined[index] === true);
}

export interface StepSnapshotRequest {
  readonly dir: string;
  readonly conversationId: string;
  readonly stepIdx: number;
  readonly paths: readonly string[];
  readonly worktreeRoot: string;
}

export async function writeStepSnapshot(
  request: StepSnapshotRequest,
): Promise<void> {
  const name = recordName(request.conversationId, request.stepIdx);
  if (name === null) {
    return;
  }
  const targets = await snapshotTargets(request.paths, request.worktreeRoot);
  const entries = await Promise.all(
    targets.map(async (path) => ({
      path,
      snapshot: await readFileSnapshot(path),
    })),
  );
  if (entries.length === 0) {
    return;
  }
  const record: StepSnapshotRecord = { entries };
  await writeFile(join(request.dir, name), JSON.stringify(record));
}

async function readRecord(file: string): Promise<StepSnapshotRecord | null> {
  try {
    const parsed = StepSnapshotRecordSchema.safeParse(
      parseJson(await readFile(file, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (!isMissingError(error)) {
      console.error("agy diff snapshot unreadable", error);
    }
    return null;
  }
}

export async function takeStepSnapshot(
  dir: string,
  conversationId: string,
  stepIdx: number,
): Promise<StepSnapshotRecord | null> {
  const name = recordName(conversationId, stepIdx);
  if (name === null) {
    return null;
  }
  const file = join(dir, name);
  try {
    return await readRecord(file);
  } finally {
    await rm(file, { force: true });
  }
}

function indexOfRecord(name: string, conversationId: string): number | null {
  const prefix = `${conversationId}${SNAPSHOT_RECORD_SEPARATOR}`;
  if (!name.startsWith(prefix) || !name.endsWith(SNAPSHOT_RECORD_EXTENSION)) {
    return null;
  }
  const raw = name.slice(prefix.length, -SNAPSHOT_RECORD_EXTENSION.length);
  return SNAPSHOT_STEP_INDEX_PATTERN.test(raw) ? Number(raw) : null;
}

async function recordNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissingError(error)) {
      return [];
    }
    throw error;
  }
}

export async function laterSnapshotOf(
  dir: string,
  conversationId: string,
  stepIdx: number,
  path: string,
): Promise<FileSnapshot | null> {
  if (!SNAPSHOT_CONVERSATION_ID_PATTERN.test(conversationId)) {
    return null;
  }
  const later = (await recordNames(dir))
    .map((name) => ({ name, index: indexOfRecord(name, conversationId) }))
    .filter(
      (candidate): candidate is { name: string; index: number } =>
        candidate.index !== null && candidate.index > stepIdx,
    )
    .toSorted((left, right) => left.index - right.index);
  for (const { name } of later) {
    const record = await readRecord(join(dir, name));
    const entry = record?.entries.find((candidate) => candidate.path === path);
    if (entry !== undefined) {
      return entry.snapshot;
    }
  }
  return null;
}

export async function discardStepSnapshot(
  dir: string,
  conversationId: string,
  stepIdx: number,
): Promise<void> {
  const name = recordName(conversationId, stepIdx);
  if (name !== null) {
    await rm(join(dir, name), { force: true });
  }
}

export async function clearSnapshots(dir: string): Promise<void> {
  const records = (await recordNames(dir)).filter((name) =>
    name.endsWith(SNAPSHOT_RECORD_EXTENSION),
  );
  await Promise.all(
    records.map((name) => rm(join(dir, name), { force: true })),
  );
}
