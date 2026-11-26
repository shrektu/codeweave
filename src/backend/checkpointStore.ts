import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  OVERWRITABLE_SKIP_REASONS,
  RestoreAction,
  RestoreSkipReason,
} from "../domain/checkpoints";
import { DiffOmission, FileChange } from "../domain/events";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type {
  FileDiffView,
  RestorePlanView,
  RestoreReportView,
} from "../shared/views";

import { replaceFileAtomically } from "./atomicFile";
import {
  planRestore,
  reverseApply,
  rewindTargets,
  CheckpointEntrySchema,
  type BlobRef,
  type CheckpointEntry,
} from "./checkpointPlan";
import {
  CHECKPOINT_BLOBS_DIR,
  CHECKPOINT_INDEX_FILE,
  STORAGE_VERSION,
} from "./constants";
import {
  isMissingError,
  readFileSnapshot,
  SnapshotKind,
  type FileSnapshot,
} from "./fileSnapshot";
import { isInside } from "./flows";
import { KeyedMutex } from "./keyedMutex";
import { realLocation } from "./permissionScope";
import { readValidated, StorageCorruptError, writeAtomic } from "./storage";
import { SESSION_ID_SCHEMA } from "./sessionHistory";

const INVALID_SESSION_ID_MESSAGE = "Invalid session id";
const JSON_INDENT = 2;
const HASH_ALGORITHM = "sha256";
const EMPTY_TEXT = "";

const CheckpointIndexSchema = z.strictObject({
  version: z.literal(STORAGE_VERSION),
  nextOrder: z.int(),
  entries: z.array(CheckpointEntrySchema),
});
type CheckpointIndex = z.infer<typeof CheckpointIndexSchema>;

export interface CheckpointStoreDeps {
  readonly dir: string;
  readonly maxSessionBytes: number;
  readonly protectedPaths: () => Promise<readonly string[]>;
}

export interface CheckpointEdit {
  readonly editKey: string;
  readonly promptSeq: number;
  readonly diff: FileDiffView;
  readonly after: Promise<FileSnapshot>;
}

export interface CheckpointStore {
  record(sessionId: string, edit: CheckpointEdit): Promise<void>;
  entries(sessionId: string): Promise<readonly CheckpointEntry[]>;
  plan(sessionId: string, promptSeq: number): Promise<RestorePlanView>;
  restore(
    sessionId: string,
    promptSeq: number,
    overwrite: readonly string[],
  ): Promise<RestoreReportView>;
  fold(sessionId: string, promptSeq: number, intoSeq: number): Promise<void>;
  flush(): Promise<void>;
}

function emptyIndex(): CheckpointIndex {
  return { version: STORAGE_VERSION, nextOrder: 0, entries: [] };
}

function hashText(text: string): string {
  return createHash(HASH_ALGORITHM).update(text, "utf8").digest("hex");
}

function unknownReasonOf(
  kind: typeof SnapshotKind.binary | typeof SnapshotKind.tooLarge,
): RestoreSkipReason {
  return kind === SnapshotKind.binary
    ? RestoreSkipReason.binary
    : RestoreSkipReason.tooLarge;
}

function omissionReason(omitted: DiffOmission): RestoreSkipReason {
  if (omitted === DiffOmission.binary) {
    return RestoreSkipReason.binary;
  }
  return omitted === DiffOmission.tooLarge
    ? RestoreSkipReason.tooLarge
    : RestoreSkipReason.notReported;
}

function evictedRef(): BlobRef {
  return { kind: "unknown", reason: RestoreSkipReason.evicted };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function readIndex(sessionDir: string): Promise<CheckpointIndex> {
  const file = join(sessionDir, CHECKPOINT_INDEX_FILE);
  try {
    const stored = await readValidated(file, CheckpointIndexSchema);
    return stored ?? emptyIndex();
  } catch (error) {
    if (error instanceof StorageCorruptError) {
      console.error(`the checkpoint index of ${sessionDir} is corrupt`, error);
      return emptyIndex();
    }
    throw error;
  }
}

async function writeIndex(
  sessionDir: string,
  index: CheckpointIndex,
): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  await writeAtomic(
    join(sessionDir, CHECKPOINT_INDEX_FILE),
    JSON.stringify(index, null, JSON_INDENT),
  );
}

