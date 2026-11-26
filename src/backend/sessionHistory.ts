import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  DEFAULT_MAX_RESULT_CHARS,
  SESSION_TITLE_MAX_CHARS,
} from "../domain/constants";
import {
  buildContextPackage,
  ContextPackageReason,
} from "../domain/contextPackage";
import type { FileDiff } from "../domain/events";
import type { SessionState, ToolCallEntry } from "../domain/sessionReducer";
import type { WorktreeState } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import {
  SessionHistoryEntrySchema,
  StoredSessionSchema,
  type FileDiffView,
  type NativeSessionRef,
  type PromptView,
  type SessionHistoryEntry,
  type SessionView,
  type StoredSession,
  type ToolCallView,
} from "../shared/views";

import { replaceFileAtomically } from "./atomicFile";
import { STORAGE_VERSION } from "./constants";
import { KeyedMutex } from "./keyedMutex";
import type { ResumeSeed } from "./session";
import { readValidated, writeAtomic } from "./storage";

const SESSION_ID_SCHEMA = z.uuid();
const META_FILE_SUFFIX = ".meta.json";
const TRANSCRIPT_FILE_SUFFIX = ".json";
const MISSING_FILE_CODE = "ENOENT";
const JSON_INDENT = 2;
const INVALID_SESSION_ID_MESSAGE = "Invalid session id";
const SESSION_NOT_FOUND_MESSAGE = "Session not found";

const EntryFileSchema = SessionHistoryEntrySchema.extend({
  version: z.literal(STORAGE_VERSION),
});
const StoredFileSchema = StoredSessionSchema.extend({
  version: z.literal(STORAGE_VERSION),
});

export interface SessionHistoryDeps {
  readonly dir: string;
  readonly now: () => number;
  readonly broadcast: (
    event: "history/changed",
    entry: SessionHistoryEntry,
  ) => void;
}

export interface SessionHistory {
  record(view: SessionView, nativeSessions: readonly NativeSessionRef[]): void;
  list(): Promise<SessionHistoryEntry[]>;
  get(id: string): Promise<StoredSession | null>;
  setArchived(id: string, archived: boolean): Promise<SessionHistoryEntry>;
  setArchivedIfPresent(id: string, archived: boolean): Promise<void>;
  flush(): Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === MISSING_FILE_CODE
  );
}

function entryOf(parsed: z.infer<typeof EntryFileSchema>): SessionHistoryEntry {
  return {
    id: parsed.id,
    title: parsed.title,
    cwd: parsed.cwd,
    provider: parsed.provider,
    orchestrate: parsed.orchestrate,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    archived: parsed.archived,
  };
}

function mergeNativeSessions(
  stored: readonly NativeSessionRef[],
  current: readonly NativeSessionRef[],
): NativeSessionRef[] {
  const merged = new Map(
    stored.map((entry) => [entry.accountId, entry.nativeSessionId]),
  );
  current.forEach((entry) => {
    merged.set(entry.accountId, entry.nativeSessionId);
  });
  return [...merged].map(([accountId, nativeSessionId]) => ({
    accountId,
    nativeSessionId,
  }));
}

function titleOf(prompts: readonly PromptView[]): string {
  const [firstLine = ""] = (prompts[0]?.text ?? "").split("\n");
  const trimmed = firstLine.trim();
  return trimmed.slice(0, SESSION_TITLE_MAX_CHARS);
}

function nextSeqOf(stored: StoredSession): number {
  const seqs = [
    -1,
    ...stored.prompts.map((prompt) => prompt.seq),
    ...stored.messages.map((message) => message.seq),
    ...stored.toolCalls.map((tool) => tool.seq),
    ...stored.turns.map((turn) => turn.promptSeq),
  ];
  return Math.max(...seqs) + 1;
}

function toFileDiff(diff: FileDiffView): FileDiff {
  return "patch" in diff
    ? { path: diff.path, change: diff.change, patch: diff.patch }
    : { path: diff.path, change: diff.change, omitted: diff.omitted };
}

function toToolEntry(tool: ToolCallView): ToolCallEntry {
  return {
    toolCallId: tool.toolCallId,
    title: tool.title,
    kind: tool.kind,
    status: tool.status,
    seq: tool.seq,
    ...(tool.command === undefined ? {} : { command: tool.command }),
    ...(tool.output === undefined ? {} : { output: tool.output }),
    ...(tool.diffs === undefined ? {} : { diffs: tool.diffs.map(toFileDiff) }),
  };
}

