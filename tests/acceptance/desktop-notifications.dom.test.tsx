import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { SettingsDialog } from "../../src/renderer/components/SettingsDialog";
import { createAppStore, type AppStore } from "../../src/renderer/store";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import type {
  DesktopNotification,
  NotificationTarget,
} from "../../src/shared/notifications";
import type {
  FlowRunView,
  SessionView,
  SettingsView,
  Snapshot,
} from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeFlowRun,
  makeFlowsList,
  makePermission,
  makePrompt,
  makeSession,
  makeSettings,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const WAIT_OPTIONS = { timeout: 5000 } as const;
const FIRST_TITLE = "Fix the login bug";
const SECOND_TITLE = "Write the release notes";
const ENDED = { kind: "ended", stopReason: "end_turn" } as const;
const CANCELLED = { kind: "ended", stopReason: "cancelled" } as const;

interface Rig {
  readonly client: FakeIpcClient;
  readonly store: AppStore;
  readonly notify: ReturnType<
    typeof vi.fn<(notification: DesktopNotification) => Promise<void>>
  >;
  click(target: NotificationTarget): void;
}

function running(id: string, title: string): SessionView {
  return makeSession({
    id,
    turnInFlight: true,
    prompts: [makePrompt({ text: title })],
  });
}

function ended(
  session: SessionView,
  lastTurn: SessionView["lastTurn"],
): SessionView {
  return { ...session, turnInFlight: false, lastTurn };
}

async function mount(
  options: {
    sessions?: SessionView[];
    flowRuns?: FlowRunView[];
    flowSessions?: Snapshot["flowSessions"];
    settings?: SettingsView;
  } = {},
): Promise<Rig> {
  const notify = vi.fn<(notification: DesktopNotification) => Promise<void>>(
    () => Promise.resolve(),
  );
  const clickListeners = new Set<(target: NotificationTarget) => void>();
  window.codeweave = makeCodeweaveApi({
    notify,
    onNotificationClicked: (listener) => {
      clickListeners.add(listener);
      return () => {
        clickListeners.delete(listener);
      };
    },
  });
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      sessions: options.sessions ?? [],
      flowRuns: options.flowRuns ?? [],
      flowSessions: options.flowSessions ?? [],
      settings: options.settings ?? makeSettings(),
    }),
  );
  client.respond("flows/list", makeFlowsList());
  const store = createAppStore(client);
  renderWithServices(<App />, client, store);
  await waitFor(() => {
    expect(store.getState().snapshot).not.toBeNull();
  }, WAIT_OPTIONS);
  return {
    client,
    store,
    notify,
    click: (target) => {
      act(() => {
        for (const listener of clickListeners) {
          listener(target);
        }
      });
    },
  };
}

function emitSession(client: FakeIpcClient, session: SessionView): void {
  act(() => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "session/changed",
      payload: session,
    });
  });
}

function emitFlowRun(client: FakeIpcClient, run: FlowRunView): void {
  act(() => {
    client.emit({ v: PROTOCOL_VERSION, event: "flow/changed", payload: run });
  });
}

function emitSettings(client: FakeIpcClient, settings: SettingsView): void {
  act(() => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "settings/changed",
      payload: settings,
    });
  });
}

function emitFlowSession(
  client: FakeIpcClient,
  runId: string,
  view: SessionView,
): void {
  act(() => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "flowSession/changed",
      payload: { runId, view },
    });
  });
}

function sessionTarget(sessionId: string): NotificationTarget {
  return { kind: "session", sessionId };
}

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

it("turn_end_in_background_notifies", async () => {
  const session = running("sess-1", FIRST_TITLE);
  const rig = await mount({ sessions: [session] });

  emitSession(rig.client, ended(session, ENDED));

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Agent finished",
        body: FIRST_TITLE,
        target: sessionTarget("sess-1"),
      },
    ],
  ]);
});

it("turn_failure_notifies", async () => {
  const session = running("sess-1", FIRST_TITLE);
  const rig = await mount({ sessions: [session] });

  emitSession(rig.client, ended(session, { kind: "failed", message: "boom" }));

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Agent stopped with an error",
        body: FIRST_TITLE,
        target: sessionTarget("sess-1"),
      },
    ],
  ]);
});

it("user_cancel_sends_no_notification", async () => {
  const cancelled = running("sess-1", FIRST_TITLE);
  const control = running("sess-2", SECOND_TITLE);
  const rig = await mount({ sessions: [cancelled, control] });

  emitSession(rig.client, ended(cancelled, CANCELLED));
  emitSession(rig.client, ended(control, ENDED));

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Agent finished",
        body: SECOND_TITLE,
        target: sessionTarget("sess-2"),
      },
    ],
  ]);
});

