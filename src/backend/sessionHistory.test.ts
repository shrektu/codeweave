import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { PermissionProfile, ProviderId } from "../domain/types";
import { RouteSource } from "../domain/routing";
import { TaskClass } from "../domain/taskClass";
import { IpcErrorCode } from "../shared/protocol";
import type {
  MessageView,
  SessionHistoryEntry,
  SessionView,
  StoredSession,
  ToolCallView,
  TurnRouteView,
} from "../shared/views";

import { SESSION_TITLE_MAX_CHARS } from "../domain/constants";
import {
  buildResumeSeed,
  createSessionHistory,
  type SessionHistory,
} from "./sessionHistory";

interface FsHold {
  readonly match: string;
  readonly entered: PromiseWithResolvers<undefined>;
  readonly release: PromiseWithResolvers<undefined>;
}

const fsHolds = vi.hoisted(() => ({
  hold: undefined as FsHold | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const hold = fsHolds.hold;
      if (hold !== undefined && to.includes(hold.match)) {
        fsHolds.hold = undefined;
        hold.entered.resolve(undefined);
        await hold.release.promise;
      }
      await actual.rename(from, to);
    },
  };
});

const NOW = 1_700_000_000_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CORRUPT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const TITLE_LONG_CHARS = 120;

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cw-session-history-"));
  dirs.push(dir);
  return dir;
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: SESSION_ID,
    createdAt: NOW,
    cwd: "/work/project",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    phase: { phase: "stopped" },
    activeAccountId: null,
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
    prompts: [{ seq: 0, text: "Do the task" }],
    ...overrides,
  };
}

function message(text: string): MessageView {
  return { id: null, text, seq: 1 };
}

async function storedIn(dir: string, id: string): Promise<StoredSession> {
  const text = await readFile(join(dir, `${id}.json`), "utf8");
  return JSON.parse(text) as StoredSession;
}

it("history_record_coalesces_rapid_views", async () => {
  const dir = await tempDir();
  const broadcasts: SessionHistoryEntry[] = [];
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: (_event, entry) => {
      broadcasts.push(entry);
    },
  });

  recordView(history, view({ messages: [message("first")] }));
  recordView(history, view({ messages: [message("second")] }));
  recordView(history, view({ messages: [message("third")] }));
  await history.flush();

  const stored = await storedIn(dir, SESSION_ID);
  expect(stored.messages.map((entry) => entry.text)).toEqual(["third"]);
  expect(broadcasts).not.toHaveLength(0);
  expect(broadcasts.at(-1)).toMatchObject({ id: SESSION_ID, updatedAt: NOW });
});

it("history_flushes_pending_writes", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  const huge = "x".repeat(2_000_000);

  recordView(history, view({ messages: [message(huge)] }));
  await history.flush();

  const stored = await storedIn(dir, SESSION_ID);
  expect(stored.messages[0]?.text).toHaveLength(huge.length);
});

