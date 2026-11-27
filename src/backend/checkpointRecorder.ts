import { resolve } from "node:path";

import type { PromptView, SessionView, ToolCallView } from "../shared/views";

import type { CheckpointStore } from "./checkpointStore";
import { editKey } from "./editedFiles";
import { readStampedSnapshot, type StampedSnapshot } from "./fileSnapshot";

const MAIN_SCOPE = "main";
const RUN_SCOPE = "run";
const SCOPE_SEPARATOR = "\u0000";
const COMPLETED_STATUS = "completed";
const NO_PROMPT_SEQ = 0;

export interface CheckpointRecorder {
  observeMain(view: SessionView | null): void;
  observeRun(runId: string, view: SessionView | null): void;
  forget(sessionId: string): void;
}

interface RecorderDeps {
  readonly store: Pick<CheckpointStore, "record">;
  readonly ownerOf: (runId: string) => string | null;
  readonly readSnapshot?: (path: string) => Promise<StampedSnapshot>;
}

interface ObserveCallsInput {
  readonly scope: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly cwd: string;
  readonly calls: readonly ToolCallView[];
  readonly promptSeq: (call: ToolCallView) => number;
}

function mainScope(sessionId: string): string {
  return `${MAIN_SCOPE}${SCOPE_SEPARATOR}${sessionId}`;
}

function runScope(runId: string): string {
  return `${RUN_SCOPE}${SCOPE_SEPARATOR}${runId}`;
}

function pendingReadKey(sessionId: string, path: string): string {
  return `${sessionId}${SCOPE_SEPARATOR}${path}`;
}

function latestPromptSeq(prompts: readonly PromptView[]): number {
  let latest = NO_PROMPT_SEQ;
  for (const prompt of prompts) {
    if (prompt.seq > latest) {
      latest = prompt.seq;
    }
  }
  return latest;
}

function promptSeqBefore(
  prompts: readonly PromptView[],
  callSeq: number,
): number {
  let seq = NO_PROMPT_SEQ;
  for (const prompt of prompts) {
    if (prompt.seq < callSeq && prompt.seq > seq) {
      seq = prompt.seq;
    }
  }
  return seq;
}

class Recorder implements CheckpointRecorder {
  private readonly store: Pick<CheckpointStore, "record">;
  private readonly ownerOf: (runId: string) => string | null;
  private readonly readSnapshot: (path: string) => Promise<StampedSnapshot>;
  private readonly baselines = new Map<string, Set<string>>();
  private readonly recorded = new Map<string, Set<string>>();
  private readonly latestPrompts = new Map<string, number>();
  private readonly runOwners = new Map<string, string>();
  private readonly pendingReads = new Map<string, string>();

  constructor(deps: RecorderDeps) {
    this.store = deps.store;
    this.ownerOf = deps.ownerOf;
    this.readSnapshot = deps.readSnapshot ?? readStampedSnapshot;
  }

  observeMain(view: SessionView | null): void {
    if (view === null) {
      return;
    }
    this.latestPrompts.set(view.id, latestPromptSeq(view.prompts));
    this.observeCalls({
      scope: mainScope(view.id),
      sessionId: view.id,
      runId: null,
      cwd: view.cwd,
      calls: view.toolCalls,
      promptSeq: (call) => promptSeqBefore(view.prompts, call.seq),
    });
  }

  observeRun(runId: string, view: SessionView | null): void {
    if (view === null) {
      return;
    }
    const owner = this.resolveOwner(runId);
    if (owner === null) {
      return;
    }
    const promptSeq = this.latestPrompts.get(owner) ?? NO_PROMPT_SEQ;
    this.observeCalls({
      scope: runScope(runId),
      sessionId: owner,
      runId,
      cwd: view.cwd,
      calls: view.toolCalls,
      promptSeq: () => promptSeq,
    });
  }

  forget(sessionId: string): void {
    this.latestPrompts.delete(sessionId);
    this.baselines.delete(mainScope(sessionId));
    this.recorded.delete(sessionId);
    const prefix = `${sessionId}${SCOPE_SEPARATOR}`;
    for (const key of this.pendingReads.keys()) {
      if (key.startsWith(prefix)) {
        this.pendingReads.delete(key);
      }
    }
    for (const [runId, owner] of this.runOwners) {
      if (owner === sessionId) {
        this.baselines.delete(runScope(runId));
        this.runOwners.delete(runId);
      }
    }
  }

  private resolveOwner(runId: string): string | null {
    const known = this.runOwners.get(runId);
    if (known !== undefined) {
      return known;
    }
    const owner = this.ownerOf(runId);
    if (owner === null) {
      return null;
    }
    this.runOwners.set(runId, owner);
    return owner;
  }

  private recordedKeys(sessionId: string): Set<string> {
    const keys = this.recorded.get(sessionId);
    if (keys !== undefined) {
      return keys;
    }
    const created = new Set<string>();
    this.recorded.set(sessionId, created);
    return created;
  }

  private observeCalls(input: ObserveCallsInput): void {
    const ignored = this.baselines.get(input.scope);
    if (ignored === undefined) {
      this.baselines.set(
        input.scope,
        new Set(input.calls.map((call) => call.toolCallId)),
      );
      return;
    }
    const keys = this.recordedKeys(input.sessionId);
    for (const call of input.calls) {
      if (
        ignored.has(call.toolCallId) ||
        call.status !== COMPLETED_STATUS ||
        call.diffs === undefined
      ) {
        continue;
      }
      const promptSeq = input.promptSeq(call);
      for (const [index, diff] of call.diffs.entries()) {
        const key = editKey(input.runId, call.toolCallId, index);
        if (keys.has(key)) {
          continue;
        }
        keys.add(key);
        const path = resolve(input.cwd, diff.path);
        const readKey = pendingReadKey(input.sessionId, path);
        const previousKey = this.pendingReads.get(readKey);
        this.pendingReads.set(readKey, key);
        const read = this.readSnapshot(path);
        const settle = (): void => {
          if (this.pendingReads.get(readKey) === key) {
            this.pendingReads.delete(readKey);
          }
        };
        void read.then(settle).catch(settle);
        void this.store
          .record(input.sessionId, {
            editKey: key,
            promptSeq,
            diff: { ...diff, path },
            after: read,
            ...(previousKey === undefined ? {} : { lateReadOf: previousKey }),
          })
          .catch((error: unknown) => {
            keys.delete(key);
            console.error("a file checkpoint could not be recorded", error);
          });
      }
    }
  }
}

export function createCheckpointRecorder(
  deps: RecorderDeps,
): CheckpointRecorder {
  return new Recorder(deps);
}
