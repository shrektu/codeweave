import { FileChange } from "../domain/events";
import type {
  EditView,
  EditedFileView,
  FileDiffView,
  SessionEditsView,
  SessionView,
  ToolCallView,
} from "../shared/views";

const KEY_SEPARATOR = "\u0000";
const MAIN_RUN_KEY = "main";
const AGENT_ORCHESTRATOR = "orchestrator";
const AGENT_SESSION = "session";
const COMPLETED_STATUS = "completed";

export interface EditedFilesTracker {
  observeMain(view: SessionView | null): void;
  observeRun(runId: string, view: SessionView | null): void;
  forget(sessionId: string): void;
  views(): readonly SessionEditsView[];
}

interface SessionState {
  readonly entries: Map<string, EditView>;
}

function sameDiff(a: FileDiffView, b: FileDiffView): boolean {
  if (a.path !== b.path || a.change !== b.change) {
    return false;
  }
  if ("patch" in a) {
    return "patch" in b && a.patch === b.patch;
  }
  return "omitted" in b && a.omitted === b.omitted;
}

function sameEdit(a: EditView, b: EditView): boolean {
  return (
    a.toolCallId === b.toolCallId &&
    a.runId === b.runId &&
    a.agent === b.agent &&
    sameDiff(a.diff, b.diff)
  );
}

function netFileChange(edits: readonly EditView[]): FileChange {
  if (edits.at(-1)?.diff.change === FileChange.deleted) {
    return FileChange.deleted;
  }
  if (edits[0]?.diff.change === FileChange.created) {
    return FileChange.created;
  }
  return FileChange.modified;
}

function buildSessionView(
  sessionId: string,
  state: SessionState,
): SessionEditsView {
  const byPath = new Map<string, EditView[]>();
  for (const edit of state.entries.values()) {
    const list = byPath.get(edit.diff.path);
    if (list === undefined) {
      byPath.set(edit.diff.path, [edit]);
    } else {
      list.push(edit);
    }
  }
  const files: EditedFileView[] = [];
  for (const [path, edits] of byPath) {
    files.push({
      path,
      change: netFileChange(edits),
      edits,
    });
  }
  return { sessionId, files };
}

function editKey(
  runId: string | null,
  toolCallId: string,
  index: number,
): string {
  return `${runId ?? MAIN_RUN_KEY}${KEY_SEPARATOR}${toolCallId}${KEY_SEPARATOR}${String(index)}`;
}

function completedDiffCalls(
  toolCalls: readonly ToolCallView[],
): readonly ToolCallView[] {
  return toolCalls.filter(
    (call) => call.status === COMPLETED_STATUS && call.diffs !== undefined,
  );
}

interface MergeEditsInput {
  readonly sessions: Map<string, SessionState>;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly agent: string;
  readonly calls: readonly ToolCallView[];
}

function replaceCallEdits(
  state: SessionState,
  call: ToolCallView,
  runId: string | null,
  agent: string,
): boolean {
  const diffs = call.diffs ?? [];
  const prefix = `${runId ?? MAIN_RUN_KEY}${KEY_SEPARATOR}${call.toolCallId}${KEY_SEPARATOR}`;
  let changed = false;
  for (const key of [...state.entries.keys()]) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const index = Number(key.slice(prefix.length));
    if (index >= diffs.length) {
      state.entries.delete(key);
      changed = true;
    }
  }
  for (const [index, diff] of diffs.entries()) {
    const key = editKey(runId, call.toolCallId, index);
    const next: EditView = { toolCallId: call.toolCallId, runId, agent, diff };
    const existing = state.entries.get(key);
    if (existing === undefined || !sameEdit(existing, next)) {
      state.entries.set(key, next);
      changed = true;
    }
  }
  return changed;
}

function mergeEdits({
  sessions,
  sessionId,
  runId,
  agent,
  calls,
}: MergeEditsInput): boolean {
  let state = sessions.get(sessionId);
  let changed = false;
  for (const call of calls) {
    const diffs = call.diffs ?? [];
    if (state === undefined) {
      if (diffs.length === 0) {
        continue;
      }
      state = { entries: new Map() };
      sessions.set(sessionId, state);
    }
    if (replaceCallEdits(state, call, runId, agent)) {
      changed = true;
    }
  }
  return changed;
}

export function createEditedFilesTracker(deps: {
  readonly ownerOf: (runId: string) => string | null;
  readonly publish: (edits: SessionEditsView) => void;
}): EditedFilesTracker {
  const sessions = new Map<string, SessionState>();
  const runOwners = new Map<string, string>();

  function resolveOwner(runId: string): string | null {
    const cached = runOwners.get(runId);
    if (cached !== undefined) {
      return cached;
    }
    const owner = deps.ownerOf(runId);
    if (owner !== null) {
      runOwners.set(runId, owner);
    }
    return owner;
  }

  function record(
    sessionId: string,
    runId: string | null,
    agent: string,
    toolCalls: readonly ToolCallView[],
  ): void {
    const calls = completedDiffCalls(toolCalls);
    if (calls.length === 0) {
      return;
    }
    if (mergeEdits({ sessions, sessionId, runId, agent, calls })) {
      const state = sessions.get(sessionId);
      if (state !== undefined) {
        deps.publish(buildSessionView(sessionId, state));
      }
    }
  }

  return {
    observeMain(view) {
      if (view !== null) {
        const agent = view.orchestrate ? AGENT_ORCHESTRATOR : AGENT_SESSION;
        record(view.id, null, agent, view.toolCalls);
      }
    },
    observeRun(runId, view) {
      if (view === null) {
        return;
      }
      const owner = resolveOwner(runId);
      if (owner !== null) {
        record(owner, runId, view.flowRef?.nodeId ?? runId, view.toolCalls);
      }
    },
    forget(sessionId) {
      sessions.delete(sessionId);
    },
    views() {
      return [...sessions]
        .filter(([, state]) => state.entries.size > 0)
        .map(([sessionId, state]) => buildSessionView(sessionId, state));
    },
  };
}
