import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { PermissionProfile, ProviderId } from "../domain/types";
import { emptyUsageLedger } from "../domain/usageLedger";
import type {
  FileDiffView,
  PromptView,
  SessionView,
  ToolCallView,
} from "../shared/views";

import { createCheckpointRecorder } from "./checkpointRecorder";
import {
  createCheckpointStore,
  type CheckpointEdit,
  type CheckpointStore,
} from "./checkpointStore";
import type { CheckpointEntry } from "./checkpointPlan";
import { computeFileDiff } from "./fileDiff";
import {
  SnapshotKind,
  type FileSnapshot,
  type StampedSnapshot,
} from "./fileSnapshot";
import { settled } from "../../tests/fakes/settle";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "run-1";
const MAX_SESSION_BYTES = 1024 * 1024;
const PROMPTS: PromptView[] = [
  { seq: 1, text: "first", attachments: [] },
  { seq: 5, text: "second", attachments: [] },
];

let dir = "";
let work = "";
let store: CheckpointStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-checkpoint-recorder-"));
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

function stampedOf(text: string | null): StampedSnapshot {
  return { snapshot: snapshotOf(text) };
}

function diffOf(
  path: string,
  before: string | null = null,
  after: string | null = "v1\n",
): FileDiffView {
  const diff = computeFileDiff(path, snapshotOf(before), snapshotOf(after));
  if (diff === null) {
    throw new Error(`no diff for ${path}`);
  }
  return diff;
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
    usage: emptyUsageLedger(),
    turns: [],
    orchestrate: false,
    imageInput: true,
    canCompact: false,
    prompts: [],
    ...overrides,
  };
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
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

it("main edits use the last prompt before the call", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  const recorder = createCheckpointRecorder({
    store,
    ownerOf: () => null,
  });

  recorder.observeMain(makeView({ prompts: PROMPTS }));
  recorder.observeMain(
    makeView({
      prompts: PROMPTS,
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          seq: 3,
          diffs: [diffOf(a)],
        }),
      ],
    }),
  );
  const entries = await recordedEntries(1);
  expect(entries[0]?.promptSeq).toBe(1);
});

it("run edits use the owner session's latest prompt seq", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  const recorder = createCheckpointRecorder({
    store,
    ownerOf: (runId) => (runId === RUN_ID ? SESSION_ID : null),
  });

  recorder.observeMain(makeView({ prompts: PROMPTS }));
  recorder.observeRun(RUN_ID, makeView());
  recorder.observeRun(
    RUN_ID,
    makeView({
      toolCalls: [makeToolCall({ toolCallId: "tc-run", diffs: [diffOf(a)] })],
    }),
  );
  const entries = await recordedEntries(1);
  expect(entries[0]?.promptSeq).toBe(5);
  expect(entries[0]?.editKey.startsWith(RUN_ID)).toBe(true);
});

it("run edits without an owner are ignored", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  const recorder = createCheckpointRecorder({
    store,
    ownerOf: () => null,
  });

  recorder.observeRun(RUN_ID, makeView());
  recorder.observeRun(
    RUN_ID,
    makeView({
      toolCalls: [makeToolCall({ toolCallId: "tc-run", diffs: [diffOf(a)] })],
    }),
  );
  await store.flush();

  expect(await store.entries(SESSION_ID)).toEqual([]);
});

it("repeated observation records an edit once", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  const recorder = createCheckpointRecorder({
    store,
    ownerOf: () => null,
  });
  const edit = makeToolCall({ toolCallId: "tc-1", diffs: [diffOf(a)] });

  recorder.observeMain(makeView({ prompts: PROMPTS }));
  recorder.observeMain(makeView({ prompts: PROMPTS, toolCalls: [edit] }));
  recorder.observeMain(makeView({ prompts: PROMPTS, toolCalls: [edit] }));
  expect(await recordedEntries(1)).toHaveLength(1);
});

