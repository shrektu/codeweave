import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuitGuard,
  requestBackendShutdown,
  type ShutdownOutcome,
  type ShutdownPort,
} from "./shutdown";

const TIMEOUT_MS = 10_000;

interface FakeBackend {
  port: ShutdownPort;
  posted: unknown[];
  reply: (message: unknown) => void;
  die: () => void;
  listenerCount: () => number;
  exitListenerCount: () => number;
}

function fakeBackend(): FakeBackend {
  const listeners = new Set<(message: unknown) => void>();
  const exitListeners = new Set<() => void>();
  const posted: unknown[] = [];
  let exited = false;
  return {
    posted,
    listenerCount: () => listeners.size,
    exitListenerCount: () => exitListeners.size,
    reply(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
    die() {
      exited = true;
      for (const listener of exitListeners) {
        listener();
      }
    },
    port: {
      post(message): void {
        posted.push(message);
      },
      onMessage(listener): () => void {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
      onExit(listener): () => void {
        if (exited) {
          listener();
          return (): void => undefined;
        }
        exitListeners.add(listener);
        return (): void => {
          exitListeners.delete(listener);
        };
      },
    },
  };
}

describe("requestBackendShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves_done_when_the_backend_replies", async () => {
    const backend = fakeBackend();
    const result = requestBackendShutdown(backend.port, TIMEOUT_MS);

    backend.reply({ type: "shutdown-done" });

    expect(await result).toBe("done");
    expect(backend.posted).toEqual([{ type: "shutdown" }]);
    expect(backend.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves_timeout_when_the_backend_stays_silent", async () => {
    const backend = fakeBackend();
    const result = requestBackendShutdown(backend.port, TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await result).toBe("timeout");
    expect(backend.listenerCount()).toBe(0);
  });

  it("ignores_unrelated_messages_until_the_reply", async () => {
    const backend = fakeBackend();
    const result = requestBackendShutdown(backend.port, TIMEOUT_MS);

    backend.reply({ type: "connect" });
    backend.reply("shutdown-done");
    backend.reply(null);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    backend.reply({ type: "shutdown-done" });

    expect(await result).toBe("done");
  });

  it("shutdown_resolves_exited_when_backend_already_dead", async () => {
    const backend = fakeBackend();
    backend.die();
    const settled = vi.fn();

    void requestBackendShutdown(backend.port, TIMEOUT_MS).then(settled);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledExactlyOnceWith("exited");
    expect(vi.getTimerCount()).toBe(0);
    expect(backend.listenerCount()).toBe(0);
    expect(backend.exitListenerCount()).toBe(0);
  });

  it("shutdown_resolves_exited_when_backend_dies_during_wait", async () => {
    const backend = fakeBackend();
    const settled = vi.fn();
    void requestBackendShutdown(backend.port, TIMEOUT_MS).then(settled);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    backend.die();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledExactlyOnceWith("exited");
    expect(vi.getTimerCount()).toBe(0);
    expect(backend.listenerCount()).toBe(0);
    expect(backend.exitListenerCount()).toBe(0);
  });

  it("cleans_up_exit_listener_after_done_and_timeout", async () => {
    const done = fakeBackend();
    const doneResult = requestBackendShutdown(done.port, TIMEOUT_MS);
    done.reply({ type: "shutdown-done" });
    await doneResult;

    const silent = fakeBackend();
    const silentResult = requestBackendShutdown(silent.port, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await silentResult;

    expect(done.exitListenerCount()).toBe(0);
    expect(silent.exitListenerCount()).toBe(0);
  });
});

interface GuardHarness {
  handler: ReturnType<typeof createQuitGuard>;
  finish: (outcome: ShutdownOutcome) => void;
  requestShutdown: ReturnType<typeof vi.fn<() => Promise<ShutdownOutcome>>>;
  kill: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

function setup(): GuardHarness {
  const { promise, resolve } = Promise.withResolvers<ShutdownOutcome>();
  const requestShutdown = vi.fn(() => promise);
  const kill = vi.fn();
  const quit = vi.fn();
  return {
    handler: createQuitGuard({ requestShutdown, kill, quit }),
    finish: resolve,
    requestShutdown,
    kill,
    quit,
  };
}

describe("createQuitGuard", () => {
  it("quit_guard_prevents_second_quit_during_handshake", async () => {
    const { handler, finish, requestShutdown, kill, quit } = setup();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    handler(first);
    handler(second);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(requestShutdown).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    finish("done");
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledOnce();
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("quit_guard_lets_quit_pass_after_handshake", async () => {
    const { handler, finish, quit } = setup();
    handler({ preventDefault: vi.fn() });
    finish("exited");
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledOnce();
    });
    const final = { preventDefault: vi.fn() };

    handler(final);

    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quit_guard_quits_when_shutdown_request_rejects", async () => {
    const { handler, requestShutdown, kill, quit } = setup();
    requestShutdown.mockRejectedValueOnce(new Error("post failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledOnce();
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("quit_guard_kills_before_quitting", async () => {
    const { handler, finish, kill, quit } = setup();
    const order: string[] = [];
    kill.mockImplementation(() => order.push("kill"));
    quit.mockImplementation(() => order.push("quit"));

    handler({ preventDefault: vi.fn() });
    finish("timeout");
    await vi.waitFor(() => {
      expect(order).toEqual(["kill", "quit"]);
    });
  });
});
