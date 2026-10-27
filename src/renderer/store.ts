import { useSyncExternalStore } from "react";

import {
  SNAPSHOT_RETRY_MS,
  SWITCH_LOG_SNAPSHOT_LIMIT,
} from "../shared/constants";
import type { IpcEvent } from "../shared/protocol";
import type { Snapshot, SwitchLogEntryView } from "../shared/views";

import { errorMessage } from "./errorMessage";
import type { IpcClient } from "./ipc";

export interface AppState {
  connection: "connecting" | "ready" | "disconnected";
  snapshot: Snapshot | null;
  error: string | null;
}

export interface AppStore {
  getState: () => AppState;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
}

const INITIAL_STATE: AppState = {
  connection: "connecting",
  snapshot: null,
  error: null,
};

function applyEvent(snapshot: Snapshot, event: IpcEvent): Snapshot {
  switch (event.event) {
    case "session/changed":
      return { ...snapshot, session: event.payload };
    case "accounts/changed":
      return { ...snapshot, accounts: event.payload.accounts };
    case "settings/changed":
      return { ...snapshot, settings: event.payload };
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
    return [...buffer.filter((kept) => kept.event !== event.event), event];
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
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
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
                connection: "ready",
                snapshot: buffered.reduce(applyEvent, snapshot),
                error: null,
              });
            }
          })
          .catch((error: unknown) => {
            if (active) {
              setState({
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