it("history_list_skips_corrupt_file", async () => {
  const dir = await tempDir();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${CORRUPT_ID}.meta.json`), "{not json");

  recordView(history, view());
  await history.flush();

  const entries = await history.list();
  expect(entries.map((entry) => entry.id)).toEqual([SESSION_ID]);
  expect(error).toHaveBeenCalled();
});

it("history_rejects_non_uuid_id", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });

  await expect(history.get("../../escaped")).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
  });
  await expect(
    history.setArchived("../../escaped", true),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
  expect(await readdir(dir)).toEqual([]);
});

it("history_skips_session_without_prompts", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });

  recordView(history, view({ prompts: [] }));
  await history.flush();

  expect(await readdir(dir)).toEqual([]);
});

it("title_truncated_to_first_line", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });

  recordView(
    history,
    view({ prompts: [{ seq: 0, text: "first line\nsecond line" }] }),
  );
  await history.flush();
  const entries = await history.list();
  expect(entries[0]?.title).toBe("first line");

  recordView(
    history,
    view({ prompts: [{ seq: 0, text: "y".repeat(TITLE_LONG_CHARS) }] }),
  );
  await history.flush();
  const [long] = await history.list();
  expect(long?.title).toHaveLength(SESSION_TITLE_MAX_CHARS);
});

it("history_keeps_the_archived_flag_on_later_writes", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });

  recordView(history, view());
  await history.flush();
  await history.setArchived(SESSION_ID, true);
  recordView(history, view({ messages: [message("after archive")] }));
  await history.flush();

  const entries = await history.list();
  expect(entries[0]?.archived).toBe(true);
  const stored = await storedIn(dir, SESSION_ID);
  expect(stored.archived).toBe(true);
});

it("build_resume_seed_continues_after_the_stored_max_seq", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  recordView(
    history,
    view({
      messages: [message("reply")],
      turns: [
        {
          promptSeq: 0,
          accountId: "acc-1",
          model: null,
          effectiveModel: null,
          apiProvider: null,
          requestedClass: "standard",
          servedClass: "standard",
          source: "agent",
        },
      ],
    }),
  );
  await history.flush();
  const stored = await storedIn(dir, SESSION_ID);

  const seed = buildResumeSeed(stored, { isRepo: false, cwd: "/work/project" });

  expect(seed.id).toBe(SESSION_ID);
  expect(seed.createdAt).toBe(NOW);
  expect(seed.state.nextSeq).toBe(2);
  expect(seed.state.prompts).toEqual([{ seq: 0, text: "Do the task" }]);
  expect(seed.contextPackage).toContain("Do the task");
  expect(seed.contextPackage).toContain("reply");
});

const WRITE_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("timed out"));
      }, WRITE_TIMEOUT_MS);
    }),
  ]);
}

it("history_write_failure_does_not_hang", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, `${SESSION_ID}.json`));
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  const hold: FsHold = {
    match: `${SESSION_ID}.json`,
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  fsHolds.hold = hold;
  try {
    recordView(history, view({ messages: [message("first")] }));
    await hold.entered.promise;
    recordView(history, view({ messages: [message("second")] }));
  } finally {
    fsHolds.hold = undefined;
    hold.release.resolve(undefined);
  }

  const settled = await withTimeout(
    Promise.allSettled([
      history.flush(),
      history.setArchivedIfPresent(SESSION_ID, true),
    ]),
  );

  expect(settled).toHaveLength(2);
  const writeFailures = error.mock.calls.filter(([logged]) =>
    String(logged).includes("failed to write the session history"),
  );
  expect(writeFailures).toHaveLength(2);
});

async function metaIn(dir: string, id: string): Promise<SessionHistoryEntry> {
  const text = await readFile(join(dir, `${id}.meta.json`), "utf8");
  return JSON.parse(text) as SessionHistoryEntry;
}

it("archive_waits_only_for_its_own_session", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  recordView(history, view());
  await history.flush();

  const hold: FsHold = {
    match: OTHER_ID,
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  fsHolds.hold = hold;
  try {
    recordView(history, view({ id: OTHER_ID }));
    await hold.entered.promise;

    await withTimeout(history.setArchived(SESSION_ID, true));
  } finally {
    fsHolds.hold = undefined;
    hold.release.resolve(undefined);
    await history.flush();
  }
});

it("archive_flag_survives_concurrent_record", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  recordView(history, view());
  await history.flush();

  const archiving = history.setArchived(SESSION_ID, true);
  Array.from({ length: 8 }, (_, index) => {
    recordView(
      history,
      view({ messages: [message(`concurrent-${String(index)}`)] }),
    );
  });
  await archiving;
  await history.flush();

  expect((await metaIn(dir, SESSION_ID)).archived).toBe(true);
  expect((await storedIn(dir, SESSION_ID)).archived).toBe(true);
});

function recordView(history: SessionHistory, content: SessionView): void {
  history.record(content, []);
}

function toolCall(seq: number): ToolCallView {
  return {
    toolCallId: `tool-${String(seq)}`,
    title: "Edit",
    kind: "edit",
    status: "completed",
    seq,
  };
}

function turn(promptSeq: number): TurnRouteView {
  return {
    promptSeq,
    accountId: "acc-a",
    model: null,
    effectiveModel: null,
    apiProvider: null,
    requestedClass: TaskClass.standard,
    servedClass: null,
    source: RouteSource.routed,
  };
}

it("truncate drops seqs at and after the prompt and clears native sessions", async () => {
  const dir = await tempDir();
  const broadcasts: SessionHistoryEntry[] = [];
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: (_event, entry) => {
      broadcasts.push(entry);
    },
  });
  history.record(
    view({
      prompts: [
        { seq: 0, text: "first" },
        { seq: 2, text: "second" },
      ],
      messages: [message("reply")],
      toolCalls: [toolCall(3)],
      turns: [turn(0), turn(2)],
      lastTurn: { kind: "ended", stopReason: "end_turn" },
    }),
    [{ accountId: "acc-a", nativeSessionId: "native-1" }],
  );
  await history.flush();

  const truncated = await history.truncate(SESSION_ID, 2);

  expect(truncated?.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
  expect(truncated?.messages.map((entry) => entry.seq)).toEqual([1]);
  expect(truncated?.toolCalls).toEqual([]);
  expect(truncated?.turns.map((entry) => entry.promptSeq)).toEqual([0]);
  expect(truncated?.lastTurn).toBeNull();
  expect(truncated?.nativeSessions).toEqual([]);
  expect(truncated?.updatedAt).toBe(NOW);
  expect(broadcasts.at(-1)).toMatchObject({
    id: SESSION_ID,
    title: "first",
    updatedAt: NOW,
  });
});

it("truncate to the first prompt keeps the title", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  history.record(
    view({
      prompts: [
        { seq: 0, text: "first title" },
        { seq: 2, text: "second title" },
      ],
    }),
    [],
  );
  await history.flush();

  const truncated = await history.truncate(SESSION_ID, 0);

  expect(truncated?.prompts).toEqual([]);
  expect(truncated?.title).toBe("first title");
  const [entry] = await history.list();
  expect(entry?.title).toBe("first title");
});

it("truncate drops a pending record of the same session", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  history.record(view({ prompts: [{ seq: 0, text: "first" }] }), []);
  await history.flush();

  history.record(
    view({
      prompts: [
        { seq: 0, text: "first" },
        { seq: 2, text: "second" },
      ],
    }),
    [],
  );
  const truncated = await history.truncate(SESSION_ID, 10);

  expect(truncated?.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
  const stored = await storedIn(dir, SESSION_ID);
  expect(stored.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
});

it("stored_file_without_native_sessions_still_loads", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });
  recordView(history, view());
  await history.flush();
  const file = join(dir, `${SESSION_ID}.json`);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  delete raw.nativeSessions;
  await writeFile(file, JSON.stringify(raw));

  const loaded = await history.get(SESSION_ID);

  expect(loaded?.nativeSessions).toEqual([]);
});

it("native_ids_merged_on_record", async () => {
  const dir = await tempDir();
  const history = createSessionHistory({
    dir,
    now: () => NOW,
    broadcast: () => undefined,
  });

  history.record(view(), [{ accountId: "acc-a", nativeSessionId: "a1" }]);
  await history.flush();
  history.record(view(), [{ accountId: "acc-b", nativeSessionId: "b1" }]);
  await history.flush();

  const stored = await storedIn(dir, SESSION_ID);
  expect(stored.nativeSessions).toEqual([
    { accountId: "acc-a", nativeSessionId: "a1" },
    { accountId: "acc-b", nativeSessionId: "b1" },
  ]);
});
