import { describe, expect, it } from "vitest";

import { NOTIFICATION_CLICKED_CHANNEL } from "../shared/constants";
import type { DesktopNotification } from "../shared/notifications";

import {
  desktopNotificationOf,
  showDesktopNotification,
  type DesktopNotificationDeps,
  type NotificationEvent,
  type NotificationHandle,
} from "./desktopNotifications";

const NOTIFICATION: DesktopNotification = {
  title: "Agent finished",
  body: "Fix the login bug",
  target: { kind: "session", sessionId: "sess-1" },
};

interface Rig {
  readonly deps: DesktopNotificationDeps;
  readonly calls: string[];
  readonly sent: { channel: string; payload: unknown }[];
  readonly created: { title: string; body: string }[];
  readonly live: Set<NotificationHandle>;
  click(): void;
  emit(event: NotificationEvent): void;
}

function makeRig(
  options: { supported?: boolean; focused?: boolean; minimized?: boolean } = {},
): Rig {
  const { supported = true, focused = false, minimized = false } = options;
  const calls: string[] = [];
  const sent: { channel: string; payload: unknown }[] = [];
  const created: { title: string; body: string }[] = [];
  const listeners = new Map<NotificationEvent, () => void>();
  const live = new Set<NotificationHandle>();
  return {
    calls,
    sent,
    created,
    live,
    click: () => {
      listeners.get("click")?.();
    },
    emit: (event) => {
      listeners.get(event)?.();
    },
    deps: {
      live,
      isSupported: () => supported,
      create: (notificationOptions) => {
        created.push(notificationOptions);
        return {
          on: (event, listener) => {
            listeners.set(event, listener);
          },
          show: () => {
            calls.push("notification.show");
          },
        };
      },
      window: {
        isFocused: () => focused,
        isMinimized: () => minimized,
        restore: () => {
          calls.push("restore");
        },
        show: () => {
          calls.push("show");
        },
        focus: () => {
          calls.push("focus");
        },
        webContents: {
          send: (channel, payload) => {
            sent.push({ channel, payload });
          },
        },
      },
    },
  };
}

describe("showDesktopNotification", () => {
  it("focused_window_shows_no_notification", () => {
    const rig = makeRig({ focused: true });

    showDesktopNotification(rig.deps, NOTIFICATION);

    expect(rig.created).toEqual([]);
    expect(rig.calls).toEqual([]);
  });

  it("unsupported_platform_shows_no_notification", () => {
    const rig = makeRig({ supported: false });

    showDesktopNotification(rig.deps, NOTIFICATION);

    expect(rig.created).toEqual([]);
    expect(rig.calls).toEqual([]);
  });

  it("unfocused_window_shows_notification_with_title_and_body", () => {
    const rig = makeRig();

    showDesktopNotification(rig.deps, NOTIFICATION);

    expect(rig.created).toEqual([
      { title: "Agent finished", body: "Fix the login bug" },
    ]);
    expect(rig.calls).toEqual(["notification.show"]);
  });

  it("click_focuses_window_and_sends_target", () => {
    const rig = makeRig();
    showDesktopNotification(rig.deps, NOTIFICATION);

    rig.click();

    expect(rig.calls).toEqual(["notification.show", "show", "focus"]);
    expect(rig.sent).toEqual([
      {
        channel: NOTIFICATION_CLICKED_CHANNEL,
        payload: { kind: "session", sessionId: "sess-1" },
      },
    ]);
  });

  it("click_restores_minimized_window", () => {
    const rig = makeRig({ minimized: true });
    showDesktopNotification(rig.deps, NOTIFICATION);

    rig.click();

    expect(rig.calls).toEqual([
      "notification.show",
      "restore",
      "show",
      "focus",
    ]);
  });
});

describe("retention", () => {
  it("shown_notification_is_retained_until_closed", () => {
    const rig = makeRig();

    showDesktopNotification(rig.deps, NOTIFICATION);
    expect(rig.live.size).toBe(1);

    rig.emit("close");

    expect(rig.live.size).toBe(0);
  });

  it("clicked_notification_is_released", () => {
    const rig = makeRig();
    showDesktopNotification(rig.deps, NOTIFICATION);

    rig.click();

    expect(rig.live.size).toBe(0);
  });

  it("failed_notification_is_released", () => {
    const rig = makeRig();
    showDesktopNotification(rig.deps, NOTIFICATION);

    rig.emit("failed");

    expect(rig.live.size).toBe(0);
  });

  it("suppressed_notification_is_not_retained", () => {
    const rig = makeRig({ focused: true });

    showDesktopNotification(rig.deps, NOTIFICATION);

    expect(rig.live.size).toBe(0);
  });
});

describe("desktopNotificationOf", () => {
  it("accepts_a_session_notification", () => {
    expect(desktopNotificationOf(NOTIFICATION)).toEqual(NOTIFICATION);
  });

  it("accepts_a_flow_run_notification", () => {
    const flowRun: DesktopNotification = {
      title: "Flow finished",
      body: "Ship it",
      target: { kind: "flowRun", runId: "run-1" },
    };

    expect(desktopNotificationOf(flowRun)).toEqual(flowRun);
  });

  it.each([
    ["undefined", undefined],
    ["string", "Agent finished"],
    ["missing target", { title: "a", body: "b" }],
    [
      "unknown target kind",
      { title: "a", body: "b", target: { kind: "other", id: "x" } },
    ],
    [
      "empty session id",
      { title: "a", body: "b", target: { kind: "session", sessionId: "" } },
    ],
    ["extra field", { ...NOTIFICATION, extra: true }],
    ["non-string body", { ...NOTIFICATION, body: 5 }],
  ])("invalid_notification_payload_is_ignored: %s", (_label, value) => {
    expect(desktopNotificationOf(value)).toBeNull();
  });
});
