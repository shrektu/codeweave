import { randomUUID } from "node:crypto";
import {
  access,
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

import { SESSIONS_DIR } from "../../src/backend/constants";
import { IpcErrorCode, RequestSchema } from "../../src/shared/protocol";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import {
  ACCOUNT_A,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import { settled } from "../fakes/settle";

const END_TURN = { type: "end", stopReason: "end_turn" } as const;
const PROMPT = "Build the history feature";
const REPLY = "History is saved.";
const SECRET_KEY = "sk-test-groq-0001";
const SECRET_LABEL = "Groq main";
const REDACTED = "[redacted:Groq main]";
const SECOND_PROMPT = "Continue with the next step";
const FOLLOW_UP = "Follow-up prompt";
const CORRUPT_META = "{not json";
const HISTORY_TIMEOUT_MS = 10_000;

vi.setConfig({ testTimeout: HISTORY_TIMEOUT_MS });

interface FsHold {
  readonly match: string;
  readonly entered: PromiseWithResolvers<undefined>;
  readonly release: PromiseWithResolvers<undefined>;
}

const fsHolds = vi.hoisted(() => ({ holds: [] as FsHold[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const index = fsHolds.holds.findIndex((hold) => to.includes(hold.match));
      if (index !== -1) {
        const [hold] = fsHolds.holds.splice(index, 1);
        if (hold !== undefined) {
          hold.entered.resolve(undefined);
          await hold.release.promise;
        }
      }
      await actual.rename(from, to);
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRigs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function rigOn(userData: string): Promise<BackendRig> {
  return openRig({ accounts: [ACCOUNT_A], userData });
}

const CLOSE_TIMEOUT_MS = 3000;
const EARLY_WRITE_MS = 1500;

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(message));
      }, CLOSE_TIMEOUT_MS);
    }),
  ]);
}

async function startAndTurn(
  rig: BackendRig,
  prompt: string = PROMPT,
  reply: string = REPLY,
): Promise<string> {
  await rig.call("session/start", startParams(rig));
  agentOf(rig).enqueue([{ type: "text", text: reply }, END_TURN]);
  const started = await rig.session();
  await rig.call("session/prompt", { sessionId: started.id, text: prompt });
  await turnEnded(rig);
  return started.id;
}

function sessionsDir(userData: string): string {
  return join(userData, SESSIONS_DIR);
}

async function storedFiles(userData: string): Promise<string[]> {
  try {
    const names = await readdir(sessionsDir(userData));
    return names.filter((name) => !name.endsWith(".tmp"));
  } catch (error: unknown) {
    console.warn("listing the stored sessions failed", error);
    return [];
  }
}

it("history_saved_and_listed_after_restart", async () => {
  const userData = await tempDir("cw-history-restart-");
  const rig = await rigOn(userData);
  const sessionId = await startAndTurn(rig);
  await rig.dispose();

  const restarted = await rigOn(userData);
  const { entries } = await restarted.call("history/list", {});

  expect(entries).toEqual([
    expect.objectContaining({
      id: sessionId,
      title: PROMPT,
      cwd: rig.cwd,
      archived: false,
    }),
  ]);
  await expect(
    access(join(sessionsDir(userData), `${sessionId}.meta.json`)),
  ).resolves.toBeUndefined();
  await expect(
    access(join(sessionsDir(userData), `${sessionId}.json`)),
  ).resolves.toBeUndefined();
});

it("session_without_prompt_writes_nothing", async () => {
  const userData = await tempDir("cw-history-empty-");
  const rig = await rigOn(userData);
  await rig.call("session/start", startParams(rig));
  await rig.dispose();

  expect(await storedFiles(userData)).toEqual([]);
});

it("resume_keeps_id_and_sends_package_once", async () => {
  const userData = await tempDir("cw-history-resume-");
  const first = await rigOn(userData);
  const sessionId = await startAndTurn(first, "Old goal", "Old reply");
  await first.dispose();

  const rig = await rigOn(userData);
  const resumed = await rig.call("session/resume", { sessionId });
  expect(resumed.id).toBe(sessionId);

  agentOf(rig).enqueue([{ type: "text", text: "Resumed reply" }, END_TURN]);
  await rig.call("session/prompt", {
    sessionId,
    text: SECOND_PROMPT,
  });
  await settled(() => {
    expect(agentOf(rig).prompts).toHaveLength(1);
  });
  await turnEnded(rig);

  const [firstPrompt] = agentOf(rig).prompts;
  expect(firstPrompt).toContain("Old goal");
  expect(firstPrompt).toContain("Old reply");
  expect(firstPrompt).toContain("## Working tree");
  expect(firstPrompt?.endsWith(SECOND_PROMPT)).toBe(true);

  await rig.call("session/prompt", { sessionId, text: FOLLOW_UP });
  await settled(() => {
    expect(agentOf(rig).prompts).toHaveLength(2);
  });
  expect(agentOf(rig).prompts[1]).toBe(FOLLOW_UP);

  const view = await rig.session();
  expect(view.prompts.map((prompt) => prompt.text)).toEqual([
    "Old goal",
    SECOND_PROMPT,
    FOLLOW_UP,
  ]);
});

