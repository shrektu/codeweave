import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DiffOmission, FileChange } from "../domain/events";
import type { FileDiffView } from "../shared/views";

import { createCheckpointStore, type CheckpointStore } from "./checkpointStore";
import {
  CHECKPOINT_BLOBS_DIR,
  CHECKPOINT_INDEX_FILE,
  DIFF_MAX_FILE_BYTES,
} from "./constants";
import { computeFileDiff } from "./fileDiff";
import { SnapshotKind, type FileSnapshot } from "./fileSnapshot";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const SCRIPT_MODE = 0o755;
const PERMISSION_MASK = 0o777;

let dir = "";
let work = "";
let store: CheckpointStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-checkpoint-store-"));
  work = join(dir, "work");
  await mkdir(work, { recursive: true });
  store = createCheckpointStore({
    dir: join(dir, "checkpoints"),
    maxSessionBytes: DEFAULT_MAX_BYTES,
    protectedPaths: () => Promise.resolve([]),
  });
});

afterEach(async () => {
  await store.flush();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function snapshotOf(text: string | null): FileSnapshot {
  return text === null
    ? { kind: SnapshotKind.missing }
    : { kind: SnapshotKind.text, text };
}

function diffOf(
  path: string,
  before: string | null,
  after: string | null,
): FileDiffView {
  const diff = computeFileDiff(path, snapshotOf(before), snapshotOf(after));
  if (diff === null) {
    throw new Error(`no diff for ${path}`);
  }
  return diff;
}

function omittedDiff(path: string, omitted: DiffOmission): FileDiffView {
  return { path, change: FileChange.modified, omitted };
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function blobsOf(sessionId: string): Promise<readonly string[]> {
  return readdir(join(dir, "checkpoints", sessionId, CHECKPOINT_BLOBS_DIR));
}

it("record falls back to the chained after when the patch does not reverse", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, null, "v1\n"),
  });
  await writeText(a, "zzz\n");
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: diffOf(a, "v1\n", "v2\n"),
  });

  const entries = await store.entries(SESSION_ID);
  expect(entries[0]?.after).toMatchObject({ kind: "stored" });
  expect(entries[1]?.before).toMatchObject({ kind: "stored" });
  expect(entries[1]?.before).toEqual(entries[0]?.after);
});

it("record marks the first not_reported edit unknown", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");

  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: omittedDiff(a, DiffOmission.notReported),
  });

  const entries = await store.entries(SESSION_ID);
  expect(entries[0]?.before).toEqual({
    kind: "unknown",
    reason: "not_reported",
  });
  expect(entries[0]?.after).toMatchObject({ kind: "stored" });
  const plan = await store.plan(SESSION_ID, 1);
  expect(plan.files).toEqual([
    { path: a, action: "none", skip: "not_reported" },
  ]);
});

it("plan reports patch_mismatch for a first edit whose patch does not reverse", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "zzz\n");

  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: {
      path: a,
      change: FileChange.modified,
      patch: "@@ -1,1 +1,1 @@\n-v0\n+v1",
    },
  });

  const plan = await store.plan(SESSION_ID, 1);
  expect(plan.files).toEqual([
    { path: a, action: "none", skip: "patch_mismatch" },
  ]);
  const report = await store.restore(SESSION_ID, 1, []);
  expect(await readText(a)).toBe("zzz\n");
  expect(report.skipped).toEqual([{ path: a, reason: "patch_mismatch" }]);
});

it("record marks binary and too large files unknown", async () => {
  const binary = join(work, "binary.dat");
  await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: omittedDiff(binary, DiffOmission.binary),
  });
  const large = join(work, "large.txt");
  await writeFile(large, "a".repeat(DIFF_MAX_FILE_BYTES + 1));
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 1,
    diff: omittedDiff(large, DiffOmission.tooLarge),
  });

  const entries = await store.entries(SESSION_ID);
  const binaryEntry = entries.find((entry) => entry.path === binary);
  const largeEntry = entries.find((entry) => entry.path === large);
  expect(binaryEntry?.before).toEqual({ kind: "unknown", reason: "binary" });
  expect(binaryEntry?.after).toEqual({ kind: "unknown", reason: "binary" });
  expect(largeEntry?.before).toEqual({
    kind: "unknown",
    reason: "too_large",
  });
  expect(largeEntry?.after).toEqual({
    kind: "unknown",
    reason: "too_large",
  });
  const plan = await store.plan(SESSION_ID, 1);
  expect(plan.files).toEqual([
    { path: binary, action: "none", skip: "binary" },
    { path: large, action: "none", skip: "too_large" },
  ]);
});

it("plan reports a protected path and restore never touches it", async () => {
  const guarded = createCheckpointStore({
    dir: join(dir, "guarded"),
    maxSessionBytes: DEFAULT_MAX_BYTES,
    protectedPaths: () => Promise.resolve([work]),
  });
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await guarded.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });

  const plan = await guarded.plan(SESSION_ID, 1);
  expect(plan.files).toEqual([{ path: a, action: "write", skip: "protected" }]);
  const report = await guarded.restore(SESSION_ID, 1, []);
  expect(await readText(a)).toBe("v1\n");
  expect(report.skipped).toEqual([{ path: a, reason: "protected" }]);
});

