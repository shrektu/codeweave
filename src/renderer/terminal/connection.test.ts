import { afterEach, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../../shared/constants";
import type { ParamsMap, RequestMethod } from "../../shared/protocol";
import {
  createFakeIpcClient,
  makeTerminal,
  type FakeIpcClient,
} from "../../../tests/fakes/fakeIpcClient";
import {
  createFakeXtermFactory,
  type FakeXtermFactory,
} from "../../../tests/fakes/fakeXterm";

import { requestPendingClose } from "./attachments";
import { connectTerminal, type TerminalConnection } from "./connection";

const TERMINAL_ID = "term-1";
const CWD = "/home/user/project";

interface Rig {
  client: FakeIpcClient;
  fake: FakeXtermFactory;
  gates: PromiseWithResolvers<undefined>[];
  host: HTMLElement;
}

function setup(replay = ""): Rig {
  const client = createFakeIpcClient();
  const gates: PromiseWithResolvers<undefined>[] = [];
  client.on("terminal/open", async ({ cwd }) => {
    const gate = Promise.withResolvers<undefined>();
    gates.push(gate);
    await gate.promise;
    return { terminal: makeTerminal({ cwd }), replay };
  });
  client.respond("terminal/detach", { ok: true });
  client.respond("terminal/close", { closed: true });
  client.respond("terminal/ack", { ok: true });
  return {
    client,
    fake: createFakeXtermFactory(),
    gates,
    host: document.createElement("div"),
  };
}

function connect(rig: Rig): TerminalConnection {
  return connectTerminal({
    client: rig.client,
    host: rig.host,
    cwd: CWD,
    createHandle: (host) =>
      rig.fake.factory(host, {
        level: "full",
        gpuAccelerated: false,
      }),
    report: () => undefined,
  });
}

function paramsOf<M extends RequestMethod>(
  client: FakeIpcClient,
  method: M,
): ParamsMap[M][] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params as ParamsMap[M]);
}

function emitData(client: FakeIpcClient, id: string, data: string): void {
  client.emit({
    v: PROTOCOL_VERSION,
    event: "terminal/data",
    payload: { id, data },
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("hide_while_open_pending_detaches_late_terminal", async () => {
  const rig = setup();
  const connection = connect(rig);

  connection.stop();
  rig.gates[0]?.resolve(undefined);
  await settle();

  expect(paramsOf(rig.client, "terminal/detach")).toEqual([
    { id: TERMINAL_ID },
  ]);
  expect(paramsOf(rig.client, "terminal/close")).toEqual([]);
});

it("forwards_gpu_acceleration_to_terminal_handle", () => {
  const rig = setup();
  const connection = connect(rig);

  connection.setGpuAccelerated(true);

  expect(rig.fake.terminals).toHaveLength(1);
  expect(rig.fake.terminals[0]?.renderer).toBe("webgl");
});

it("close_while_open_pending_closes_late_terminal", async () => {
  const rig = setup();
  const connection = connect(rig);

  requestPendingClose(rig.client);
  connection.stop();
  rig.gates[0]?.resolve(undefined);
  await settle();

  expect(paramsOf(rig.client, "terminal/close")).toEqual([{ id: TERMINAL_ID }]);
  expect(paramsOf(rig.client, "terminal/detach")).toEqual([]);
});

it("stale_open_result_does_not_detach_newer_attachment", async () => {
  const rig = setup();
  const stale = connect(rig);
  stale.stop();
  connect(rig);

  rig.gates[0]?.resolve(undefined);
  rig.gates[1]?.resolve(undefined);
  await settle();

  expect(paramsOf(rig.client, "terminal/detach")).toEqual([]);
  expect(paramsOf(rig.client, "terminal/close")).toEqual([]);
});

it("data_before_open_result_is_not_duplicated_after_replay", async () => {
  const rig = setup("replayed");
  connect(rig);

  emitData(rig.client, TERMINAL_ID, "early");
  rig.gates[0]?.resolve(undefined);
  await settle();

  expect(rig.fake.terminals[0]?.writes).toEqual(["replayed"]);
});

it("acks_flow_while_animation_frames_are_throttled", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const rig = setup();
  connect(rig);
  rig.gates[0]?.resolve(undefined);
  await settle();

  emitData(rig.client, TERMINAL_ID, "hello");
  emitData(rig.client, TERMINAL_ID, " world");
  await settle();

  expect(paramsOf(rig.client, "terminal/ack")).toEqual([
    { id: TERMINAL_ID, chars: 11 },
  ]);
});