async function storeText(sessionDir: string, text: string): Promise<BlobRef> {
  const hash = hashText(text);
  const blobsDir = join(sessionDir, CHECKPOINT_BLOBS_DIR);
  await mkdir(blobsDir, { recursive: true });
  const file = join(blobsDir, hash);
  if (!(await fileExists(file))) {
    await writeAtomic(file, text);
  }
  return { kind: "stored", hash, bytes: Buffer.byteLength(text, "utf8") };
}

async function storeSnapshot(
  sessionDir: string,
  snapshot: FileSnapshot,
): Promise<BlobRef> {
  if (snapshot.kind === SnapshotKind.text) {
    return storeText(sessionDir, snapshot.text);
  }
  if (snapshot.kind === SnapshotKind.missing) {
    return { kind: "missing" };
  }
  return { kind: "unknown", reason: unknownReasonOf(snapshot.kind) };
}

function currentRefOf(snapshot: FileSnapshot): BlobRef {
  if (snapshot.kind === SnapshotKind.text) {
    return {
      kind: "stored",
      hash: hashText(snapshot.text),
      bytes: Buffer.byteLength(snapshot.text, "utf8"),
    };
  }
  if (snapshot.kind === SnapshotKind.missing) {
    return { kind: "missing" };
  }
  return { kind: "unknown", reason: unknownReasonOf(snapshot.kind) };
}

function latestEntryFor(
  entries: readonly CheckpointEntry[],
  path: string,
): CheckpointEntry | null {
  let latest: CheckpointEntry | null = null;
  for (const entry of entries) {
    if (entry.path !== path) {
      continue;
    }
    if (latest === null || entry.order > latest.order) {
      latest = entry;
    }
  }
  return latest;
}

async function computeBefore(
  sessionDir: string,
  edit: CheckpointEdit,
  afterSnapshot: FileSnapshot,
  entries: readonly CheckpointEntry[],
): Promise<BlobRef> {
  if (edit.diff.change === FileChange.created) {
    return { kind: "missing" };
  }
  if ("patch" in edit.diff) {
    const afterText =
      afterSnapshot.kind === SnapshotKind.text
        ? afterSnapshot.text
        : EMPTY_TEXT;
    const beforeText = reverseApply(edit.diff.patch, afterText);
    if (beforeText !== null) {
      return storeText(sessionDir, beforeText);
    }
  }
  const latest = latestEntryFor(entries, edit.diff.path);
  if (latest !== null && latest.after.kind !== "unknown") {
    return latest.after;
  }
  return {
    kind: "unknown",
    reason:
      "omitted" in edit.diff
        ? omissionReason(edit.diff.omitted)
        : RestoreSkipReason.patchMismatch,
  };
}

function referencedBytes(entries: readonly CheckpointEntry[]): number {
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    for (const ref of [entry.before, entry.after]) {
      if (ref.kind === "stored") {
        sizes.set(ref.hash, ref.bytes);
      }
    }
  }
  let total = 0;
  for (const bytes of sizes.values()) {
    total += bytes;
  }
  return total;
}

function evictOldest(
  entries: readonly CheckpointEntry[],
  maxSessionBytes: number,
): CheckpointEntry[] {
  let current = [...entries];
  const promptSeqs = [
    ...new Set(current.map((entry) => entry.promptSeq)),
  ].toSorted((a, b) => a - b);
  for (const promptSeq of promptSeqs.slice(0, -1)) {
    if (referencedBytes(current) <= maxSessionBytes) {
      break;
    }
    current = current.map((entry) =>
      entry.promptSeq === promptSeq
        ? { ...entry, before: evictedRef(), after: evictedRef() }
        : entry,
    );
  }
  return current;
}

async function collectGarbage(
  sessionDir: string,
  entries: readonly CheckpointEntry[],
): Promise<void> {
  const blobsDir = join(sessionDir, CHECKPOINT_BLOBS_DIR);
  const names = await readdir(blobsDir).catch((error: unknown) => {
    if (isMissingError(error)) {
      return [];
    }
    throw error;
  });
  const referenced = new Set<string>();
  for (const entry of entries) {
    for (const ref of [entry.before, entry.after]) {
      if (ref.kind === "stored") {
        referenced.add(ref.hash);
      }
    }
  }
  await Promise.all(
    names
      .filter((name) => !referenced.has(name))
      .map((name) => rm(join(blobsDir, name), { force: true })),
  );
}