it("eviction drops the oldest prompt group and keeps later prompts restorable", async () => {
  const small = createCheckpointStore({
    dir: join(dir, "small"),
    maxSessionBytes: 8,
    protectedPaths: () => Promise.resolve([]),
  });
  const a = join(work, "a.txt");
  await writeText(a, "one\n");
  await writeText(a, "one1\n");
  await small.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "one\n", "one1\n"),
  });
  await writeText(a, "one2\n");
  await small.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: diffOf(a, "one1\n", "one2\n"),
  });

  const entries = await small.entries(SESSION_ID);
  expect(entries[0]?.before).toEqual({ kind: "unknown", reason: "evicted" });
  expect(entries[0]?.after).toEqual({ kind: "unknown", reason: "evicted" });
  expect(entries[1]?.before).toMatchObject({ kind: "stored" });

  const oldest = await small.plan(SESSION_ID, 1);
  expect(oldest.files).toEqual([{ path: a, action: "none", skip: "evicted" }]);

  await small.restore(SESSION_ID, 2, []);
  expect(await readText(a)).toBe("one1\n");
});

it("corrupt index is treated as empty", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const sessionDir = join(dir, "checkpoints", SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, CHECKPOINT_INDEX_FILE), "{broken", "utf8");

  expect(await store.entries(SESSION_ID)).toEqual([]);
  expect(await store.plan(SESSION_ID, 1)).toEqual({
    sessionId: SESSION_ID,
    promptSeq: 1,
    files: [],
  });

  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, null, "v1\n"),
  });
  expect(await store.entries(SESSION_ID)).toHaveLength(1);
  expect(error).toHaveBeenCalled();
});

it("concurrent records for one session are all kept", async () => {
  const a = join(work, "a.txt");
  const b = join(work, "b.txt");
  await writeText(a, "a\n");
  await writeText(b, "b\n");

  const first = store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, null, "a\n"),
  });
  const second = store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 1,
    diff: diffOf(b, null, "b\n"),
  });
  await Promise.all([first, second]);

  const entries = await store.entries(SESSION_ID);
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.editKey).toSorted()).toEqual([
    "e-1",
    "e-2",
  ]);
});

it("invalid session id is rejected", async () => {
  const a = join(work, "a.txt");

  await expect(
    store.record("../../escape", {
      editKey: "e-1",
      promptSeq: 1,
      diff: omittedDiff(a, DiffOmission.notReported),
    }),
  ).rejects.toThrow("Invalid session id");
  await expect(store.entries("../../escape")).rejects.toThrow(
    "Invalid session id",
  );
});

it("restore drops entries at and after the prompt and deletes unreferenced blobs", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeText(a, "v2\n");
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: diffOf(a, "v1\n", "v2\n"),
  });
  const recorded = await store.entries(SESSION_ID);
  const dropped = recorded.find((entry) => entry.promptSeq === 2)?.after;
  expect(dropped?.kind).toBe("stored");
  const droppedHash = dropped?.kind === "stored" ? dropped.hash : "missing";
  expect(await blobsOf(SESSION_ID)).toHaveLength(3);

  await store.restore(SESSION_ID, 2, []);

  const remaining = await store.entries(SESSION_ID);
  expect(remaining.map((entry) => entry.promptSeq)).toEqual([1]);
  const blobs = await blobsOf(SESSION_ID);
  expect(blobs).toHaveLength(2);
  expect(blobs).not.toContain(droppedHash);
});

it("plan reports unverifiable when the last after is unknown", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeFile(a, Buffer.from([0x61, 0x00, 0x62]));
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: omittedDiff(a, DiffOmission.binary),
  });

  const plan = await store.plan(SESSION_ID, 1);
  expect(plan.files).toEqual([
    { path: a, action: "write", skip: "unverifiable" },
  ]);
  const report = await store.restore(SESSION_ID, 1, []);
  expect(await readFile(a)).toEqual(Buffer.from([0x61, 0x00, 0x62]));
  expect(report.skipped).toEqual([{ path: a, reason: "unverifiable" }]);
});

it("restore overwrites an unverifiable file when its path is requested", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeFile(a, Buffer.from([0x61, 0x00, 0x62]));
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: omittedDiff(a, DiffOmission.binary),
  });

  const report = await store.restore(SESSION_ID, 1, [a]);
  expect(await readText(a)).toBe("v0\n");
  expect(report.restored).toEqual([a]);
});

it("rapid successive edits are not baked into the earlier before", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v2\n");
  const first = diffOf(a, "v0\n", "v1\n");
  const second = diffOf(a, "v1\n", "v2\n");

  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: first,
  });
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: second,
  });

  const entries = await store.entries(SESSION_ID);
  expect(entries[0]?.after).toEqual(entries[1]?.before);
  await store.restore(SESSION_ID, 1, []);
  expect(await readText(a)).toBe("v0\n");
});

