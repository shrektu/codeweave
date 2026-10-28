import { MessageChannel, type MessagePort } from "node:worker_threads";

import { afterEach, expect, it } from "vitest";

import { createIpcServer } from "../../src/backend/ipcServer";
import { fromNodePort } from "../../src/shared/port";
import { fakeHandlers } from "../fakes/ipcHandlers";

const openPorts: MessagePort[] = [];

function startServer(): (payload: unknown) => Promise<unknown> {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  createIpcServer(
    fromNodePort(port1),
    fakeHandlers({ "session/prompt": () => ({ accepted: true }) }),
  );
  return (payload) =>
    new Promise((resolve) => {
      port2.once("message", resolve);
      port2.postMessage(payload);
    });
}

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    port.close();
  }
});

const VALIDATION_ERROR = {
  code: "VALIDATION",
  message: expect.any(String) as string,
};

it("ipc_rejects_missing_params_and_keeps_serving", async () => {
  const send = startServer();

  const rejected = await send({ v: 2, id: "p-1", method: "ping" });
  const next = await send({ v: 2, id: "p-2", method: "ping", params: {} });

  expect(rejected).toEqual({
    v: 2,
    id: "p-1",
    ok: false,
    error: VALIDATION_ERROR,
  });
  expect(next).toEqual({
    v: 2,
    id: "p-2",
    ok: true,
    result: { pong: true, backendPid: process.pid },
  });
});

it("ipc_rejects_blank_prompt_text", async () => {
  const send = startServer();

  const rejected = await send({
    v: 2,
    id: "p-3",
    method: "session/prompt",
    params: { text: "  " },
  });
  const accepted = await send({
    v: 2,
    id: "p-4",
    method: "session/prompt",
    params: { text: "hello" },
  });

  expect(rejected).toEqual({
    v: 2,
    id: "p-3",
    ok: false,
    error: VALIDATION_ERROR,
  });
  expect(accepted).toEqual({
    v: 2,
    id: "p-4",
    ok: true,
    result: { accepted: true },
  });
});

it("ipc_rejects_protocol_v1", async () => {
  const send = startServer();

  const response = await send({ v: 1, id: "p-5", method: "ping", params: {} });

  expect(response).toEqual({
    v: 2,
    id: "p-5",
    ok: false,
    error: {
      code: "UNSUPPORTED_VERSION",
      message: expect.any(String) as string,
    },
  });
});