export function buildResumeSeed(
  stored: StoredSession,
  worktree: WorktreeState,
): ResumeSeed {
  const lastPromptSeq = stored.prompts.at(-1)?.seq ?? -1;
  const toolCalls = stored.toolCalls.map(toToolEntry);
  const state: SessionState = {
    prompts: stored.prompts,
    messages: stored.messages,
    turns: stored.turns,
    toolCalls,
    turnLog: [],
    previousTurnLog: [],
    permissions: [],
    lastTurn: stored.lastTurn,
    currentModel: null,
    contextUsage: null,
    nextSeq: nextSeqOf(stored),
  };
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    state,
    nativeSessions: stored.nativeSessions,
    contextPackage: buildContextPackage({
      reason: ContextPackageReason.resume,
      userPrompts: stored.prompts.map((prompt) => prompt.text),
      lastReply: stored.messages.at(-1)?.text ?? null,
      interruptedTurn: toolCalls.filter((tool) => tool.seq > lastPromptSeq),
      worktree,
      maxResultChars: DEFAULT_MAX_RESULT_CHARS,
    }),
  };
}

class SessionHistoryImpl implements SessionHistory {
  private readonly deps: SessionHistoryDeps;
  private readonly mutex = new KeyedMutex();
  private readonly pending = new Map<
    string,
    {
      readonly view: SessionView;
      readonly nativeSessions: readonly NativeSessionRef[];
    }
  >();
  private readonly draining = new Set<string>();
  private readonly active = new Set<Promise<unknown>>();

  constructor(deps: SessionHistoryDeps) {
    this.deps = deps;
  }

  record(view: SessionView, nativeSessions: readonly NativeSessionRef[]): void {
    if (view.prompts.length === 0) {
      return;
    }
    this.pending.set(view.id, { view, nativeSessions });
    this.scheduleDrain(view.id);
  }

