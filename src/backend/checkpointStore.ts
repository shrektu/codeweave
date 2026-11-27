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
  type SnapshotStamp,
  type StampedSnapshot,
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
const NANOSECONDS_PER_SECOND = 1_000_000_000n;

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
  readonly after: Promise<StampedSnapshot>;
  readonly lateReadOf?: string;
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

function patchMismatchRef(): BlobRef {
  return { kind: "unknown", reason: RestoreSkipReason.patchMismatch };
}

interface CorrectedRefs {
  readonly before: BlobRef;
  readonly after: BlobRef;
}

function isEvictedEntry(entry: CheckpointEntry): boolean {
  return (
    (entry.before.kind === "unknown" &&
      entry.before.reason === RestoreSkipReason.evicted) ||
    (entry.after.kind === "unknown" &&
      entry.after.reason === RestoreSkipReason.evicted)
  );
}

function keepsMissingBefore(entry: CheckpointEntry): boolean {
  if (entry.change !== undefined) {
    return entry.change === FileChange.created;
  }
  return entry.before.kind === "missing";
}

function linkedEntries(
  entries: readonly CheckpointEntry[],
  path: string,
  firstKey: string,
): readonly CheckpointEntry[] {
  const byKey = new Map<string, CheckpointEntry>();
  for (const entry of entries) {
    if (entry.path === path) {
      byKey.set(entry.editKey, entry);
    }
  }
  const chain: CheckpointEntry[] = [];
  const seen = new Set<string>();
  let key: string | undefined = firstKey;
  while (key !== undefined && !seen.has(key)) {
    const entry = byKey.get(key);
    if (entry === undefined || isEvictedEntry(entry)) {
      break;
    }
    chain.push(entry);
    seen.add(key);
    key = entry.lateReadOf;
  }
  return chain;
}

function stampsEqual(a: SnapshotStamp, b: SnapshotStamp): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function hasFineMtime(stamp: SnapshotStamp): boolean {
  return BigInt(stamp.mtimeNs) % NANOSECONDS_PER_SECOND !== 0n;
}

function inferredLateReadOf(
  entries: readonly CheckpointEntry[],
  path: string,
  after: BlobRef,
  stamp: SnapshotStamp | undefined,
): string | undefined {
  if (after.kind !== "stored" || stamp === undefined) {
    return undefined;
  }
  const latest = latestEntryFor(entries, path);
  if (
    latest?.after.kind !== "stored" ||
    latest.after.hash !== after.hash ||
    latest.afterStamp === undefined ||
    !stampsEqual(latest.afterStamp, stamp) ||
    !hasFineMtime(stamp)
  ) {
    return undefined;
  }
  return latest.editKey;
}

async function correctedChain(
  sessionDir: string,
  chain: readonly CheckpointEntry[],
  edit: CheckpointEdit,
  afterText: string,
): Promise<ReadonlyMap<number, CorrectedRefs>> {
  const corrected = new Map<number, CorrectedRefs>();
  let text = afterText;
  let newerPatch = "patch" in edit.diff ? edit.diff.patch : undefined;
  for (const entry of chain) {
    const next =
      newerPatch === undefined ? null : reverseApply(newerPatch, text);
    if (next === null) {
      break;
    }
    text = next;
    let before: BlobRef | null;
    if (keepsMissingBefore(entry)) {
      before = { kind: "missing" };
    } else {
      const beforeText =
        entry.patch === undefined ? null : reverseApply(entry.patch, text);
      before =
        beforeText === null ? null : await storeText(sessionDir, beforeText);
    }
    if (before === null) {
      break;
    }
    corrected.set(entry.order, {
      before,
      after: await storeText(sessionDir, text),
    });
    newerPatch = entry.patch;
  }
  return corrected;
}

async function correctLateReads(
  sessionDir: string,
  entries: readonly CheckpointEntry[],
  edit: CheckpointEdit,
  after: BlobRef,
  lateReadOf: string | undefined,
): Promise<readonly CheckpointEntry[]> {
  if (after.kind !== "stored" || lateReadOf === undefined) {
    return entries;
  }
  const chain = linkedEntries(entries, edit.diff.path, lateReadOf);
  if (chain.length === 0) {
    return entries;
  }
  const afterText = await readBlobText(sessionDir, after.hash);
  const corrected = await correctedChain(sessionDir, chain, edit, afterText);
  const uncorrected = new Set(
    chain
      .filter((entry) => !corrected.has(entry.order))
      .map((entry) => entry.order),
  );
  return entries.map((entry) => {
    if (uncorrected.has(entry.order)) {
      return {
        ...entry,
        before: patchMismatchRef(),
        after: patchMismatchRef(),
      };
    }
    const fixed = corrected.get(entry.order);
    if (fixed === undefined) {
      return entry;
    }
    return { ...entry, before: fixed.before, after: fixed.after };
  });
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
  | { readonly ok: true; readonly snapshot: StampedSnapshot }
  | { readonly ok: false; readonly error: unknown };

function settleAfter(
  after: Promise<StampedSnapshot>,
): Promise<SettledSnapshot> {
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
  const after = await storeSnapshot(sessionDir, afterSnapshot.snapshot);
  const lateReadOf =
    edit.lateReadOf ??
    inferredLateReadOf(
      index.entries,
      edit.diff.path,
      after,
      afterSnapshot.stamp,
    );
  const entries = await correctLateReads(
    sessionDir,
    index.entries,
    edit,
    after,
    lateReadOf,
  );
  const before = await computeBefore(
    sessionDir,
    edit,
    afterSnapshot.snapshot,
    entries,
  );
  const patch = "patch" in edit.diff ? edit.diff.patch : undefined;
  const entry: CheckpointEntry = {
    editKey: edit.editKey,
    promptSeq: edit.promptSeq,
    path: edit.diff.path,
    before,
    after,
    order: index.nextOrder,
    change: edit.diff.change,
    ...(patch === undefined ? {} : { patch }),
    ...(lateReadOf === undefined ? {} : { lateReadOf }),
    ...(afterSnapshot.stamp === undefined
      ? {}
      : { afterStamp: afterSnapshot.stamp }),
  };
  const entriesWithNew = [...entries, entry];
  const evicted = evictOldest(entriesWithNew, maxSessionBytes);
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
