import { MessageChannel } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { fromNodePort, type PortLike } from "../shared/port";
import { createIpcServer, type IpcHandlers } from "./ipcServer";

const PING_REQUEST = { v: 1, id: "ok-1", method: "ping" };

function connect(
  handlers: IpcHandlers,
): (payload: unknown) => Promise<unknown> {
  let deliver: (data: unknown) => void = () => undefined;
  let reply: (data: unknown) => void = () => undefined;
  const port: PortLike = {
    post(data: unknown): void {
      reply(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      deliver = listener;
      return (): void => {
        deliver = () => undefined;
      };
    },
    onClose(): void {
      return;
    },
    close(): void {
      return;
    },
  };
  createIpcServer(port, handlers);
  return (payload: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      reply = resolve;
      deliver(payload);
    });
}

describe("createIpcServer", () => {
  it("handler_throw_becomes_internal_and_server_keeps_serving", async () => {
    const ping = vi
      .fn<IpcHandlers["ping"]>()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockReturnValue({ pong: true, backendPid: 7 });
    const send = connect({ ping });

    const failed = await send({ v: 1, id: "a", method: "ping" });
    const served = await send(PING_REQUEST);

    expect(failed).toEqual({
      v: 1,
      id: "a",
      ok: false,
      error: { code: "INTERNAL", message: "boom" },
    });
    expect(served).toEqual({
      v: 1,
      id: "ok-1",
      ok: true,
      result: { pong: true, backendPid: 7 },
    });
  });

  it("async_handler_rejection_becomes_internal", async () => {
    const send = connect({
      ping: () => Promise.reject(new Error("denied")),
    });

    const response = await send({ v: 1, id: "a", method: "ping" });

    expect(response).toEqual({
      v: 1,
      id: "a",
      ok: false,
      error: { code: "INTERNAL", message: "denied" },
    });
  });
});

describe("createIpcServer with malformed input", () => {
  it.each([
    ["a string", "garbage"],
    ["null", null],
    ["a number", 42],
    ["an array", []],
  ])(
    "non_object_payload_%s_is_validation_with_null_id",
    async (_label, payload) => {
      const send = connect({ ping: () => ({ pong: true, backendPid: 1 }) });

      const response = await send(payload);

      expect(response).toEqual({
        v: 1,
        id: null,
        ok: false,
        error: { code: "VALIDATION", message: expect.any(String) as string },
      });
    },
  );

  it("missing_id_is_validation_with_null_id", async () => {
    const send = connect({ ping: () => ({ pong: true, backendPid: 1 }) });

    const response = await send({ v: 1, method: "ping" });

    expect(response).toEqual({
      v: 1,
      id: null,
      ok: false,
      error: { code: "VALIDATION", message: expect.any(String) as string },
    });
  });

  it("unknown_method_is_reported_with_the_request_id", async () => {
    const send = connect({ ping: () => ({ pong: true, backendPid: 1 }) });

    const response = await send({ v: 1, id: "z", method: "shutdown" });

    expect(response).toEqual({
      v: 1,
      id: "z",
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: expect.any(String) as string },
    });
  });

  it("unsupported_version_without_id_replies_with_null_id", async () => {
    const send = connect({ ping: () => ({ pong: true, backendPid: 1 }) });

    const response = await send({ v: 2, method: "ping" });

    expect(response).toEqual({
      v: 1,
      id: null,
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: expect.any(String) as string,
      },
    });
  });
});

describe("createIpcServer disposal", () => {
  it("ipc_server_disposes_on_port_close", async () => {
    const { port1, port2 } = new MessageChannel();
    const port = fromNodePort(port1);
    const post = vi.spyOn(port, "post");
    const slow = Promise.withResolvers<{ pong: true; backendPid: number }>();
    const ping = vi.fn<IpcHandlers["ping"]>(() => slow.promise);
    createIpcServer(port, { ping });
    port2.postMessage({ v: 1, id: "late", method: "ping" });
    await vi.waitFor(() => {
      expect(ping).toHaveBeenCalledTimes(1);
    });

    port2.close();
    await vi.waitFor(() => {
      expect(port1.listenerCount("message")).toBe(0);
    });
    slow.resolve({ pong: true, backendPid: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(post).not.toHaveBeenCalled();
  });
});
