import { useSyncExternalStore } from "react";

import {
  SNAPSHOT_RETRY_MS,
  SWITCH_LOG_SNAPSHOT_LIMIT,
} from "../shared/constants";
import type { IpcEvent } from "../shared/protocol";
import type {
  SessionHistoryEntry,
  Snapshot,
  StoredSession,
  SwitchLogEntryView,
} from "../shared/views";

import { errorMessage } from "./errorMessage";
import { activeSessionOf, isLiveOrchestrator, isSessionLive } from "./format";
import type { IpcClient } from "./ipc";

export interface AppState {
  connection: "connecting" | "ready" | "disconnected";
  snapshot: Snapshot | null;
  history: readonly SessionHistoryEntry[];
  historyTranscripts: Readonly<Record<string, StoredSession>>;
  error: string | null;
  activeSessionId: string | null;
  focusedRunId: string | null;
}

export interface AppStore {
  getState: () => AppState;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
  activateSession: (sessionId: string | null) => void;
  focusRun: (runId: string | null) => void;
  loadTranscript: (sessionId: string) => Promise<StoredSession | null>;
}

const INITIAL_STATE: AppState = {
  connection: "connecting",
  snapshot: null,
  history: [],
  historyTranscripts: {},
  error: null,
  activeSessionId: null,
  focusedRunId: null,
};

function initialActiveSessionId(snapshot: Snapshot): string | null {
  return (
    snapshot.sessions.findLast((session) => isSessionLive(session))?.id ??
    snapshot.sessions.at(-1)?.id ??
    null
  );
}

function activeAfter(next: AppState): string | null {
  if (next.activeSessionId === null || next.snapshot === null) {
    return next.activeSessionId;
  }
  const known =
    next.snapshot.sessions.some(
      (session) => session.id === next.activeSessionId,
    ) || next.history.some((entry) => entry.id === next.activeSessionId);
  return known ? next.activeSessionId : null;
}

function focusAfter(previous: AppState, next: AppState): string | null {
  const session = activeSessionOf(next.snapshot, next.activeSessionId);
  return previous.activeSessionId === next.activeSessionId &&
    isLiveOrchestrator(session)
    ? next.focusedRunId
    : null;
}

function applyEvent(snapshot: Snapshot, event: IpcEvent): Snapshot {
  switch (event.event) {
    case "session/changed":
      return event.payload === null
        ? snapshot
        : {
            ...snapshot,
            sessions: upsertBy(
              snapshot.sessions,
              event.payload,
              (entry) => entry.id,
            ),
          };
    case "session/removed":
      return {
        ...snapshot,
        sessions: snapshot.sessions.filter(
          (entry) => entry.id !== event.payload.sessionId,
        ),
        editedFiles: snapshot.editedFiles.filter(
          (entry) => entry.sessionId !== event.payload.sessionId,
        ),
      };
    case "accounts/changed":
      return { ...snapshot, accounts: event.payload.accounts };
    case "settings/changed":
      return { ...snapshot, settings: event.payload };
    case "terminal/changed":
      return { ...snapshot, terminal: event.payload };
    case "flow/changed":
      return {
        ...snapshot,
        flowRuns: upsertBy(
          snapshot.flowRuns,
          event.payload,
          (entry) => entry.runId,
        ),
      };
    case "flowSession/changed":
      return { ...snapshot, flowSessions: applyFlowSession(snapshot, event) };
    case "editedFiles/changed":
      return {
        ...snapshot,
        editedFiles: upsertBy(
          snapshot.editedFiles,
          event.payload,
          (entry) => entry.sessionId,
        ),
      };
    case "terminal/data":
      return snapshot;
    case "history/changed":
      return snapshot;
    case "switchLog/appended":
      return snapshot.switchLog.some(isSameSwitchEntry(event.payload))
        ? snapshot
        : {
            ...snapshot,
            switchLog: [...snapshot.switchLog, event.payload].slice(
              -SWITCH_LOG_SNAPSHOT_LIMIT,
            ),
          };
  }
}

function upsertBy<T>(
  entries: readonly T[],
  entry: T,
  keyOf: (item: T) => string,
): T[] {
  const key = keyOf(entry);
  return entries.some((existing) => keyOf(existing) === key)
    ? entries.map((existing) => (keyOf(existing) === key ? entry : existing))
    : [...entries, entry];
}

function applyHistoryEvent(
  entries: readonly SessionHistoryEntry[],
  event: IpcEvent,
): readonly SessionHistoryEntry[] {
  return event.event === "history/changed"
    ? upsertBy(entries, event.payload, (entry) => entry.id)
    : entries;
}

function withoutTranscript(
  transcripts: Readonly<Record<string, StoredSession>>,
  sessionId: string,
): Readonly<Record<string, StoredSession>> {
  if (!Object.hasOwn(transcripts, sessionId)) {
    return transcripts;
  }
  return Object.fromEntries(
    Object.entries(transcripts).filter(([id]) => id !== sessionId),
  );
}

function transcriptsAfter(
  transcripts: Readonly<Record<string, StoredSession>>,
  event: IpcEvent,
): Readonly<Record<string, StoredSession>> {
  if (event.event === "session/changed") {
    return event.payload === null
      ? transcripts
      : withoutTranscript(transcripts, event.payload.id);
  }
  if (event.event === "history/changed") {
    const cached = transcripts[event.payload.id];
    return cached !== undefined && event.payload.updatedAt > cached.updatedAt
      ? withoutTranscript(transcripts, event.payload.id)
      : transcripts;
  }
  return transcripts;
}

