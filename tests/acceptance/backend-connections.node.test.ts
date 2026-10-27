import { MessageChannel, type MessagePort } from "node:worker_threads";

import { afterEach, expect, it, vi } from "vitest";

import { createConnectionRegistry } from "../../src/backend/connections";
import { fromNodePort } from "../../src/shared/port";

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    port.close();
  }
});

it("backend_drops_connection_after_reload", async () => {
  const registry = createConnectionRegistry({
    ping: () => ({ pong: true, backendPid: process.pid }),
  });
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
    survivor?.port2.postMessage({ v: 1, id: "alive", method: "ping" });
  });
  expect(reply).toEqual({
    v: 1,
    id: "alive",
    ok: true,
    result: { pong: true, backendPid: process.pid },
  });
});
