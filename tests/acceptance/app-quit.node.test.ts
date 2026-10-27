import { EventEmitter } from "node:events";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  createBackendShutdownPort,
  createQuitGuard,
  requestBackendShutdown,
  SHUTDOWN_TIMEOUT_MS,
  type BackendProcess,
} from "../../src/main/shutdown";

interface QuitEventRecord {
  defaultPrevented: boolean;
  preventDefault(): void;
}

class FakeBackend extends EventEmitter implements BackendProcess {
  readonly posted: unknown[] = [];
  killCalls = 0;
  private alive = true;

  postMessage(message: unknown): void {
    if (this.alive) {
      this.posted.push(message);
    }
  }

  kill(): boolean {
    this.killCalls += 1;
    this.crash();
    return true;
  }

  crash(): void {
    if (this.alive) {
      this.alive = false;
      this.emit("exit", 1);
    }
  }
}

class FakeApp extends EventEmitter {
  quitCalls = 0;
  exits = 0;

  quit(): void {
    this.quitCalls += 1;
    this.requestQuit();
  }

  requestQuit(): void {
    const event: QuitEventRecord = {
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    this.emit("before-quit", event);
    if (!event.defaultPrevented) {
      this.exits += 1;
    }
  }
}

function launch(): { app: FakeApp; backend: FakeBackend } {
  const app = new FakeApp();
  const backend = new FakeBackend();
  const port = createBackendShutdownPort(backend);
  app.on(
    "before-quit",
    createQuitGuard({
      requestShutdown: () => requestBackendShutdown(port, SHUTDOWN_TIMEOUT_MS),
      kill: () => {
        backend.kill();
      },
      quit: () => {
        app.quit();
      },
    }),
  );
  return { app, backend };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("app_quit_after_backend_crash_finishes_without_waiting_for_timeout", async () => {
  const { app, backend } = launch();
  backend.crash();

  app.requestQuit();
  await vi.advanceTimersByTimeAsync(0);

  expect(app.exits).toBe(1);
  expect(app.quitCalls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("app_quit_when_backend_crashes_during_handshake_finishes_at_once", async () => {
  const { app, backend } = launch();

  app.requestQuit();
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
  expect(app.exits).toBe(0);
  backend.crash();
  await vi.advanceTimersByTimeAsync(0);

  expect(app.exits).toBe(1);
  expect(app.quitCalls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("app_two_quits_during_handshake_kill_once_and_quit_once_after_done", async () => {
  const { app, backend } = launch();

  app.requestQuit();
  app.requestQuit();
  await vi.advanceTimersByTimeAsync(0);

  expect(app.exits).toBe(0);
  expect(backend.killCalls).toBe(0);
  expect(app.quitCalls).toBe(0);
  expect(backend.posted).toEqual([{ type: "shutdown" }]);

  backend.emit("message", { type: "shutdown-done" });
  await vi.advanceTimersByTimeAsync(0);

  expect(backend.killCalls).toBe(1);
  expect(app.quitCalls).toBe(1);
  expect(app.exits).toBe(1);
});

it("app_quit_waits_the_full_timeout_when_backend_is_silent_but_alive", async () => {
  const { app, backend } = launch();

  app.requestQuit();
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
  expect(app.exits).toBe(0);
  await vi.advanceTimersByTimeAsync(1);

  expect(backend.killCalls).toBe(1);
  expect(app.exits).toBe(1);
});
