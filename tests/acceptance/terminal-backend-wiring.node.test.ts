import { afterEach, expect, it, vi } from "vitest";

import { TERMINAL_HIGH_WATERMARK_CHARS } from "../../src/backend/constants";
import {
  createBackendTerminalRig,
  type BackendTerminalRig,
  type FakePty,
  type TerminalClient,
} from "../fakes/fakeTerminal";

const COLS = 100;
const ROWS = 30;
const rigs: BackendTerminalRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

async function newRig(): Promise<BackendTerminalRig> {
  const rig = await createBackendTerminalRig();
  rigs.push(rig);
  return rig;
}

async function openTerminal(
  rig: BackendTerminalRig,
  client: TerminalClient,
): Promise<FakePty> {
  const response = await client.request("terminal/open", {
    cwd: rig.cwd,
    cols: COLS,
    rows: ROWS,
  });
  expect(response.ok).toBe(true);
  const spawn = rig.spawns[0];
  if (spawn === undefined) {
    throw new Error("the terminal did not spawn a shell");
  }
  return spawn.pty;
}

function dataReceivedBy(client: TerminalClient): string[] {
  return client.events.flatMap((event) =>
    event.event === "terminal/data" ? [event.payload.data] : [],
  );
}

it("closing_one_of_two_connections_keeps_terminal_attached", async () => {
  const rig = await newRig();
  const first = rig.connect();
  const second = rig.connect();
  const pty = await openTerminal(rig, first);
  pty.emitData("hello");
  await vi.waitFor(() => {
    expect(dataReceivedBy(second)).toEqual(["hello"]);
  });

  first.close();
  await vi.waitFor(() => {
    expect(rig.registry.size()).toBe(1);
  });
  pty.emitData("after-reload");

  await vi.waitFor(() => {
    expect(dataReceivedBy(second)).toEqual(["hello", "after-reload"]);
  });
  expect(pty.resumeCalls).toBe(0);
});

it("backend_wiring_detaches_on_last_connection_close", async () => {
  const rig = await newRig();
  const client = rig.connect();
  const pty = await openTerminal(rig, client);
  pty.emitData("a".repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
  expect(pty.paused).toBe(true);

  client.close();

  await vi.waitFor(() => {
    expect(rig.registry.size()).toBe(0);
    expect(pty.paused).toBe(false);
  });
  pty.emitData("b".repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
  expect(pty.paused).toBe(false);
  expect(pty.pauseCalls).toBe(1);
});

it("backend_shutdown_stops_terminal", async () => {
  const rig = await newRig();
  const client = rig.connect();
  const pty = await openTerminal(rig, client);

  await rig.backend.shutdown();

  expect(pty.kills).toEqual(["SIGHUP"]);
  expect(pty.hasExited()).toBe(true);
  await vi.waitFor(() => {
    expect(client.events.at(-1)).toMatchObject({
      event: "terminal/changed",
      payload: null,
    });
  });
});