function mergeHistory(
  base: readonly SessionHistoryEntry[],
  newer: readonly SessionHistoryEntry[],
): SessionHistoryEntry[] {
  return newer.reduce(
    (entries, entry) => upsertBy(entries, entry, (item) => item.id),
    [...base],
  );
}

function applyFlowSession(
  snapshot: Snapshot,
  event: Extract<IpcEvent, { event: "flowSession/changed" }>,
): Snapshot["flowSessions"] {
  const { runId, view } = event.payload;
  return view === null
    ? snapshot.flowSessions.filter((entry) => entry.runId !== runId)
    : upsertBy(snapshot.flowSessions, { runId, view }, (entry) => entry.runId);
}

function streamKey(event: IpcEvent): string {
  switch (event.event) {
    case "session/changed":
      return `${event.event}:${event.payload?.id ?? "null"}`;
    case "session/removed":
      return `${event.event}:${event.payload.sessionId}`;
    case "flow/changed":
    case "flowSession/changed":
      return `${event.event}:${event.payload.runId}`;
    case "editedFiles/changed":
      return `${event.event}:${event.payload.sessionId}`;
    case "history/changed":
      return `${event.event}:${event.payload.id}`;
    default:
      return event.event;
  }
}

function isSameSwitchEntry(
  entry: SwitchLogEntryView,
): (other: SwitchLogEntryView) => boolean {
  return (other) =>
    other.at === entry.at &&
    other.sessionId === entry.sessionId &&
    other.from === entry.from &&
    other.to === entry.to &&
    other.reason === entry.reason;
}

export function bufferEvent(
  buffer: readonly IpcEvent[],
  event: IpcEvent,
): IpcEvent[] {
  if (event.event !== "switchLog/appended") {
    return [
      ...buffer.filter((kept) => streamKey(kept) !== streamKey(event)),
      event,
    ];
  }
  const appended = [...buffer, event];
  const evicted = new Set<IpcEvent>(
    appended
      .filter((kept) => kept.event === "switchLog/appended")
      .slice(0, -SWITCH_LOG_SNAPSHOT_LIMIT),
  );
  return appended.filter((kept) => !evicted.has(kept));
}

export function createAppStore(client: IpcClient): AppStore {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();

  const setState = (next: AppState): void => {
    const activeSessionId = activeAfter(next);
    const updated: AppState = { ...next, activeSessionId };
    state = { ...updated, focusedRunId: focusAfter(state, updated) };
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
    activateSession(sessionId): void {
      setState({ ...state, activeSessionId: sessionId, focusedRunId: null });
    },
    focusRun(runId): void {
      setState({ ...state, focusedRunId: runId });
    },
    async loadTranscript(sessionId: string): Promise<StoredSession | null> {
      const cached = state.historyTranscripts[sessionId];
      if (cached !== undefined) {
        return cached;
      }
      try {
        const stored = await client.request("history/get", { sessionId });
        setState({
          ...state,
          historyTranscripts: {
            ...state.historyTranscripts,
            [sessionId]: stored,
          },
        });
        return stored;
      } catch (error: unknown) {
        console.error("loading the stored session failed", error);
        return null;
      }
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    start(): () => void {
      let buffered: IpcEvent[] = [];
      let active = true;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = client.subscribe((event) => {
        const history = applyHistoryEvent(state.history, event);
        const historyTranscripts = transcriptsAfter(
          state.historyTranscripts,
          event,
        );
        if (state.snapshot === null) {
          buffered = bufferEvent(buffered, event);
          if (
            history !== state.history ||
            historyTranscripts !== state.historyTranscripts
          ) {
            setState({ ...state, history, historyTranscripts });
          }
        } else {
          const isNewLateSession =
            event.event === "session/changed" &&
            event.payload !== null &&
            state.activeSessionId === null &&
            !state.snapshot.sessions.some(
              (session) => session.id === event.payload?.id,
            );
          setState({
            ...state,
            history,
            historyTranscripts,
            snapshot: applyEvent(state.snapshot, event),
            activeSessionId: isNewLateSession
              ? (event.payload?.id ?? null)
              : state.activeSessionId,
          });
        }
      });
      const loadHistory = (): void => {
        void client
          .request("history/list", {})
          .then(({ entries }) => {
            if (active) {
              setState({
                ...state,
                history: mergeHistory(entries, state.history),
              });
            }
          })
          .catch((error: unknown) => {
            console.error("loading the session history failed", error);
          });
      };
      const load = (): void => {
        void client
          .request("sessions/snapshot", {})
          .then((snapshot) => {
            if (active) {
              const nextSnapshot = buffered.reduce(applyEvent, snapshot);
              const nextHistory = buffered.reduce(
                applyHistoryEvent,
                state.history,
              );
              const firstSnapshot = state.snapshot === null;
              setState({
                ...state,
                connection: "ready",
                snapshot: nextSnapshot,
                history: nextHistory,
                activeSessionId: firstSnapshot
                  ? initialActiveSessionId(nextSnapshot)
                  : state.activeSessionId,
                error: null,
              });
              loadHistory();
            }
          })
          .catch((error: unknown) => {
            if (active) {
              setState({
                ...state,
                connection: "disconnected",
                snapshot: null,
                error: errorMessage(error),
              });
              retryTimer = setTimeout(load, SNAPSHOT_RETRY_MS);
            }
          });
      };
      load();
      return (): void => {
        active = false;
        clearTimeout(retryTimer);
        unsubscribe();
      };
    },
  };
}

export function useAppState(store: AppStore): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
