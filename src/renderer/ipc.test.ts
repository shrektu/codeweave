import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortLike } from "../shared/port";
import type { IpcEvent } from "../shared/protocol";

import { createIpcClient, IpcRemoteError } from "./ipc";

interface FakePort {
  port: PortLike;
  emit: (data: unknown) => void;
  posted: unknown[];
}

function fakePort(): FakePort {
  const listeners = new Set<(data: unknown) => void>();
  const posted: unknown[] = [];
  const port: PortLike = {
    post(data: unknown): void {
      posted.push(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    onClose(): void {
      return;
    },
    close(): void {
      return;
    },
  };
  return {
    port,
    posted,
    emit(data: unknown): void {
      for (const listener of listeners) {
        listener(data);
      }
    },
  };
}

const SETTINGS_EVENT = {
  v: 7,
  event: "settings/changed",
  payload: {
    permissionProfile: "plan",
    effectLevel: "low",
    appearance: "system",
    claudeExecutable: null,
    codexExecutable: null,
    agyExecutable: null,
    opencodeExecutable: null,
    terminalShell: null,
    updateCheck: true,
    updateChannel: "stable",
    defaultTaskClass: "standard",
    definitionLibrary: null,
    defaultWorkspace: null,
    defaultWorkspaceResolved: "/home/user",
  },
};

describe("ipc client events", () => {
  it("client_drops_invalid_event_and_delivers_next", () => {
    const { port, emit } = fakePort();
    const client = createIpcClient(port);
    const listener = vi.fn<(event: IpcEvent) => void>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    client.subscribe(listener);

    emit({
      v: 7,
      event: "settings/changed",
      payload: { permissionProfile: "nope" },
    });
    emit(SETTINGS_EVENT);

    expect(listener).toHaveBeenCalledExactlyOnceWith(SETTINGS_EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe_stops_delivery", () => {
    const { port, emit } = fakePort();
    const client = createIpcClient(port);
    const listener = vi.fn<(event: IpcEvent) => void>();
    const unsubscribe = client.subscribe(listener);

    unsubscribe();
    emit(SETTINGS_EVENT);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ipc client requests", () => {
  it("responses_do_not_reach_event_subscribers", async () => {
    const { port, emit, posted } = fakePort();
    const client = createIpcClient(port);
    const listener = vi.fn<(event: IpcEvent) => void>();
    client.subscribe(listener);

    const pending = client.request("ping", {});
    const [sent] = posted as [{ id: string }];
    emit({
      v: 7,
      id: sent.id,
      ok: true,
      result: { pong: true, backendPid: 7 },
    });

    expect(await pending).toEqual({ pong: true, backendPid: 7 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("request_sends_params_and_rejects_with_remote_error_code", async () => {
    const { port, emit, posted } = fakePort();
    const client = createIpcClient(port);

    const pending = client.request("accounts/remove", { id: "acc-1" });
    const [sent] = posted as [{ id: string }];
    emit({
      v: 7,
      id: sent.id,
      ok: false,
      error: { code: "CONFLICT", message: "in use" },
    });

    expect(sent).toEqual({
      v: 7,
      id: expect.any(String) as string,
      method: "accounts/remove",
      params: { id: "acc-1" },
    });
    await expect(pending).rejects.toBeInstanceOf(IpcRemoteError);
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("ipc client request timeouts", () => {
  const SETKEY_PARAMS = { id: "acc-1", apiKey: "sk-test-0001-key" };

  afterEach(() => {
    vi.useRealTimers();
  });

  function rejectionCounter(promise: Promise<unknown>): () => number {
    const rejected = vi.fn();
    promise.catch(rejected);
    return () => rejected.mock.calls.length;
  }

  it("default_method_times_out_after_five_seconds", async () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    const client = createIpcClient(port);
    const rejections = rejectionCounter(client.request("ping", {}));

    await vi.advanceTimersByTimeAsync(4999);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(rejections()).toBe(1);
  });

  it("set_key_waits_past_five_seconds_and_times_out_after_130_seconds", async () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    const client = createIpcClient(port);
    const rejections = rejectionCounter(
      client.request("accounts/setKey", SETKEY_PARAMS),
    );

    await vi.advanceTimersByTimeAsync(5001);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(124_998);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(rejections()).toBe(1);
  });

  it("add_account_waits_130_seconds", async () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    const client = createIpcClient(port);
    const rejections = rejectionCounter(
      client.request("accounts/add", {
        label: "Main",
        configDir: "/cfg/main",
      }),
    );

    await vi.advanceTimersByTimeAsync(129_999);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(rejections()).toBe(1);
  });

  it("catalog_timeout_exceeds_backend_probe_budget", async () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    const client = createIpcClient(port);
    const rejections = rejectionCounter(client.request("models/catalog", {}));

    await vi.advanceTimersByTimeAsync(64_999);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(rejections()).toBe(1);
  });

  it("session_start_uses_long_timeout", async () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    const client = createIpcClient(port);
    const rejections = rejectionCounter(client.request("session/start", {}));

    await vi.advanceTimersByTimeAsync(5001);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(54_998);
    expect(rejections()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(rejections()).toBe(1);
  });
});
