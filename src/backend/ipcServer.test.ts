import { MessageChannel } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { fakeHandlers } from "../../tests/fakes/ipcHandlers";
import { fromNodePort, type PortLike } from "../shared/port";
import { IpcError, IpcErrorCode, type IpcEvent } from "../shared/protocol";

import { createIpcServer, type IpcHandlers, type IpcServer } from "./ipcServer";

const PING_REQUEST = { v: 3, id: "ok-1", method: "ping", params: {} };
const EXPECTED_MESSAGE = expect.any(String) as string;

interface Connection {
  send: (payload: unknown) => Promise<unknown>;
  server: IpcServer;
  posted: unknown[];
}

function connect(handlers: IpcHandlers): Connection {
  let deliver: (data: unknown) => void = () => undefined;
  let reply: (data: unknown) => void = () => undefined;
  const posted: unknown[] = [];
  const port: PortLike = {
    post(data: unknown): void {
      posted.push(data);
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
  const server = createIpcServer(port, handlers);
  return {
    server,
    posted,
    send: (payload: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        reply = resolve;
        deliver(payload);
      }),
  };
}

describe("createIpcServer", () => {
  it("handler_throw_becomes_internal_and_server_keeps_serving", async () => {
    const ping = vi
      .fn<IpcHandlers["ping"]>()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockReturnValue({ pong: true, backendPid: 7 });
    const { send } = connect(fakeHandlers({ ping }));

    const failed = await send({ ...PING_REQUEST, id: "a" });
    const served = await send(PING_REQUEST);

    expect(failed).toEqual({
      v: 3,
      id: "a",
      ok: false,
      error: { code: "INTERNAL", message: "boom" },
    });
    expect(served).toEqual({
      v: 3,
      id: "ok-1",
      ok: true,
      result: { pong: true, backendPid: 7 },
    });
  });

  it("async_handler_rejection_becomes_internal", async () => {
    const { send } = connect(
      fakeHandlers({ ping: () => Promise.reject(new Error("denied")) }),
    );

    const response = await send({ ...PING_REQUEST, id: "a" });

    expect(response).toEqual({
      v: 3,
      id: "a",
      ok: false,
      error: { code: "INTERNAL", message: "denied" },
    });
  });

  it.each(Object.values(IpcErrorCode))(
    "ipc_error_%s_keeps_its_code",
    async (code) => {
      const { send } = connect(
        fakeHandlers({
          ping: () => {
            throw new IpcError(code, "typed failure");
          },
        }),
      );

      const response = await send({ ...PING_REQUEST, id: "t" });

      expect(response).toEqual({
        v: 3,
        id: "t",
        ok: false,
        error: { code, message: "typed failure" },
      });
    },
  );

  it("handler_receives_the_validated_params", async () => {
    const remove = vi.fn<IpcHandlers["accounts/remove"]>(() => ({
      accounts: [],
    }));
    const { send } = connect(fakeHandlers({ "accounts/remove": remove }));

    await send({
      v: 3,
      id: "r",
      method: "accounts/remove",
      params: { id: "acc-9" },
    });

    expect(remove).toHaveBeenCalledExactlyOnceWith({ id: "acc-9" });
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
      const { send } = connect(fakeHandlers());

      const response = await send(payload);

      expect(response).toEqual({
        v: 3,
        id: null,
        ok: false,
        error: { code: "VALIDATION", message: EXPECTED_MESSAGE },
      });
    },
  );

  it("missing_id_is_validation_with_null_id", async () => {
    const { send } = connect(fakeHandlers());

    const response = await send({ v: 3, method: "ping", params: {} });

    expect(response).toEqual({
      v: 3,
      id: null,
      ok: false,
      error: { code: "VALIDATION", message: EXPECTED_MESSAGE },
    });
  });

  it("unknown_method_is_reported_with_the_request_id", async () => {
    const { send } = connect(fakeHandlers());

    const response = await send({
      v: 3,
      id: "z",
      method: "shutdown",
      params: {},
    });

    expect(response).toEqual({
      v: 3,
      id: "z",
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: EXPECTED_MESSAGE },
    });
  });

  it("unsupported_version_without_id_replies_with_null_id", async () => {
    const { send } = connect(fakeHandlers());

    const response = await send({ v: 1, method: "ping", params: {} });

    expect(response).toEqual({
      v: 3,
      id: null,
      ok: false,
      error: { code: "UNSUPPORTED_VERSION", message: EXPECTED_MESSAGE },
    });
  });

  it("wrong_param_type_is_validation_and_handler_is_not_called", async () => {
    const remove = vi.fn<IpcHandlers["accounts/remove"]>();
    const { send } = connect(fakeHandlers({ "accounts/remove": remove }));

    const response = await send({
      v: 3,
      id: "w",
      method: "accounts/remove",
      params: { id: 5 },
    });

    expect(response).toEqual({
      v: 3,
      id: "w",
      ok: false,
      error: { code: "VALIDATION", message: EXPECTED_MESSAGE },
    });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("createIpcServer push", () => {
  const event: IpcEvent = {
    v: 3,
    event: "accounts/changed",
    payload: { accounts: [] },
  };

  it("push_posts_the_event_to_the_port", () => {
    const { server, posted } = connect(fakeHandlers());

    server.push(event);

    expect(posted).toEqual([event]);
  });

  it("push_after_dispose_is_a_no_op", () => {
    const { server, posted } = connect(fakeHandlers());

    server.dispose();
    server.push(event);

    expect(posted).toEqual([]);
  });
});

describe("createIpcServer disposal", () => {
  it("ipc_server_disposes_on_port_close", async () => {
    const { port1, port2 } = new MessageChannel();
    const port = fromNodePort(port1);
    const post = vi.spyOn(port, "post");
    const slow = Promise.withResolvers<{ pong: true; backendPid: number }>();
    const ping = vi.fn<IpcHandlers["ping"]>(() => slow.promise);
    createIpcServer(port, fakeHandlers({ ping }));
    port2.postMessage({ v: 3, id: "late", method: "ping", params: {} });
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