  async list(): Promise<SessionHistoryEntry[]> {
    await this.flush();
    const names = await readdir(this.deps.dir).catch((error: unknown) => {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    });
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(META_FILE_SUFFIX))
        .map((name) => this.readListedEntry(name)),
    );
    return entries
      .filter((entry) => entry !== null)
      .toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(id: string): Promise<StoredSession | null> {
    requireSessionId(id);
    return readValidated(this.transcriptPath(id), StoredFileSchema);
  }

  async setArchived(
    id: string,
    archived: boolean,
  ): Promise<SessionHistoryEntry> {
    const entry = await this.updateArchived(id, archived);
    if (entry === null) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, SESSION_NOT_FOUND_MESSAGE);
    }
    return entry;
  }

  async setArchivedIfPresent(id: string, archived: boolean): Promise<void> {
    await this.updateArchived(id, archived);
  }

  async flush(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
    const stranded = [...this.pending.keys()];
    if (stranded.length > 0) {
      stranded.forEach((id) => {
        this.scheduleDrain(id);
      });
      await this.flush();
    }
  }

  private async readListedEntry(
    name: string,
  ): Promise<SessionHistoryEntry | null> {
    try {
      const parsed = await readValidated(
        join(this.deps.dir, name),
        EntryFileSchema,
      );
      return parsed === null ? null : entryOf(parsed);
    } catch (error) {
      console.error(`skipping unreadable session history file ${name}`, error);
      return null;
    }
  }

  private updateArchived(
    id: string,
    archived: boolean,
  ): Promise<SessionHistoryEntry | null> {
    requireSessionId(id);
    return this.track(this.mutex.run(id, () => this.archiveStep(id, archived)));
  }

  private async archiveStep(
    id: string,
    archived: boolean,
  ): Promise<SessionHistoryEntry | null> {
    const existing = await readValidated(this.metaPath(id), EntryFileSchema);
    if (existing === null) {
      return null;
    }
    const entry = {
      ...entryOf(existing),
      archived,
      updatedAt: this.deps.now(),
    };
    await this.writeMeta(entry);
    await this.syncTranscriptArchived(entry);
    return entry;
  }

  private async syncTranscriptArchived(
    entry: SessionHistoryEntry,
  ): Promise<void> {
    const stored = await readValidated(
      this.transcriptPath(entry.id),
      StoredFileSchema,
    ).catch((error: unknown) => {
      console.error(`failed to read the transcript of ${entry.id}`, error);
      return null;
    });
    if (stored === null) {
      return;
    }
    await this.writeTranscript({
      ...stored,
      archived: entry.archived,
      updatedAt: entry.updatedAt,
    });
  }

  private scheduleDrain(id: string): void {
    if (this.draining.has(id)) {
      return;
    }
    this.draining.add(id);
    void this.track(this.mutex.run(id, () => this.drain(id)))
      .then(() => {
        this.draining.delete(id);
        if (this.pending.has(id)) {
          this.scheduleDrain(id);
        }
      })
      .catch((error: unknown) => {
        console.error("the session history write chain failed", error);
        this.draining.delete(id);
      });
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.active.add(task);
    const done = (): void => {
      this.active.delete(task);
    };
    void task.then(done).catch(done);
    return task;
  }

  private async drain(id: string): Promise<void> {
    let entry = this.pending.get(id);
    while (entry !== undefined) {
      this.pending.delete(id);
      try {
        await this.writeView(entry.view, entry.nativeSessions);
      } catch (error) {
        console.error(`failed to write the session history of ${id}`, error);
      }
      entry = this.pending.get(id);
    }
  }

  private async writeView(
    view: SessionView,
    nativeSessions: readonly NativeSessionRef[],
  ): Promise<void> {
    const existing = await readValidated(
      this.metaPath(view.id),
      EntryFileSchema,
    )
      .then((parsed) => (parsed === null ? null : entryOf(parsed)))
      .catch((error: unknown) => {
        console.error(
          `failed to read the session history of ${view.id}`,
          error,
        );
        return null;
      });
    const previous = await readValidated(
      this.transcriptPath(view.id),
      StoredFileSchema,
    ).catch((error: unknown) => {
      console.error(
        `failed to read the stored transcript of ${view.id}`,
        error,
      );
      return null;
    });
    const native = mergeNativeSessions(
      previous?.nativeSessions ?? [],
      nativeSessions,
    );
    const now = this.deps.now();
    const entry: SessionHistoryEntry = {
      id: view.id,
      title: titleOf(view.prompts),
      cwd: view.cwd,
      provider: view.provider,
      orchestrate: view.orchestrate,
      createdAt: existing?.createdAt ?? view.createdAt,
      updatedAt: now,
      archived: existing?.archived ?? false,
    };
    const stored: StoredSession = {
      version: STORAGE_VERSION,
      id: view.id,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      title: entry.title,
      cwd: view.cwd,
      explicitFolder: view.explicitFolder,
      provider: view.provider,
      profile: view.profile,
      orchestrate: view.orchestrate,
      archived: entry.archived,
      prompts: view.prompts,
      messages: view.messages,
      toolCalls: view.toolCalls,
      turns: view.turns,
      lastTurn: view.lastTurn,
      nativeSessions: native,
    };
    await this.writeTranscript(stored);
    await this.writeMeta(entry);
  }

  private async writeTranscript(stored: StoredSession): Promise<void> {
    await writeJsonFile(this.deps.dir, this.transcriptPath(stored.id), stored);
  }

  private async writeMeta(entry: SessionHistoryEntry): Promise<void> {
    await writeJsonFile(this.deps.dir, this.metaPath(entry.id), {
      version: STORAGE_VERSION,
      ...entry,
    });
    this.deps.broadcast("history/changed", entry);
  }

  private transcriptPath(id: string): string {
    return join(this.deps.dir, `${id}${TRANSCRIPT_FILE_SUFFIX}`);
  }

  private metaPath(id: string): string {
    return join(this.deps.dir, `${id}${META_FILE_SUFFIX}`);
  }
}

function requireSessionId(id: string): void {
  if (!SESSION_ID_SCHEMA.safeParse(id).success) {
    throw new IpcError(IpcErrorCode.VALIDATION, INVALID_SESSION_ID_MESSAGE);
  }
}

async function writeJsonFile(
  dir: string,
  file: string,
  value: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const text = JSON.stringify(value, null, JSON_INDENT);
  try {
    await replaceFileAtomically(file, text);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    await writeAtomic(file, text);
  }
}

export function createSessionHistory(deps: SessionHistoryDeps): SessionHistory {
  return new SessionHistoryImpl(deps);
}
