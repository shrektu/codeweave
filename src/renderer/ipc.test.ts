import { describe, expect, it, vi } from "vitest";

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
  v: 2,
  event: "settings/changed",
  payload: {
    permissionProfile: "plan",
    effectLevel: "low",
    claudeExecutable: null,
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
      v: 2,
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
      v: 2,
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
      v: 2,
      id: sent.id,
      ok: false,
      error: { code: "CONFLICT", message: "in use" },
    });

    expect(sent).toEqual({
      v: 2,
      id: expect.any(String) as string,
      method: "accounts/remove",
      params: { id: "acc-1" },
    });
    await expect(pending).rejects.toBeInstanceOf(IpcRemoteError);
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
