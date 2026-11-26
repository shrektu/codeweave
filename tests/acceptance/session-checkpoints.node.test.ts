import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { computeFileDiff } from "../../src/backend/fileDiff";
import {
  SnapshotKind,
  type FileSnapshot,
} from "../../src/backend/fileSnapshot";
import { createCheckpointRecorder } from "../../src/backend/checkpointRecorder";
import {
  createCheckpointStore,
  type CheckpointStore,
} from "../../src/backend/checkpointStore";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import type {
  FileDiffView,
  SessionView,
  ToolCallView,
} from "../../src/shared/views";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MAX_SESSION_BYTES = 1024 * 1024;
const SCRIPT_MODE = 0o755;
const PERMISSION_MASK = 0o777;

let dir = "";
let work = "";
let store: CheckpointStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-checkpoints-"));
  work = join(dir, "work");
  await mkdir(work, { recursive: true });
  store = createCheckpointStore({
    dir: join(dir, "checkpoints"),
    maxSessionBytes: MAX_SESSION_BYTES,
    protectedPaths: () => Promise.resolve([]),
  });
});

afterEach(async () => {
  await store.flush();
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

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function makeToolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "tc-1",
    title: "Edit file",
    kind: "edit",
    status: "completed",
    seq: 1,
    ...overrides,
  };
}

function makeView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: SESSION_ID,
    createdAt: 0,
    cwd: "/repo",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.acceptEdits,
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    activeProvider: ProviderId.claude,
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    contextUsage: null,
    turns: [],
    orchestrate: false,
    prompts: [],
    ...overrides,
  };
}

it("restore rewinds every file edited at or after the prompt", async () => {
  const a = join(work, "a.txt");
  const b = join(work, "b.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeText(b, "b1\n");
  await store.record(SESSION_ID, {
    editKey: "e-2",
    promptSeq: 1,
    diff: diffOf(b, null, "b1\n"),
  });
  await writeText(a, "v2\n");
  await store.record(SESSION_ID, {
    editKey: "e-3",
    promptSeq: 2,
    diff: diffOf(a, "v1\n", "v2\n"),
  });

  const second = await store.restore(SESSION_ID, 2, []);
  expect(await readFile(a, "utf8")).toBe("v1\n");
  expect(await exists(b)).toBe(true);
  expect(second.restored).toEqual([a]);

  await store.restore(SESSION_ID, 1, []);
  expect(await readFile(a, "utf8")).toBe("v0\n");
  expect(await exists(b)).toBe(false);
});

it("plan skips a file edited after the agent and restore leaves it untouched", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeText(a, "user\n");

  const plan = await store.plan(SESSION_ID, 1);
  expect(plan.files[0]?.skip).toBe("conflict");
  expect(plan.files).toEqual([{ path: a, action: "write", skip: "conflict" }]);

  const kept = await store.restore(SESSION_ID, 1, []);
  expect(await readFile(a, "utf8")).toBe("user\n");
  expect(kept.skipped).toEqual([{ path: a, reason: "conflict" }]);
});

it("restore overwrites a conflicting file when its path is requested", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  await store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeText(a, "user\n");

  const overwritten = await store.restore(SESSION_ID, 1, [a]);
  expect(await readFile(a, "utf8")).toBe("v0\n");
  expect(overwritten.restored).toEqual([a]);
});

it("recorder treats calls present at the first observation as replays", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  const recorder = createCheckpointRecorder({
    store,
    ownerOf: () => null,
  });
  const replayed = makeToolCall({
    toolCallId: "tc-1",
    diffs: [diffOf(a, "v0\n", "v1\n")],
  });

  recorder.observeMain(makeView({ toolCalls: [replayed] }));
  await store.flush();
  expect(await store.entries(SESSION_ID)).toHaveLength(0);

  await writeText(a, "v2\n");
  const fresh = makeToolCall({
    toolCallId: "tc-2",
    seq: 2,
    diffs: [diffOf(a, "v1\n", "v2\n")],
  });
  recorder.observeMain(makeView({ toolCalls: [replayed, fresh] }));
  await store.flush();
  expect(await store.entries(SESSION_ID)).toHaveLength(1);
});

it("restore does not bake a rapid later edit into the earlier before", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v2\n");

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
  const entries = await store.entries(SESSION_ID);
  expect(entries[0]?.after).toEqual(entries[1]?.before);

  await store.restore(SESSION_ID, 1, []);
  expect(await readFile(a, "utf8")).toBe("v0\n");
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
    expect(await readFile(target, "utf8")).toBe("v0\n");
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

it("relative edit paths resolve against the session cwd", async () => {
  const relative = join("nested", "a.txt");
  const absolute = join(work, relative);
  await writeText(absolute, "v0\n");
  await writeText(absolute, "v1\n");
  const recorder = createCheckpointRecorder({
    store,
    ownerOf: () => null,
  });

  recorder.observeMain(makeView({ cwd: work }));
  recorder.observeMain(
    makeView({
      cwd: work,
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          diffs: [diffOf(relative, "v0\n", "v1\n")],
        }),
      ],
    }),
  );
  await store.flush();
  expect((await store.entries(SESSION_ID))[0]?.path).toBe(absolute);

  await store.restore(SESSION_ID, 0, []);
  expect(await readFile(absolute, "utf8")).toBe("v0\n");
});

it("a user edit between two agent edits keeps the earlier before", async () => {
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

  expect(await readFile(a, "utf8")).toBe(original);
});

it("a user edit outside the hunks keeps the earlier before", async () => {
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

  expect(await readFile(a, "utf8")).toBe(original);
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
      maxSessionBytes: MAX_SESSION_BYTES,
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
    expect(await readFile(secret, "utf8")).toBe("v1\n");
    expect(report.skipped).toEqual([{ path: link, reason: "protected" }]);
  },
);
