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

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { computeFileDiff } from "../../src/backend/fileDiff";
import {
  readFileSnapshot,
  SnapshotKind,
  type FileSnapshot,
} from "../../src/backend/fileSnapshot";
import { createCheckpointRecorder } from "../../src/backend/checkpointRecorder";
import {
  createCheckpointStore,
  type CheckpointEdit,
  type CheckpointStore,
} from "../../src/backend/checkpointStore";
import type { CheckpointEntry } from "../../src/backend/checkpointPlan";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import type {
  FileDiffView,
  SessionView,
  ToolCallView,
} from "../../src/shared/views";
import { settled } from "../fakes/settle";

interface FsGate {
  readonly match: string;
  readonly entered: PromiseWithResolvers<undefined>;
  readonly release: PromiseWithResolvers<undefined>;
}

const fsGate = vi.hoisted(() => ({ gate: undefined as FsGate | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const gate = fsGate.gate;
      if (gate !== undefined && to.includes(gate.match)) {
        fsGate.gate = undefined;
        gate.entered.resolve(undefined);
        await gate.release.promise;
      }
      await actual.rename(from, to);
    },
  };
});

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

async function recordEdit(
  target: CheckpointStore,
  edit: Omit<CheckpointEdit, "after">,
): Promise<void> {
  await target.record(SESSION_ID, {
    ...edit,
    after: readFileSnapshot(edit.diff.path),
  });
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

function gateRenames(match: string): FsGate {
  const gate = {
    match,
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  fsGate.gate = gate;
  return gate;
}

async function recordedEntries(
  count: number,
): Promise<readonly CheckpointEntry[]> {
  return settled(async () => {
    const entries = await store.entries(SESSION_ID);
    expect(entries).toHaveLength(count);
    return entries;
  });
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

function diffCall(
  toolCallId: string,
  path: string,
  before: string,
  after: string,
): ToolCallView {
  return makeToolCall({
    toolCallId,
    diffs: [diffOf(path, before, after)],
  });
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
  await recordEdit(store, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
  });
  await writeText(b, "b1\n");
  await recordEdit(store, {
    editKey: "e-2",
    promptSeq: 1,
    diff: diffOf(b, null, "b1\n"),
  });
  await writeText(a, "v2\n");
  await recordEdit(store, {
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
  await recordEdit(store, {
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
  await recordEdit(store, {
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
  expect(await recordedEntries(1)).toHaveLength(1);
});

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
  const entries = await recordedEntries(1);
  expect(entries[0]?.path).toBe(absolute);

  await store.restore(SESSION_ID, 0, []);
  expect(await readFile(absolute, "utf8")).toBe("v0\n");
});

it("a slow record does not bake a later edit into the earlier before", async () => {
  const a = join(work, "a.txt");
  const b = join(work, "b.txt");
  await writeText(a, "v0\n");
  await writeText(b, "b1\n");
  const gate = gateRenames(SESSION_ID);
  const blocking = store.record(SESSION_ID, {
    editKey: "slow",
    promptSeq: 0,
    diff: diffOf(b, null, "b1\n"),
    after: Promise.resolve(snapshotOf("b1\n")),
  });
  await gate.entered.promise;

  const recordCalls: string[] = [];
  const recorder = createCheckpointRecorder({
    store: {
      record: (sessionId, edit): Promise<void> => {
        recordCalls.push(edit.editKey);
        return store.record(sessionId, edit);
      },
    },
    ownerOf: () => null,
  });
  recorder.observeMain(makeView());

  await writeText(a, "v1\n");
  recorder.observeMain(
    makeView({ toolCalls: [diffCall("tc-1", a, "v0\n", "v1\n")] }),
  );
  await settled(() => {
    expect(recordCalls).toHaveLength(1);
  });
  await writeText(a, "v2\n");
  recorder.observeMain(
    makeView({
      toolCalls: [
        diffCall("tc-1", a, "v0\n", "v1\n"),
        diffCall("tc-2", a, "v1\n", "v2\n"),
      ],
    }),
  );
  await settled(() => {
    expect(recordCalls).toHaveLength(2);
  });

  gate.release.resolve(undefined);
  await blocking;
  await recordedEntries(3);

  await store.restore(SESSION_ID, 0, []);
  expect(await readFile(a, "utf8")).toBe("v0\n");
});

it("a user edit between two agent edits keeps the earlier before", async () => {
  const a = join(work, "a.txt");
  const original = "one\norig\nthree\n";
  const agent = "one\nAGENT\nthree\n";
  const user = "one\nUSER\nthree\n";
  const final = "one\nFINAL\nthree\n";
  await writeText(a, original);
  await writeText(a, agent);
  await recordEdit(store, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, original, agent),
  });
  await writeText(a, user);
  await writeText(a, final);
  await recordEdit(store, {
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
  await recordEdit(store, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, original, agent),
  });
  await writeText(a, user);
  await writeText(a, final);
  await recordEdit(store, {
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
    await recordEdit(guarded, {
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

it.skipIf(process.platform === "win32")(
  "a protected root reached through a symlink still protects its files",
  async (context) => {
    const realRoot = join(dir, "real-secret");
    await mkdir(realRoot, { recursive: true });
    const alias = join(work, "alias");
    try {
      await symlink(realRoot, alias);
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const file = join(realRoot, "data.txt");
    await writeText(file, "v0\n");
    await writeText(file, "v1\n");
    const guarded = createCheckpointStore({
      dir: join(dir, "guarded-alias"),
      maxSessionBytes: MAX_SESSION_BYTES,
      protectedPaths: () => Promise.resolve([alias]),
    });
    await recordEdit(guarded, {
      editKey: "e-1",
      promptSeq: 1,
      diff: diffOf(file, "v0\n", "v1\n"),
    });

    const plan = await guarded.plan(SESSION_ID, 1);
    expect(plan.files).toEqual([
      { path: file, action: "write", skip: "protected" },
    ]);
    const report = await guarded.restore(SESSION_ID, 1, []);
    expect(await readFile(file, "utf8")).toBe("v1\n");
    expect(report.skipped).toEqual([{ path: file, reason: "protected" }]);
  },
);

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
    await recordEdit(store, {
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
    await recordEdit(store, {
      editKey: "e-1",
      promptSeq: 1,
      diff: diffOf(script, "v0\n", "v1\n"),
    });

    await store.restore(SESSION_ID, 1, []);

    expect((await stat(script)).mode & PERMISSION_MASK).toBe(SCRIPT_MODE);
  },
);

it("a record whose read is still pending is applied before a rewind's restore", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v0\n");
  await writeText(a, "v1\n");
  const after = Promise.withResolvers<FileSnapshot>();
  const pending = store.record(SESSION_ID, {
    editKey: "e-1",
    promptSeq: 1,
    diff: diffOf(a, "v0\n", "v1\n"),
    after: after.promise,
  });
  const restoring = store.restore(SESSION_ID, 1, []);
  after.resolve(snapshotOf("v1\n"));
  await pending;
  const report = await restoring;

  expect(await readFile(a, "utf8")).toBe("v0\n");
  expect(report.restored).toEqual([a]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable edited file does not crash the backend",
  async () => {
    const a = join(work, "locked.txt");
    await writeText(a, "v1\n");
    await chmod(a, 0o000);
    const unhandled = vi.fn();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.on("unhandledRejection", unhandled);
    try {
      const recorder = createCheckpointRecorder({
        store,
        ownerOf: () => null,
      });
      recorder.observeMain(makeView());
      recorder.observeMain(
        makeView({
          toolCalls: [
            makeToolCall({
              toolCallId: "tc-locked",
              diffs: [diffOf(a, "v0\n", "v1\n")],
            }),
          ],
        }),
      );
      await store.flush();
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(await store.entries(SESSION_ID)).toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await chmod(a, 0o600);
    }
  },
);
