import { MessageChannel, type MessagePort } from "node:worker_threads";

import { afterEach, expect, it, vi } from "vitest";

import { createConnectionRegistry } from "../../src/backend/connections";
import { fromNodePort } from "../../src/shared/port";
import { fakeHandlers } from "../fakes/ipcHandlers";

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    port.close();
  }
});

it("backend_drops_connection_after_reload", async () => {
  const registry = createConnectionRegistry(fakeHandlers());
  const channels = [0, 1, 2].map(() => new MessageChannel());
  for (const { port1, port2 } of channels) {
    openPorts.push(port1, port2);
    registry.connect(fromNodePort(port1));
  }
  expect(registry.size()).toBe(3);

  channels[0]?.port2.close();
  channels[1]?.port2.close();

  await vi.waitFor(() => {
    expect(registry.size()).toBe(1);
  });
  const survivor = channels[2];
  const reply = await new Promise((resolve) => {
    survivor?.port2.once("message", resolve);
    survivor?.port2.postMessage({
      v: 5,
      id: "alive",
      method: "ping",
      params: {},
    });
  });
  expect(reply).toEqual({
    v: 5,
    id: "alive",
    ok: true,
    result: { pong: true, backendPid: process.pid },
  });
});

it("push_reaches_all_clients_and_skips_closed_ports", async () => {
  const registry = createConnectionRegistry(fakeHandlers());
  const channels = [0, 1, 2].map(() => new MessageChannel());
  const received: unknown[][] = channels.map(() => []);
  for (const [index, { port1, port2 }] of channels.entries()) {
    openPorts.push(port1, port2);
    registry.connect(fromNodePort(port1));
    port2.on("message", (message) => {
      received[index]?.push(message);
    });
  }
  channels[1]?.port2.close();
  await vi.waitFor(() => {
    expect(registry.size()).toBe(2);
  });

  registry.broadcast("accounts/changed", { accounts: [] });

  const expected = {
    v: 5,
    event: "accounts/changed",
    payload: { accounts: [] },
  };
  await vi.waitFor(() => {
    expect(received[0]).toEqual([expected]);
    expect(received[2]).toEqual([expected]);
  });
  expect(received[1]).toEqual([]);
});