async function readBlobText(sessionDir: string, hash: string): Promise<string> {
  return readFile(join(sessionDir, CHECKPOINT_BLOBS_DIR, hash), "utf8");
}

type SettledSnapshot =
  | { readonly ok: true; readonly snapshot: FileSnapshot }
  | { readonly ok: false; readonly error: unknown };

function settleAfter(after: Promise<FileSnapshot>): Promise<SettledSnapshot> {
  return after
    .then((snapshot): SettledSnapshot => ({ ok: true, snapshot }))
    .catch((error: unknown): SettledSnapshot => ({ ok: false, error }));
}

async function recordStep(
  sessionDir: string,
  edit: CheckpointEdit,
  settledAfter: Promise<SettledSnapshot>,
  maxSessionBytes: number,
): Promise<void> {
  const index = await readIndex(sessionDir);
  if (index.entries.some((entry) => entry.editKey === edit.editKey)) {
    return;
  }
  const settled = await settledAfter;
  if (!settled.ok) {
    console.error(
      "a file checkpoint snapshot could not be read",
      settled.error,
    );
    return;
  }
  const afterSnapshot = settled.snapshot;
  const after = await storeSnapshot(sessionDir, afterSnapshot);
  const before = await computeBefore(
    sessionDir,
    edit,
    afterSnapshot,
    index.entries,
  );
  const entry: CheckpointEntry = {
    editKey: edit.editKey,
    promptSeq: edit.promptSeq,
    path: edit.diff.path,
    before,
    after,
    order: index.nextOrder,
  };
  const entries = [...index.entries, entry];
  const evicted = evictOldest(entries, maxSessionBytes);
  await writeIndex(sessionDir, {
    version: STORAGE_VERSION,
    nextOrder: index.nextOrder + 1,
    entries: evicted,
  });
  await collectGarbage(sessionDir, evicted);
}

function candidatePaths(
  entries: readonly CheckpointEntry[],
  promptSeq: number,
): readonly string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.promptSeq >= promptSeq)
        .map((entry) => entry.path),
    ),
  ];
}

async function currentRefs(
  paths: readonly string[],
): Promise<ReadonlyMap<string, BlobRef>> {
  const refs = new Map<string, BlobRef>();
  await Promise.all(
    paths.map(async (path) => {
      refs.set(path, currentRefOf(await readFileSnapshot(path)));
    }),
  );
  return refs;
}

function isProtectedBy(roots: readonly string[], path: string): boolean {
  return roots.some((root) => root === path || isInside(root, path));
}

async function canonicalRoots(
  protectedPaths: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const roots = await protectedPaths();
  const canonical = await Promise.all(roots.map((root) => realLocation(root)));
  return [...new Set([...roots, ...canonical])];
}

async function protectedChecker(
  protectedPaths: () => Promise<readonly string[]>,
  paths: readonly string[],
): Promise<(path: string) => boolean> {
  const roots = await canonicalRoots(protectedPaths);
  const redirected = new Set<string>();
  for (const path of paths) {
    if (isProtectedBy(roots, path)) {
      continue;
    }
    const resolved = await realLocation(path);
    if (isProtectedBy(roots, resolved)) {
      redirected.add(path);
    }
  }
  return (path) => isProtectedBy(roots, path) || redirected.has(path);
}

async function resolveExistingPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
}

async function applyAction(
  sessionDir: string,
  path: string,
  action: RestoreAction,
  target: BlobRef | undefined,
): Promise<void> {
  if (action === RestoreAction.delete) {
    await rm(path, { force: true });
    return;
  }
  if (target?.kind !== "stored") {
    throw new IpcError(
      IpcErrorCode.INTERNAL,
      `Checkpoint content for ${path} is missing`,
    );
  }
  const text = await readBlobText(sessionDir, target.hash);
  const existing = await resolveExistingPath(path);
  if (existing !== null) {
    await replaceFileAtomically(existing, text);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, text);
}

interface RestoreStepInput {
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly promptSeq: number;
  readonly overwrite: readonly string[];
  readonly protectedPaths: () => Promise<readonly string[]>;
}

