import { NOTIFICATION_CLICKED_CHANNEL } from "../shared/constants";
import {
  DesktopNotificationSchema,
  type DesktopNotification,
} from "../shared/notifications";

export type NotificationEvent = "click" | "close" | "failed";

export interface NotificationHandle {
  on: (event: NotificationEvent, listener: () => void) => void;
  show: () => void;
}

export interface NotificationWindow {
  isFocused: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  webContents: { send: (channel: string, payload: unknown) => void };
}

export interface DesktopNotificationDeps {
  isSupported: () => boolean;
  create: (options: { title: string; body: string }) => NotificationHandle;
  live: Set<NotificationHandle>;
  window: NotificationWindow;
}

export function desktopNotificationOf(
  value: unknown,
): DesktopNotification | null {
  const parsed = DesktopNotificationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function showDesktopNotification(
  deps: DesktopNotificationDeps,
  notification: DesktopNotification,
): void {
  const { window } = deps;
  if (!deps.isSupported() || window.isFocused()) {
    return;
  }
  const handle = deps.create({
    title: notification.title,
    body: notification.body,
  });
  const release = (): void => {
    deps.live.delete(handle);
  };
  handle.on("close", release);
  handle.on("failed", release);
  handle.on("click", () => {
    release();
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    window.webContents.send(NOTIFICATION_CLICKED_CHANNEL, notification.target);
  });
  deps.live.add(handle);
  handle.show();
}
