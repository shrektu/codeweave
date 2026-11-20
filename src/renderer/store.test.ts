import { afterEach, expect, it, vi } from "vitest";

import {
  SNAPSHOT_RETRY_MS,
  SWITCH_LOG_SNAPSHOT_LIMIT,
} from "../shared/constants";
import type { IpcEvent } from "../shared/protocol";
import type { Snapshot } from "../shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowRun,
  makeSession,
  makeSettings,
  makeSnapshot,
  makeSwitchEntry,
} from "../../tests/fakes/fakeIpcClient";

import { bufferEvent, createAppStore } from "./store";

const EVENT_VERSION = 2;
const FLOOD_COUNT = 100;

afterEach(() => {
  vi.useRealTimers();
});

it("switch_log_entry_not_duplicated_on_replay", async () => {
  const client = createFakeIpcClient();
  const gate = Promise.withResolvers<Snapshot>();
  client.on("sessions/snapshot", () => gate.promise);
  const store = createAppStore(client);
  const entry = makeSwitchEntry({ at: 1_000 });
  store.start();

  client.emit({
    v: EVENT_VERSION,
    event: "switchLog/appended",
    payload: entry,
  });
  gate.resolve(makeSnapshot({ switchLog: [entry] }));
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });
  client.emit({
    v: EVENT_VERSION,
    event: "switchLog/appended",
    payload: entry,
  });

  expect(store.getState().snapshot?.switchLog).toEqual([entry]);
});

it("snapshot_failure_retries_and_bounds_buffer", async () => {
  vi.useFakeTimers();
  const client = createFakeIpcClient();
  let calls = 0;
  client.on("sessions/snapshot", () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("port closed");
    }
    return makeSnapshot();
  });
  const store = createAppStore(client);

  store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().connection).toBe("disconnected");
  expect(client.requests).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS);

  expect(client.requests).toHaveLength(2);
  expect(store.getState().connection).toBe("ready");
  expect(store.getState().error).toBeNull();
});

it("snapshot_retry_keeps_failing_until_disposed", async () => {
  vi.useFakeTimers();
  const client = createFakeIpcClient();
  client.fail("sessions/snapshot", new Error("port closed"));
  const store = createAppStore(client);
  const stop = store.start();

  await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS * 2);
  expect(client.requests).toHaveLength(3);

  stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS * 3);

  expect(client.requests).toHaveLength(3);
});

it("snapshot_failure_bounds_buffer_to_latest_state_events", () => {
  const flood: IpcEvent[] = Array.from({ length: FLOOD_COUNT }, (_, index) => ({
    v: EVENT_VERSION,
    event: "session/changed",
    payload: makeSession({ id: `sess-${index.toString()}` }),
  }));

  const buffered = flood.reduce<IpcEvent[]>(bufferEvent, []);

  expect(buffered).toEqual([flood.at(-1)]);
});

it("snapshot_failure_bounds_buffered_switch_log_entries", () => {
  const entries = Array.from(
    { length: SWITCH_LOG_SNAPSHOT_LIMIT + 5 },
    (_, index) => makeSwitchEntry({ at: index }),
  );
  const settings: IpcEvent = {
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings(),
  };

  const buffered = [
    settings,
    ...entries.map<IpcEvent>((payload) => ({
      v: EVENT_VERSION,
      event: "switchLog/appended",
      payload,
    })),
  ].reduce<IpcEvent[]>(bufferEvent, []);

  expect(buffered).toHaveLength(SWITCH_LOG_SNAPSHOT_LIMIT + 1);
  expect(buffered[0]).toEqual(settings);
  expect(buffered[1]).toEqual({
    v: EVENT_VERSION,
    event: "switchLog/appended",
    payload: entries[5],
  });
  expect(buffered.at(-1)).toEqual({
    v: EVENT_VERSION,
    event: "switchLog/appended",
    payload: entries.at(-1),
  });
});

it("snapshot_buffer_replays_in_arrival_order", () => {
  const first: IpcEvent = {
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings(),
  };
  const second: IpcEvent = {
    v: EVENT_VERSION,
    event: "accounts/changed",
    payload: { accounts: [] },
  };
  const third: IpcEvent = {
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings({ claudeExecutable: "/bin/claude" }),
  };

  expect([first, second, third].reduce<IpcEvent[]>(bufferEvent, [])).toEqual([
    second,
    third,
  ]);
});

it("store_applies_events_after_snapshot_and_notifies", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  const store = createAppStore(client);
  const listener = vi.fn<() => void>();
  store.subscribe(listener);
  store.start();
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });
  listener.mockClear();

  client.emit({
    v: EVENT_VERSION,
    event: "accounts/changed",
    payload: { accounts: [makeAccount({ label: "After" })] },
  });
  client.emit({
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings({ claudeExecutable: "/bin/claude" }),
  });

  const snapshot = store.getState().snapshot;
  expect(snapshot?.accounts.map((account) => account.label)).toEqual(["After"]);
  expect(snapshot?.settings.claudeExecutable).toBe("/bin/claude");
  expect(listener).toHaveBeenCalledTimes(2);
});