it("approval_request_notifies", async () => {
  const session = running("sess-1", FIRST_TITLE);
  const rig = await mount({ sessions: [session] });

  emitSession(rig.client, {
    ...session,
    permissions: [makePermission({ requestId: "req-7" })],
  });

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Approval needed",
        body: FIRST_TITLE,
        target: sessionTarget("sess-1"),
      },
    ],
  ]);
});

it("flow_run_outcomes_notify", async () => {
  const shipped = makeFlowRun({ runId: "run-1", flowTitle: "Ship it" });
  const audit = makeFlowRun({ runId: "run-2", flowTitle: "Audit" });
  const refactor = makeFlowRun({ runId: "run-3", flowTitle: "Refactor" });
  const idle = makeFlowRun({ runId: "run-4", flowTitle: "Idle flow" });
  const rig = await mount({ flowRuns: [shipped, audit, refactor, idle] });

  emitFlowRun(rig.client, { ...shipped, status: "done" });
  emitFlowRun(rig.client, { ...audit, status: "failed" });
  emitFlowRun(rig.client, { ...refactor, status: "awaiting_decision" });
  emitFlowRun(rig.client, { ...idle, status: "stopped" });

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Flow finished",
        body: "Ship it",
        target: { kind: "flowRun", runId: "run-1" },
      },
    ],
    [
      {
        title: "Flow failed",
        body: "Audit",
        target: { kind: "flowRun", runId: "run-2" },
      },
    ],
    [
      {
        title: "Decision needed",
        body: "Refactor",
        target: { kind: "flowRun", runId: "run-3" },
      },
    ],
  ]);
});

it("background_flow_node_approval_notifies", async () => {
  const run = makeFlowRun({ runId: "run-1", flowTitle: "Ship it" });
  const node = makeSession({ id: "node-1", turnInFlight: true });
  const rig = await mount({
    flowRuns: [run],
    flowSessions: [{ runId: "run-1", view: node }],
  });

  emitFlowSession(rig.client, "run-1", {
    ...node,
    permissions: [makePermission({ requestId: "req-9" })],
  });

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Approval needed",
        body: "Ship it",
        target: { kind: "flowRun", runId: "run-1" },
      },
    ],
  ]);
});

it("notifications_setting_off_sends_nothing", async () => {
  const session = running("sess-1", FIRST_TITLE);
  const control = running("sess-2", SECOND_TITLE);
  const rig = await mount({
    sessions: [session, control],
    settings: makeSettings({ notifications: false }),
  });

  emitSession(rig.client, ended(session, ENDED));
  emitSettings(rig.client, makeSettings({ notifications: true }));
  emitSession(rig.client, ended(control, ENDED));

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Agent finished",
        body: SECOND_TITLE,
        target: sessionTarget("sess-2"),
      },
    ],
  ]);
});

it("first_snapshot_sends_no_notification_burst", async () => {
  const finished = ended(running("sess-1", FIRST_TITLE), ENDED);
  const waiting = {
    ...running("sess-2", SECOND_TITLE),
    permissions: [makePermission()],
  };
  const rig = await mount({
    sessions: [finished, waiting],
    flowRuns: [makeFlowRun({ runId: "run-1", status: "done" })],
  });
  expect(rig.notify).not.toHaveBeenCalled();

  emitSession(rig.client, ended({ ...waiting, permissions: [] }, ENDED));

  expect(rig.notify.mock.calls).toEqual([
    [
      {
        title: "Agent finished",
        body: SECOND_TITLE,
        target: sessionTarget("sess-2"),
      },
    ],
  ]);
});

it("clicked_session_notification_activates_session", async () => {
  const first = running("sess-1", FIRST_TITLE);
  const second = running("sess-2", SECOND_TITLE);
  const rig = await mount({ sessions: [first, second] });
  await waitFor(() => {
    expect(rig.store.getState().activeSessionId).toBe("sess-2");
  }, WAIT_OPTIONS);

  rig.click(sessionTarget("sess-1"));

  expect(rig.store.getState().activeSessionId).toBe("sess-1");
});

it("clicked_flow_run_notification_opens_flow_tab", async () => {
  const rig = await mount({ flowRuns: [makeFlowRun({ runId: "run-1" })] });
  const sessionTab = await screen.findByRole("tab", { name: "Session" });
  expect(sessionTab.getAttribute("aria-selected")).toBe("true");

  rig.click({ kind: "flowRun", runId: "run-1" });

  expect(
    screen.getByRole("tab", { name: "Flow" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("settings_dialog_toggles_notifications", async () => {
  const client = createFakeIpcClient();
  const settings = makeSettings({ notifications: true });
  client.respond("sessions/snapshot", makeSnapshot({ settings }));
  client.on("settings/set", () => settings);
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  const checkbox = await screen.findByRole("checkbox", {
    name: "Show desktop notifications when an agent finishes or needs approval in the background",
  });
  expect(checkbox).toHaveProperty("checked", true);
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { notifications: false },
    });
  });
});
