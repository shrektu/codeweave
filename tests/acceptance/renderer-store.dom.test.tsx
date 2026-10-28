import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { EffectLevel } from "../../src/domain/types";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { SwitchLog } from "../../src/renderer/components/SwitchLog";
import { createAppStore } from "../../src/renderer/store";
import { SNAPSHOT_RETRY_MS } from "../../src/shared/constants";
import type { Snapshot } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeSession,
  makeSettings,
  makeSnapshot,
  makeSwitchEntry,
  renderWithServices,
} from "../fakes/fakeIpcClient";

const EVENT_VERSION = 2;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("switch_log_entry_not_duplicated_on_replay_in_ui", async () => {
  const client = createFakeIpcClient();
  const entry = makeSwitchEntry({ at: 1_000 });
  client.on("sessions/snapshot", () => {
    client.emit({
      v: EVENT_VERSION,
      event: "switchLog/appended",
      payload: entry,
    });
    return makeSnapshot({ switchLog: [entry] });
  });

  renderWithServices(<SwitchLog />, client);

  await vi.waitFor(() => {
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

it("snapshot_failure_retries_and_bounds_buffer_in_ui", async () => {
  vi.useFakeTimers();
  const client = createFakeIpcClient();
  let calls = 0;
  client.on("sessions/snapshot", () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("port closed");
    }
    return makeSnapshot({
      accounts: [makeAccount({ label: "Recovered" })],
    });
  });

  renderWithServices(
    <Sidebar onManageAccounts={vi.fn<() => void>()} />,
    client,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.queryByText("Recovered")).toBeNull();

  await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS);

  expect(screen.getByText("Recovered")).toBeTruthy();
  expect(client.requests).toHaveLength(2);
});

it("store_replays_events_received_before_snapshot", async () => {
  const client = createFakeIpcClient();
  const gate = Promise.withResolvers<Snapshot>();
  client.on("sessions/snapshot", () => gate.promise);
  const store = createAppStore(client);
  const entryFromSnapshot = makeSwitchEntry({ at: 1_000 });
  const entryFromEvent = makeSwitchEntry({ at: 2_000 });
  const eventSession = makeSession({ id: "sess-from-event" });
  const eventAccounts = [makeAccount({ id: "acc-event", label: "Event" })];

  store.start();
  client.emit({
    v: EVENT_VERSION,
    event: "switchLog/appended",
    payload: entryFromEvent,
  });
  client.emit({
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings({ effectLevel: EffectLevel.low }),
  });
  client.emit({
    v: EVENT_VERSION,
    event: "settings/changed",
    payload: makeSettings({ effectLevel: EffectLevel.full }),
  });
  client.emit({
    v: EVENT_VERSION,
    event: "accounts/changed",
    payload: { accounts: eventAccounts },
  });
  client.emit({
    v: EVENT_VERSION,
    event: "session/changed",
    payload: eventSession,
  });

  expect(store.getState().connection).toBe("connecting");
  expect(store.getState().snapshot).toBeNull();

  gate.resolve(makeSnapshot({ switchLog: [entryFromSnapshot] }));
  await vi.waitFor(() => {
    expect(store.getState().connection).toBe("ready");
  });

  const snapshot = store.getState().snapshot;
  expect(snapshot?.switchLog).toEqual([entryFromSnapshot, entryFromEvent]);
  expect(snapshot?.settings.effectLevel).toBe(EffectLevel.full);
  expect(snapshot?.accounts).toEqual(eventAccounts);
  expect(snapshot?.session).toEqual(eventSession);
});
