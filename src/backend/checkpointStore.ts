import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  sameRef,
  type BlobRef,
  type CheckpointEntry,
} from "./checkpointPlan";
import {
  CHECKPOINT_BLOBS_DIR,
  CHECKPOINT_INDEX_FILE,
  STORAGE_VERSION,
} from "./constants";
import {
  readFileSnapshot,
  SnapshotKind,
  type FileSnapshot,
} from "./fileSnapshot";
import { isInside } from "./flows";
import { KeyedMutex } from "./keyedMutex";
import { readValidated, StorageCorruptError, writeAtomic } from "./storage";

const SESSION_ID_SCHEMA = z.uuid();
const INVALID_SESSION_ID_MESSAGE = "Invalid session id";
const JSON_INDENT = 2;
const HASH_ALGORITHM = "sha256";
const MISSING_FILE_CODE = "ENOENT";
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
  flush(): Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === MISSING_FILE_CODE
  );
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
    if (isMissingFile(error)) {
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
    if (isMissingFile(error)) {
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

async function reverseRef(
  sessionDir: string,
  patch: string | null | undefined,
  after: BlobRef,
): Promise<BlobRef | null> {
  if (patch === null || patch === undefined || after.kind === "unknown") {
    return null;
  }
  const afterText =
    after.kind === "stored"
      ? await readBlobText(sessionDir, after.hash)
      : EMPTY_TEXT;
  const beforeText = reverseApply(patch, afterText);
  return beforeText === null ? null : storeText(sessionDir, beforeText);
}

async function repairedBefore(
  sessionDir: string,
  entry: CheckpointEntry,
  after: BlobRef,
  earlier: CheckpointEntry | undefined,
): Promise<BlobRef> {
  const reversed = await reverseRef(sessionDir, entry.patch, after);
  if (reversed !== null) {
    return reversed;
  }
  if (earlier !== undefined && earlier.after.kind !== "unknown") {
    return earlier.after;
  }
  return { kind: "unknown", reason: RestoreSkipReason.patchMismatch };
}

function replaceEntry(
  entries: CheckpointEntry[],
  replacement: CheckpointEntry,
): void {
  const index = entries.findIndex(
    (entry) => entry.editKey === replacement.editKey,
  );
  if (index !== -1) {
    entries[index] = replacement;
  }
}

async function repairEarlierEntries(
  sessionDir: string,
  entries: CheckpointEntry[],
  path: string,
  newBefore: BlobRef,
  recordedAfter: BlobRef,
): Promise<void> {
  if (newBefore.kind !== "stored") {
    return;
  }
  const ordered = entries
    .filter((entry) => entry.path === path)
    .toSorted((a, b) => a.order - b.order);
  let after: BlobRef = newBefore;
  let originalAfter: BlobRef = recordedAfter;
  for (let position = ordered.length - 1; position >= 0; position -= 1) {
    const entry = ordered[position];
    if (
      entry?.after.kind !== "stored" ||
      !sameRef(entry.after, originalAfter) ||
      sameRef(entry.after, after)
    ) {
      break;
    }
    const recordedBefore = entry.before;
    const original = entry.after;
    const before = await repairedBefore(
      sessionDir,
      entry,
      after,
      ordered[position - 1],
    );
    const replacement = { ...entry, after, before };
    replaceEntry(entries, replacement);
    ordered[position] = replacement;
    originalAfter = original;
    if (sameRef(before, recordedBefore)) {
      break;
    }
    after = before;
  }
}

async function recordStep(
  sessionDir: string,
  edit: CheckpointEdit,
  maxSessionBytes: number,
): Promise<void> {
  const index = await readIndex(sessionDir);
  if (index.entries.some((entry) => entry.editKey === edit.editKey)) {
    return;
  }
  const afterSnapshot = await readFileSnapshot(edit.diff.path);
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
    patch: "patch" in edit.diff ? edit.diff.patch : null,
  };
  const entries = [...index.entries];
  await repairEarlierEntries(
    sessionDir,
    entries,
    edit.diff.path,
    before,
    after,
  );
  entries.push(entry);
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

async function resolveMissingTarget(path: string): Promise<string | null> {
  let current = path;
  const missing: string[] = [];
  let parent = dirname(current);
  while (parent !== current) {
    missing.unshift(basename(current));
    const resolved = await resolveExistingPath(parent);
    if (resolved !== null) {
      return join(resolved, ...missing);
    }
    current = parent;
    parent = dirname(current);
  }
  return null;
}

async function resolveForProtection(path: string): Promise<string | null> {
  const resolved = await resolveExistingPath(path);
  return resolved ?? resolveMissingTarget(path);
}

async function protectedChecker(
  protectedPaths: () => Promise<readonly string[]>,
  paths: readonly string[],
): Promise<(path: string) => boolean> {
  const roots = await protectedPaths();
  const redirected = new Set<string>();
  for (const path of paths) {
    if (isProtectedBy(roots, path)) {
      continue;
    }
    const resolved = await resolveForProtection(path);
    if (resolved !== null && isProtectedBy(roots, resolved)) {
      redirected.add(path);
    }
  }
  return (path) => isProtectedBy(roots, path) || redirected.has(path);
}

async function resolveExistingPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingFile(error)) {
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
    record: (sessionId, edit) =>
      run(sessionId, (sessionDir) =>
        recordStep(sessionDir, edit, deps.maxSessionBytes),
      ),
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
    async flush(): Promise<void> {
      while (active.size > 0) {
        await Promise.allSettled([...active]);
      }
    },
  };
}