it("store_applies_flow_run_events_to_the_snapshot", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  const store = createAppStore(client);
  store.start();
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });
  const first = makeFlowRun({ runId: "run-1", status: "running" });
  const second = makeFlowRun({ runId: "run-2", cwd: "/work/other" });
  const decided = makeFlowRun({
    runId: "run-1",
    status: "awaiting_decision",
    round: 2,
  });

  client.emit({ v: EVENT_VERSION, event: "flow/changed", payload: first });
  client.emit({ v: EVENT_VERSION, event: "flow/changed", payload: second });
  expect(store.getState().snapshot?.flowRuns).toEqual([first, second]);

  client.emit({ v: EVENT_VERSION, event: "flow/changed", payload: decided });
  expect(store.getState().snapshot?.flowRuns).toEqual([decided, second]);
});

it("store_upserts_and_removes_flow_sessions_by_run_id", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  const store = createAppStore(client);
  store.start();
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });
  const idle = makeSession({ id: "node-1", turnInFlight: false });
  const busy = makeSession({ id: "node-1", turnInFlight: true });
  const other = makeSession({ id: "node-2" });

  client.emit({
    v: EVENT_VERSION,
    event: "flowSession/changed",
    payload: { runId: "run-1", view: idle },
  });
  client.emit({
    v: EVENT_VERSION,
    event: "flowSession/changed",
    payload: { runId: "run-2", view: other },
  });
  client.emit({
    v: EVENT_VERSION,
    event: "flowSession/changed",
    payload: { runId: "run-1", view: busy },
  });
  expect(store.getState().snapshot?.flowSessions).toEqual([
    { runId: "run-1", view: busy },
    { runId: "run-2", view: other },
  ]);
  expect(store.getState().snapshot?.session).toBeNull();

  client.emit({
    v: EVENT_VERSION,
    event: "flowSession/changed",
    payload: { runId: "run-1", view: null },
  });
  expect(store.getState().snapshot?.flowSessions).toEqual([
    { runId: "run-2", view: other },
  ]);
});

it("store_keeps_the_latest_buffered_event_of_every_run_before_the_snapshot", async () => {
  const client = createFakeIpcClient();
  const snapshot = Promise.withResolvers<ReturnType<typeof makeSnapshot>>();
  client.on("sessions/snapshot", () => snapshot.promise);
  const store = createAppStore(client);
  store.start();
  const first = makeFlowRun({ runId: "run-1" });
  const second = makeFlowRun({ runId: "run-2", cwd: "/work/other" });
  const firstDone = makeFlowRun({ runId: "run-1", status: "done" });
  const view = makeSession({ id: "node-2" });

  client.emit({ v: EVENT_VERSION, event: "flow/changed", payload: first });
  client.emit({ v: EVENT_VERSION, event: "flow/changed", payload: second });
  client.emit({ v: EVENT_VERSION, event: "flow/changed", payload: firstDone });
  client.emit({
    v: EVENT_VERSION,
    event: "flowSession/changed",
    payload: { runId: "run-2", view },
  });
  client.emit({
    v: EVENT_VERSION,
    event: "flowSession/changed",
    payload: { runId: "run-1", view: null },
  });
  snapshot.resolve(makeSnapshot());

  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });
  expect(store.getState().snapshot?.flowRuns).toEqual([second, firstDone]);
  expect(store.getState().snapshot?.flowSessions).toEqual([
    { runId: "run-2", view },
  ]);
});

it("store_keeps_only_the_newest_switch_log_entries", async () => {
  const client = createFakeIpcClient();
  const full = Array.from({ length: SWITCH_LOG_SNAPSHOT_LIMIT }, (_, index) =>
    makeSwitchEntry({ at: index }),
  );
  client.respond("sessions/snapshot", makeSnapshot({ switchLog: full }));
  const store = createAppStore(client);
  store.start();
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });

  client.emit({
    v: EVENT_VERSION,
    event: "switchLog/appended",
    payload: makeSwitchEntry({ at: SWITCH_LOG_SNAPSHOT_LIMIT }),
  });

  const log = store.getState().snapshot?.switchLog ?? [];
  expect(log).toHaveLength(SWITCH_LOG_SNAPSHOT_LIMIT);
  expect(log[0]?.at).toBe(1);
  expect(log.at(-1)?.at).toBe(SWITCH_LOG_SNAPSHOT_LIMIT);
});

it("store_reports_disconnected_when_snapshot_fails", async () => {
  const client = createFakeIpcClient();
  client.fail("sessions/snapshot", new Error("port closed"));
  const store = createAppStore(client);

  store.start();

  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("disconnected");
  });
  expect(store.getState().error).toBe("port closed");
  expect(store.getState().snapshot).toBeNull();
});

it("store_stop_unsubscribes_from_events", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  const store = createAppStore(client);
  const stop = store.start();
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });

  stop();
  client.emit({
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings({ claudeExecutable: "/ignored" }),
  });

  expect(store.getState().snapshot?.settings.claudeExecutable).toBeNull();
});