it("resume_orchestrator_session_starts_orchestration", async () => {
  const userData = await tempDir("cw-history-orchestrator-");
  const first = await rigOn(userData);
  await first.call("session/start", { cwd: first.cwd, orchestrate: true });
  agentOf(first).enqueue([{ type: "text", text: REPLY }, END_TURN]);
  const started = await first.session();
  await first.call("session/prompt", { sessionId: started.id, text: PROMPT });
  await turnEnded(first);
  await first.dispose();

  const rig = await rigOn(userData);
  const resumed = await rig.call("session/resume", { sessionId: started.id });

  expect(resumed.id).toBe(started.id);
  expect(resumed.orchestrate).toBe(true);
  const [server] = agentOf(rig).newSessions[0]?.mcpServers ?? [];
  expect(server).toBeDefined();
  const snapshot = await rig.call("sessions/snapshot", {});
  expect(snapshot.flowRuns).toEqual([]);
});

it("resume_rejects_pool_session", async () => {
  const userData = await tempDir("cw-history-conflict-");
  const rig = await rigOn(userData);
  const sessionId = await startAndTurn(rig);

  await expect(rig.call("session/resume", { sessionId })).rejects.toMatchObject(
    { code: IpcErrorCode.CONFLICT },
  );

  await rig.call("session/stop", { sessionId });
  await expect(rig.call("session/resume", { sessionId })).rejects.toMatchObject(
    { code: IpcErrorCode.CONFLICT },
  );
});

it("resume_unknown_id_not_found", async () => {
  const userData = await tempDir("cw-history-unknown-");
  const rig = await rigOn(userData);

  await expect(
    rig.call("session/resume", { sessionId: randomUUID() }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
});

it("history_rejects_non_uuid_id", async () => {
  const userData = await tempDir("cw-history-uuid-");
  const invalidId = "../../escaped";

  for (const method of [
    "history/get",
    "history/archive",
    "session/resume",
  ] as const) {
    const params =
      method === "history/archive"
        ? { sessionId: invalidId, archived: true }
        : { sessionId: invalidId };
    const parsed = RequestSchema.safeParse({
      v: PROTOCOL_VERSION,
      id: "req-1",
      method,
      params,
    });
    expect(parsed.success, method).toBe(false);

    const accepted = RequestSchema.safeParse({
      v: PROTOCOL_VERSION,
      id: "req-2",
      method,
      params:
        method === "history/archive"
          ? { sessionId: randomUUID(), archived: true }
          : { sessionId: randomUUID() },
    });
    expect(accepted.success, method).toBe(true);
  }

  expect(await storedFiles(userData)).toEqual([]);
});

it("close_archives_and_restore_lists_again", async () => {
  const userData = await tempDir("cw-history-archive-");
  const rig = await rigOn(userData);
  const sessionId = await startAndTurn(rig);

  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });

  const { entries } = await rig.call("history/list", {});
  expect(entries).toEqual([
    expect.objectContaining({ id: sessionId, archived: true }),
  ]);
  await expect(
    access(join(sessionsDir(userData), `${sessionId}.json`)),
  ).resolves.toBeUndefined();
  await expect(rig.call("history/get", { sessionId })).resolves.toMatchObject({
    id: sessionId,
  });

  const restored = await rig.call("history/archive", {
    sessionId,
    archived: false,
  });
  expect(restored).toMatchObject({ id: sessionId, archived: false });
});

it("resume_unarchives_session", async () => {
  const userData = await tempDir("cw-history-unarchive-");
  const rig = await rigOn(userData);
  const sessionId = await startAndTurn(rig);
  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });

  const resumed = await rig.call("session/resume", { sessionId });
  expect(resumed.id).toBe(sessionId);

  const { entries } = await rig.call("history/list", {});
  expect(entries).toEqual([
    expect.objectContaining({ id: sessionId, archived: false }),
  ]);
});

it("history_list_skips_corrupt_file", async () => {
  const userData = await tempDir("cw-history-corrupt-");
  const rig = await rigOn(userData);
  const sessionId = await startAndTurn(rig);
  await rig.dispose();
  await mkdir(sessionsDir(userData), { recursive: true });
  await writeFile(
    join(sessionsDir(userData), `${randomUUID()}.meta.json`),
    CORRUPT_META,
  );

  const restarted = await rigOn(userData);
  const { entries } = await restarted.call("history/list", {});

  expect(entries.map((entry) => entry.id)).toEqual([sessionId]);
});