async function restoreStep(
  input: RestoreStepInput,
): Promise<RestoreReportView> {
  const { sessionDir, sessionId, promptSeq, overwrite } = input;
  const index = await readIndex(sessionDir);
  const paths = candidatePaths(index.entries, promptSeq);
  const plan = planRestore({
    sessionId,
    promptSeq,
    entries: index.entries,
    current: await currentRefs(paths),
    isProtected: await protectedChecker(input.protectedPaths, paths),
  });
  const targets = rewindTargets(index.entries, promptSeq);
  const overwritePaths = new Set(overwrite);
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: { path: string; reason: RestoreSkipReason }[] = [];
  for (const file of plan.files) {
    const overwritten =
      file.skip !== null &&
      OVERWRITABLE_SKIP_REASONS.includes(file.skip) &&
      overwritePaths.has(file.path);
    if (file.skip !== null && !overwritten) {
      skipped.push({ path: file.path, reason: file.skip });
      continue;
    }
    if (file.action === RestoreAction.none) {
      continue;
    }
    await applyAction(
      sessionDir,
      file.path,
      file.action,
      targets.get(file.path),
    );
    if (file.action === RestoreAction.write) {
      restored.push(file.path);
    } else {
      deleted.push(file.path);
    }
  }
  const remaining = index.entries.filter(
    (entry) => entry.promptSeq < promptSeq,
  );
  await writeIndex(sessionDir, { ...index, entries: remaining });
  await collectGarbage(sessionDir, remaining);
  return { restored, deleted, skipped };
}

async function foldStep(
  sessionDir: string,
  promptSeq: number,
  intoSeq: number,
): Promise<void> {
  const index = await readIndex(sessionDir);
  if (index.entries.every((entry) => entry.promptSeq < promptSeq)) {
    return;
  }
  const entries = index.entries.map((entry) =>
    entry.promptSeq >= promptSeq ? { ...entry, promptSeq: intoSeq } : entry,
  );
  await writeIndex(sessionDir, { ...index, entries });
}

async function planStep(
  sessionDir: string,
  sessionId: string,
  promptSeq: number,
  protectedPaths: () => Promise<readonly string[]>,
): Promise<RestorePlanView> {
  const index = await readIndex(sessionDir);
  const paths = candidatePaths(index.entries, promptSeq);
  return planRestore({
    sessionId,
    promptSeq,
    entries: index.entries,
    current: await currentRefs(paths),
    isProtected: await protectedChecker(protectedPaths, paths),
  });
}

export function createCheckpointStore(
  deps: CheckpointStoreDeps,
): CheckpointStore {
  const mutex = new KeyedMutex();
  const active = new Set<Promise<unknown>>();

  function track<T>(task: Promise<T>): Promise<T> {
    active.add(task);
    const done = (): void => {
      active.delete(task);
    };
    void task.then(done).catch(done);
    return task;
  }

  function sessionDirOf(sessionId: string): string {
    if (!SESSION_ID_SCHEMA.safeParse(sessionId).success) {
      throw new IpcError(IpcErrorCode.VALIDATION, INVALID_SESSION_ID_MESSAGE);
    }
    return join(deps.dir, sessionId);
  }

  async function run<T>(
    sessionId: string,
    task: (sessionDir: string) => Promise<T>,
  ): Promise<T> {
    const sessionDir = sessionDirOf(sessionId);
    return track(mutex.run(sessionId, () => task(sessionDir)));
  }

  return {
    record: (sessionId, edit) => {
      const settled = settleAfter(edit.after);
      return run(sessionId, (sessionDir) =>
        recordStep(sessionDir, edit, settled, deps.maxSessionBytes),
      );
    },
    entries: (sessionId) =>
      run(
        sessionId,
        async (sessionDir) => (await readIndex(sessionDir)).entries,
      ),
    plan: (sessionId, promptSeq) =>
      run(sessionId, (sessionDir) =>
        planStep(sessionDir, sessionId, promptSeq, deps.protectedPaths),
      ),
    restore: (sessionId, promptSeq, overwrite) =>
      run(sessionId, (sessionDir) =>
        restoreStep({
          sessionDir,
          sessionId,
          promptSeq,
          overwrite,
          protectedPaths: deps.protectedPaths,
        }),
      ),
    fold: (sessionId, promptSeq, intoSeq) =>
      run(sessionId, (sessionDir) => foldStep(sessionDir, promptSeq, intoSeq)),
    async flush(): Promise<void> {
      while (active.size > 0) {
        await Promise.allSettled([...active]);
      }
    },
  };
}
