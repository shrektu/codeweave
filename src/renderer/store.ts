import { useSyncExternalStore } from "react";

import {
  SNAPSHOT_RETRY_MS,
  SWITCH_LOG_SNAPSHOT_LIMIT,
} from "../shared/constants";
import type { IpcEvent } from "../shared/protocol";
import type { Snapshot, SwitchLogEntryView } from "../shared/views";

import { errorMessage } from "./errorMessage";
import { isLiveOrchestrator } from "./format";
import type { IpcClient } from "./ipc";

export interface AppState {
  connection: "connecting" | "ready" | "disconnected";
  snapshot: Snapshot | null;
  error: string | null;
  focusedRunId: string | null;
}

export interface AppStore {
  getState: () => AppState;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
  focusRun: (runId: string | null) => void;
}

const INITIAL_STATE: AppState = {
  connection: "connecting",
  snapshot: null,
  error: null,
  focusedRunId: null,
};

function focusAfter(previous: AppState, next: AppState): string | null {
  const session = next.snapshot?.session ?? null;
  return previous.snapshot?.session?.id === session?.id &&
    isLiveOrchestrator(session)
    ? next.focusedRunId
    : null;
}

function applyEvent(snapshot: Snapshot, event: IpcEvent): Snapshot {
  switch (event.event) {
    case "session/changed":
      return { ...snapshot, session: event.payload };
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
    case "flow/changed":
    case "flowSession/changed":
      return `${event.event}:${event.payload.runId}`;
    case "editedFiles/changed":
      return `${event.event}:${event.payload.sessionId}`;
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
    state = { ...next, focusedRunId: focusAfter(state, next) };
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
    focusRun(runId): void {
      setState({ ...state, focusedRunId: runId });
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
        if (state.snapshot === null) {
          buffered = bufferEvent(buffered, event);
        } else {
          setState({ ...state, snapshot: applyEvent(state.snapshot, event) });
        }
      });
      const load = (): void => {
        void client
          .request("sessions/snapshot", {})
          .then((snapshot) => {
            if (active) {
              setState({
                ...state,
                connection: "ready",
                snapshot: buffered.reduce(applyEvent, snapshot),
                error: null,
              });
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