it.skipIf(process.platform === "win32")(
  "restore writes through a symlink and keeps the link",
  async (context) => {
    const target = join(work, "target.txt");
    const link = join(work, "link.txt");
    await writeText(target, "v0\n");
    try {
      await symlink(target, link);
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    await writeText(target, "v1\n");
    await store.record(SESSION_ID, {
      editKey: "e-1",
      promptSeq: 1,
      diff: diffOf(link, "v0\n", "v1\n"),
    });

    await store.restore(SESSION_ID, 1, []);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readText(target)).toBe("v0\n");
  },
);

it.skipIf(process.platform === "win32")(
  "restore keeps the file mode",
  async () => {
    const script = join(work, "run.sh");
    await writeText(script, "v0\n");
    await chmod(script, SCRIPT_MODE);
    await writeText(script, "v1\n");
    await store.record(SESSION_ID, {
      editKey: "e-1",
      promptSeq: 1,
      diff: diffOf(script, "v0\n", "v1\n"),
    });

    await store.restore(SESSION_ID, 1, []);

    expect((await stat(script)).mode & PERMISSION_MASK).toBe(SCRIPT_MODE);
  },
);

it("a user edit between two agent edits does not rewrite the earlier before", async () => {
  const a = join(work, "a.txt");
  const original = "one\norig\nthree\n";
  const agent = "one\nAGENT\nthree\n";
  const user = "one\nUSER\nthree\n";
  const final = "one\nFINAL\nthree\n";
  await writeText(a, original);
  await writeText(a, agent);
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, original, agent),
  });
  await writeText(a, user);
  await writeText(a, final);
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: diffOf(a, user, final),
  });

  await store.restore(SESSION_ID, 1, []);

  expect(await readText(a)).toBe(original);
});

it("a user edit outside the hunks does not rewrite the earlier before", async () => {
  const a = join(work, "a.txt");
  const original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
  const agent = "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
  const user = "ONE\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\n";
  const final = "ONE\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nNINE\n";
  await writeText(a, original);
  await writeText(a, agent);
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, original, agent),
  });
  await writeText(a, user);
  await writeText(a, final);
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: diffOf(a, user, final),
  });

  await store.restore(SESSION_ID, 1, []);

  expect(await readText(a)).toBe(original);
});

it("a three-edit late read chain repairs every earlier before", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v3\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 2,
    diff: diffOf(a, "v1\n", "v2\n"),
  });
  await store.record(SESSION_ID, {
    editKey: "e-3",
    promptSeq: 3,
    diff: diffOf(a, "v2\n", "v3\n"),
  });

  const entries = await store.entries(SESSION_ID);
  expect(entries[0]?.before).toMatchObject({ kind: "stored" });
  await store.restore(SESSION_ID, 1, []);
  expect(await readText(a)).toBe("v0\n");
});

it.skipIf(process.platform === "win32")(
  "restore never writes through a symlink into a protected path",
  async (context) => {
    const secretDir = join(dir, "secret");
    const secret = join(secretDir, "data.txt");
    await writeText(secret, "v0\n");
    const link = join(work, "link.txt");
    try {
      await symlink(secret, link);
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    await writeText(secret, "v1\n");
    const guarded = createCheckpointStore({
      dir: join(dir, "guarded"),
      maxSessionBytes: DEFAULT_MAX_BYTES,
      protectedPaths: () => Promise.resolve([secretDir]),
    });
    await guarded.record(SESSION_ID, {
      editKey: "e-1",
      promptSeq: 1,
      diff: diffOf(link, "v0\n", "v1\n"),
    });

    const plan = await guarded.plan(SESSION_ID, 1);
    expect(plan.files).toEqual([
      { path: link, action: "write", skip: "protected" },
    ]);
    const report = await guarded.restore(SESSION_ID, 1, []);
    expect(await readText(secret)).toBe("v1\n");
    expect(report.skipped).toEqual([{ path: link, reason: "protected" }]);
  },
);

it.skipIf(process.platform === "win32")(
  "restore never creates a file through a symlinked protected directory",
  async (context) => {
    const secretDir = join(dir, "secret");
    await mkdir(secretDir, { recursive: true });
    const linkedDir = join(work, "linked");
    try {
      await symlink(secretDir, linkedDir);
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const created = join(linkedDir, "created.txt");
    await writeText(created, "v1\n");
    const guarded = createCheckpointStore({
      dir: join(dir, "guarded"),
      maxSessionBytes: DEFAULT_MAX_BYTES,
      protectedPaths: () => Promise.resolve([secretDir]),
    });
    await guarded.record(SESSION_ID, {
      editKey: "e-1",
      promptSeq: 1,
      diff: diffOf(created, null, "v1\n"),
    });

    const plan = await guarded.plan(SESSION_ID, 1);
    expect(plan.files).toEqual([
      { path: created, action: "delete", skip: "protected" },
    ]);
    const report = await guarded.restore(SESSION_ID, 1, []);
    expect(await readText(join(secretDir, "created.txt"))).toBe("v1\n");
    expect(report.skipped).toEqual([{ path: created, reason: "protected" }]);
  },
);
