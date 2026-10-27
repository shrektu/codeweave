import { MessageChannel, type MessagePort } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { createIpcServer } from "../../src/backend/ipcServer";
import { fromNodePort } from "../../src/shared/port";

interface Harness {
  send: (payload: unknown) => Promise<unknown>;
}

const openPorts: MessagePort[] = [];

function startServer(): Harness {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  createIpcServer(fromNodePort(port1), {
    ping: () => ({ pong: true, backendPid: process.pid }),
  });
  return {
    send: (payload: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        port2.once("message", resolve);
        port2.postMessage(payload);
      }),
  };
}

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    port.close();
  }
});

describe("ipc server over a node MessageChannel", () => {
  it("ping_returns_backend_pid", async () => {
    const { send } = startServer();

    const response = await send({ v: 1, id: "req-1", method: "ping" });

    expect(response).toEqual({
      v: 1,
      id: "req-1",
      ok: true,
      result: { pong: true, backendPid: process.pid },
    });
  });

  it("ipc_rejects_invalid_request", async () => {
    const { send } = startServer();

    const response = await send({
      v: 1,
      id: "req-2",
      method: "ping",
      extra: true,
    });

    expect(response).toEqual({
      v: 1,
      id: "req-2",
      ok: false,
      error: { code: "VALIDATION", message: expect.any(String) as string },
    });
  });

  it("ipc_rejects_unknown_protocol_version", async () => {
    const { send } = startServer();

    const response = await send({ v: 2, id: "req-3", method: "ping" });

    expect(response).toEqual({
      v: 1,
      id: "req-3",
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: expect.any(String) as string,
      },
    });
  });

  it("ipc_keeps_serving_after_error", async () => {
    const { send } = startServer();

    await send({ v: 1, id: "req-4", method: "ping", extra: true });
    await send({ v: 2, id: "req-5", method: "ping" });
    const response = await send({ v: 1, id: "req-6", method: "ping" });

    expect(response).toEqual({
      v: 1,
      id: "req-6",
      ok: true,
      result: { pong: true, backendPid: process.pid },
    });
  });
});
