import type { EventEmitter } from "node:events";

import { SHUTDOWN_MESSAGE_TYPE } from "../shared/constants";
import {
  ShutdownDoneMessageSchema,
  type ShutdownMessage,
} from "../shared/protocol";

export const SHUTDOWN_TIMEOUT_MS = 10_000;

const MESSAGE_EVENT = "message";
const EXIT_EVENT = "exit";

export type ShutdownOutcome = "done" | "timeout" | "exited";

export interface ShutdownPort {
  post(message: ShutdownMessage): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
}

export interface BackendProcess extends EventEmitter {
  postMessage(message: ShutdownMessage): void;
}

export interface QuitGuardDeps {
  requestShutdown: () => Promise<ShutdownOutcome>;
  kill: () => void;
  quit: () => void;
}

export interface QuitEvent {
  preventDefault(): void;
}

const QuitState = {
  idle: "idle",
  pending: "pending",
  done: "done",
} as const;
type QuitState = (typeof QuitState)[keyof typeof QuitState];

export function createBackendShutdownPort(
  backend: BackendProcess,
): ShutdownPort {
  let exited = false;
  backend.once(EXIT_EVENT, () => {
    exited = true;
  });
  return {
    post: (message) => {
      backend.postMessage(message);
    },
    onMessage: (listener) => {
      backend.on(MESSAGE_EVENT, listener);
      return (): void => {
        backend.off(MESSAGE_EVENT, listener);
      };
    },
    onExit: (listener) => {
      if (exited) {
        listener();
        return (): void => undefined;
      }
      backend.once(EXIT_EVENT, listener);
      return (): void => {
        backend.off(EXIT_EVENT, listener);
      };
    },
  };
}

export async function requestBackendShutdown(
  port: ShutdownPort,
  timeoutMs: number,
): Promise<ShutdownOutcome> {
  const { promise, resolve } = Promise.withResolvers<ShutdownOutcome>();
  const stopListening = port.onMessage((message) => {
    if (ShutdownDoneMessageSchema.safeParse(message).success) {
      resolve("done");
    }
  });
  const stopWatchingExit = port.onExit(() => {
    resolve("exited");
  });
  const timer = setTimeout(() => {
    resolve("timeout");
  }, timeoutMs);
  port.post({ type: SHUTDOWN_MESSAGE_TYPE });
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    stopListening();
    stopWatchingExit();
  }
}

export function createQuitGuard({
  requestShutdown,
  kill,
  quit,
}: QuitGuardDeps): (event: QuitEvent) => void {
  let state: QuitState = QuitState.idle;
  return (event) => {
    if (state === QuitState.done) {
      return;
    }
    event.preventDefault();
    if (state === QuitState.pending) {
      return;
    }
    state = QuitState.pending;
    void requestShutdown()
      .catch((error: unknown) => {
        console.error("backend shutdown request failed", error);
      })
      .finally(() => {
        state = QuitState.done;
        kill();
        quit();
      });
  };
}
