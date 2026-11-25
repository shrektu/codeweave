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

  const rejected = await send({ v: 7, id: "p-1", method: "ping" });
  const next = await send({ v: 7, id: "p-2", method: "ping", params: {} });

  expect(rejected).toEqual({
    v: 7,
    id: "p-1",
    ok: false,
    error: VALIDATION_ERROR,
  });
  expect(next).toEqual({
    v: 7,
    id: "p-2",
    ok: true,
    result: { pong: true, backendPid: process.pid },
  });
});

it("ipc_rejects_blank_prompt_text", async () => {
  const send = startServer();

  const rejected = await send({
    v: 7,
    id: "p-3",
    method: "session/prompt",
    params: { sessionId: "s-1", text: "  " },
  });
  const accepted = await send({
    v: 7,
    id: "p-4",
    method: "session/prompt",
    params: { sessionId: "s-1", text: "hello" },
  });

  expect(rejected).toEqual({
    v: 7,
    id: "p-3",
    ok: false,
    error: VALIDATION_ERROR,
  });
  expect(accepted).toEqual({
    v: 7,
    id: "p-4",
    ok: true,
    result: { accepted: true },
  });
});

const TERMINAL_OK = { ok: true } as const;
const TERMINAL_HANDLERS = {
  "terminal/input": () => TERMINAL_OK,
  "terminal/resize": () => TERMINAL_OK,
  "terminal/ack": () => TERMINAL_OK,
  "terminal/detach": () => TERMINAL_OK,
  "terminal/close": () => ({ closed: true }),
} as const;

function startTerminalServer(): (payload: unknown) => Promise<unknown> {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  createIpcServer(fromNodePort(port1), fakeHandlers(TERMINAL_HANDLERS));
  return (payload) =>
    new Promise((resolve) => {
      port2.once("message", resolve);
      port2.postMessage(payload);
    });
}

const TERMINAL_REJECTED: readonly (readonly [string, unknown])[] = [
  ["terminal/open", { cwd: "", cols: 80, rows: 24 }],
  ["terminal/open", { cwd: "/tmp", cols: 1, rows: 24 }],
  ["terminal/open", { cwd: "/tmp", cols: 1001, rows: 24 }],
  ["terminal/open", { cwd: "/tmp", cols: 80, rows: 0 }],
  ["terminal/open", { cwd: "/tmp", cols: 80, rows: 501 }],
  ["terminal/open", { cwd: "/tmp", cols: 80.5, rows: 24 }],
  ["terminal/open", { cwd: "/tmp", cols: -80, rows: 24 }],
  ["terminal/open", { cwd: "/tmp", cols: Number.NaN, rows: 24 }],
  ["terminal/resize", { id: "t-1", cols: 80, rows: 0 }],
  ["terminal/resize", { id: "t-1", cols: 1001, rows: 24 }],
  ["terminal/resize", { id: "", cols: 80, rows: 24 }],
  ["terminal/input", { id: "t-1", data: "" }],
  ["terminal/input", { id: "t-1", data: "x".repeat(65537) }],
  ["terminal/input", { id: "", data: "x" }],
  ["terminal/ack", { id: "t-1", chars: 0 }],
  ["terminal/ack", { id: "t-1", chars: -5 }],
  ["terminal/ack", { id: "t-1", chars: 1.5 }],
  ["terminal/detach", { id: "" }],
  ["terminal/close", { id: "t-1", extra: true }],
];

const TERMINAL_ACCEPTED: readonly (readonly [string, unknown, unknown])[] = [
  ["terminal/resize", { id: "t-1", cols: 2, rows: 1 }, TERMINAL_OK],
  ["terminal/resize", { id: "t-1", cols: 1000, rows: 500 }, TERMINAL_OK],
  ["terminal/input", { id: "t-1", data: "x" }, TERMINAL_OK],
  ["terminal/input", { id: "t-1", data: "x".repeat(65536) }, TERMINAL_OK],
  ["terminal/ack", { id: "t-1", chars: 1 }, TERMINAL_OK],
  ["terminal/detach", { id: "t-1" }, TERMINAL_OK],
  ["terminal/close", { id: "t-1" }, { closed: true }],
];

it.each(TERMINAL_REJECTED)(
  "ipc_rejects_invalid_%s_params",
  async (method, params) => {
    const send = startTerminalServer();

    const response = await send({ v: 7, id: "t-1", method, params });

    expect(response).toEqual({
      v: 7,
      id: "t-1",
      ok: false,
      error: VALIDATION_ERROR,
    });
  },
);

it.each(TERMINAL_ACCEPTED)(
  "ipc_accepts_boundary_%s_params",
  async (method, params, result) => {
    const send = startTerminalServer();

    const response = await send({ v: 7, id: "t-2", method, params });

    expect(response).toEqual({ v: 7, id: "t-2", ok: true, result });
  },
);

it("ipc_rejects_protocol_v1", async () => {
  const send = startServer();

  const response = await send({ v: 1, id: "p-5", method: "ping", params: {} });

  expect(response).toEqual({
    v: 7,
    id: "p-5",
    ok: false,
    error: {
      code: "UNSUPPORTED_VERSION",
      message: expect.any(String) as string,
    },
  });
});
