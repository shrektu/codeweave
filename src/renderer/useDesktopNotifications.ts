import { useEffect, useEffectEvent, useRef } from "react";

import type { NotificationTarget } from "../shared/notifications";

import { notificationsFor, type NotificationSource } from "./notifications";
import { useApp } from "./services";

export interface NotificationOpeners {
  onOpenSession: () => void;
  onOpenFlow: () => void;
}

export function useDesktopNotifications({
  onOpenSession,
  onOpenFlow,
}: NotificationOpeners): void {
  const { store, state } = useApp();
  const { snapshot } = state;
  const previous = useRef<NotificationSource | null>(null);

  useEffect(() => {
    if (snapshot === null) {
      return;
    }
    if (snapshot.settings.notifications) {
      for (const notification of notificationsFor(previous.current, snapshot)) {
        window.codeweave.notify(notification).catch((error: unknown) => {
          console.error("showing the desktop notification failed", error);
        });
      }
    }
    previous.current = snapshot;
  }, [snapshot]);

  const open = useEffectEvent((target: NotificationTarget): void => {
    if (target.kind === "session") {
      store.activateSession(target.sessionId);
      onOpenSession();
      return;
    }
    const owner = store
      .getState()
      .snapshot?.flowRuns.find(
        (run) => run.runId === target.runId,
      )?.ownerSessionId;
    if (owner !== null && owner !== undefined) {
      store.activateSession(owner);
      store.focusRun(target.runId);
    }
    onOpenFlow();
  });

  useEffect(() => window.codeweave.onNotificationClicked(open), []);
}