it("the after snapshot is read when the edit is observed, not when the record runs", async () => {
  const a = join(work, "a.txt");
  await writeText(a, "v1\n");
  const recorded = Promise.withResolvers<CheckpointEdit>();
  const release = Promise.withResolvers<undefined>();
  const recorder = createCheckpointRecorder({
    store: {
      record: (_sessionId: string, edit: CheckpointEdit): Promise<void> => {
        recorded.resolve(edit);
        return release.promise;
      },
    },
    ownerOf: () => null,
  });

  recorder.observeMain(makeView({ prompts: PROMPTS }));
  recorder.observeMain(
    makeView({
      prompts: PROMPTS,
      toolCalls: [makeToolCall({ toolCallId: "tc-1", diffs: [diffOf(a)] })],
    }),
  );
  const edit = await recorded.promise;
  const observed = await edit.after;
  await writeText(a, "v2\n");
  release.resolve(undefined);

  expect(observed.snapshot).toMatchObject({
    kind: SnapshotKind.text,
    text: "v1\n",
  });
});

it("edit_observed_while_previous_read_pending_links_late_read", () => {
  const a = join(work, "a.txt");
  const read = Promise.withResolvers<StampedSnapshot>();
  const edits: CheckpointEdit[] = [];
  const recorder = createCheckpointRecorder({
    store: {
      record: (_sessionId: string, edit: CheckpointEdit): Promise<void> => {
        edits.push(edit);
        return Promise.resolve();
      },
    },
    ownerOf: () => null,
    readSnapshot: () => read.promise,
  });

  recorder.observeMain(makeView({ prompts: PROMPTS }));
  recorder.observeMain(
    makeView({
      prompts: PROMPTS,
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          seq: 3,
          diffs: [diffOf(a, "v0\n", "v1\n")],
        }),
      ],
    }),
  );
  recorder.observeMain(
    makeView({
      prompts: PROMPTS,
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          seq: 3,
          diffs: [diffOf(a, "v0\n", "v1\n")],
        }),
        makeToolCall({
          toolCallId: "tc-2",
          seq: 4,
          diffs: [diffOf(a, "v1\n", "v2\n")],
        }),
      ],
    }),
  );

  expect(edits).toHaveLength(2);
  expect(edits[0]?.lateReadOf).toBeUndefined();
  expect(edits[1]?.lateReadOf).toBe(edits[0]?.editKey);
});

it("edit_observed_after_previous_read_settled_has_no_link", async () => {
  const a = join(work, "a.txt");
  const read = Promise.withResolvers<StampedSnapshot>();
  const edits: CheckpointEdit[] = [];
  const recorder = createCheckpointRecorder({
    store: {
      record: (_sessionId: string, edit: CheckpointEdit): Promise<void> => {
        edits.push(edit);
        return Promise.resolve();
      },
    },
    ownerOf: () => null,
    readSnapshot: () => read.promise,
  });

  recorder.observeMain(makeView({ prompts: PROMPTS }));
  recorder.observeMain(
    makeView({
      prompts: PROMPTS,
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          seq: 3,
          diffs: [diffOf(a, "v0\n", "v1\n")],
        }),
      ],
    }),
  );
  read.resolve(stampedOf("v1\n"));
  await read.promise.then(() => undefined);
  recorder.observeMain(
    makeView({
      prompts: PROMPTS,
      toolCalls: [
        makeToolCall({
          toolCallId: "tc-1",
          seq: 3,
          diffs: [diffOf(a, "v0\n", "v1\n")],
        }),
        makeToolCall({
          toolCallId: "tc-2",
          seq: 4,
          diffs: [diffOf(a, "v1\n", "v2\n")],
        }),
      ],
    }),
  );

  expect(edits).toHaveLength(2);
  expect(edits[1]?.lateReadOf).toBeUndefined();
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

  recorder.observeMain(makeView({ cwd: work, prompts: PROMPTS }));
  recorder.observeMain(
    makeView({
      cwd: work,
      prompts: PROMPTS,
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