it("history_masks_account_secrets", async () => {
  const userData = await tempDir("cw-history-secret-");
  const rig = await rigOn(userData);
  await rig.call("accounts/add", {
    label: SECRET_LABEL,
    configDir: join(userData, "accounts", "groq-main"),
    provider: "opencode",
    api: {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: SECRET_KEY,
  });
  const sessionId = await startAndTurn(
    rig,
    `send the key ${SECRET_KEY}`,
    "noted",
  );
  await rig.dispose();

  const restarted = await rigOn(userData);
  const stored = await restarted.call("history/get", { sessionId });
  expect(stored.prompts.map((prompt) => prompt.text)).toEqual([
    `send the key ${REDACTED}`,
  ]);
  const raw = await readFile(
    join(sessionsDir(userData), `${sessionId}.json`),
    "utf8",
  );
  expect(raw).not.toContain(SECRET_KEY);
});

it("history_write_failure_does_not_hang", async () => {
  const userData = await tempDir("cw-history-writefail-");
  await writeFile(join(userData, SESSIONS_DIR), "blocked");
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const rig = await rigOn(userData);
  await rig.call("session/start", startParams(rig));
  const started = await rig.session();

  agentOf(rig).enqueue([{ type: "text", text: "one" }, END_TURN]);
  await rig.call("session/prompt", { sessionId: started.id, text: "first" });
  await turnEnded(rig);
  agentOf(rig).enqueue([{ type: "text", text: "two" }, END_TURN]);
  await rig.call("session/prompt", { sessionId: started.id, text: "second" });
  await settled(() => {
    expect(agentOf(rig).prompts).toHaveLength(2);
  });
  await turnEnded(rig);
  await rig.call("session/stop", { sessionId: started.id });

  await withTimeout(
    rig.call("session/close", { sessionId: started.id }),
    "session/close hung after a failed history write",
  );
  expect(error).toHaveBeenCalled();
});

it("archive_waits_only_for_its_own_session", async () => {
  const userData = await tempDir("cw-history-own-archive-");
  const rig = await rigOn(userData);
  const first = await startAndTurn(rig);
  await rig.call("session/stop", { sessionId: first });
  const secondCwd = await tempDir("cw-history-second-");
  const second = await rig.call("session/start", { cwd: secondCwd });

  const hold: FsHold = {
    match: second.id,
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  fsHolds.holds.push(hold);
  try {
    agentOf(rig, 1).enqueue([{ type: "text", text: "streaming" }, END_TURN]);
    await rig.call("session/prompt", { sessionId: second.id, text: "go" });
    await hold.entered.promise;

    await withTimeout(
      rig.call("session/close", { sessionId: first }),
      "session/close waited for another session's write",
    );
  } finally {
    fsHolds.holds.length = 0;
    hold.release.resolve(undefined);
    await turnEnded(rig);
  }
});

it("archive_flag_survives_concurrent_record", async () => {
  const userData = await tempDir("cw-history-flags-");
  const rig = await rigOn(userData);
  const sessionId = await startAndTurn(rig);
  await rig.call("session/stop", { sessionId });
  await rig.call("history/list", {});

  const metaMatch = `${sessionId}.meta.json`;
  const archiveHold: FsHold = {
    match: metaMatch,
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  const recordHold: FsHold = {
    match: metaMatch,
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  fsHolds.holds.push(archiveHold, recordHold);
  try {
    const archiving = rig.call("history/archive", {
      sessionId,
      archived: true,
    });
    await archiveHold.entered.promise;
    const stopping = rig.call("session/stop", { sessionId });
    const blockedRecord = recordHold.entered.promise.then(() => true);
    const paused = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, EARLY_WRITE_MS);
    });
    const before = rig.broadcastsOf("session/changed").length;
    const early = await Promise.race([blockedRecord, paused]);
    process.stderr.write(
      `DEBUG early=${String(early)} broadcasts ${String(before)}->${String(rig.broadcastsOf("session/changed").length)}\n`,
    );
    archiveHold.release.resolve(undefined);
    await recordHold.entered.promise;
    recordHold.release.resolve(undefined);
    await Promise.all([archiving, stopping]);
  } finally {
    fsHolds.holds.length = 0;
    archiveHold.release.resolve(undefined);
    recordHold.release.resolve(undefined);
  }
  await rig.call("history/list", {});

  const metaText = await readFile(
    join(userData, SESSIONS_DIR, `${sessionId}.meta.json`),
    "utf8",
  );
  expect((JSON.parse(metaText) as { archived: boolean }).archived).toBe(true);
  const stored = await rig.call("history/get", { sessionId });
  expect(stored.archived).toBe(true);
});
