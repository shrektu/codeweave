import { SESSION_TITLE_MAX_CHARS } from "../domain/constants";
import { FlowRunStatus } from "../domain/flowRun";
import { STOP_REASON_CANCELLED } from "../shared/constants";
import type { DesktopNotification } from "../shared/notifications";
import type { FlowRunView, SessionView, Snapshot } from "../shared/views";

import {
  NOTIFICATION_AGENT_FAILED,
  NOTIFICATION_AGENT_FINISHED,
  NOTIFICATION_APPROVAL_NEEDED,
  NOTIFICATION_DECISION_NEEDED,
  NOTIFICATION_FLOW_FAILED,
  NOTIFICATION_FLOW_FINISHED,
  NOTIFICATION_UNTITLED_SESSION,
} from "./notificationStrings";

export type NotificationSource = Pick<
  Snapshot,
  "sessions" | "flowRuns" | "flowSessions"
>;

const FLOW_RUN_TITLES: Partial<Record<FlowRunStatus, string>> = {
  [FlowRunStatus.done]: NOTIFICATION_FLOW_FINISHED,
  [FlowRunStatus.failed]: NOTIFICATION_FLOW_FAILED,
  [FlowRunStatus.awaitingDecision]: NOTIFICATION_DECISION_NEEDED,
};

function sessionBody(session: SessionView): string {
  const [firstLine = ""] = (session.prompts[0]?.text ?? "").split("\n");
  const title = firstLine.trim().slice(0, SESSION_TITLE_MAX_CHARS);
  return title === "" ? NOTIFICATION_UNTITLED_SESSION : title;
}

function turnEnded(before: SessionView, after: SessionView): boolean {
  return (
    after.lastTurn !== null &&
    !after.turnInFlight &&
    (before.turnInFlight ||
      JSON.stringify(before.lastTurn) !== JSON.stringify(after.lastTurn))
  );
}

function turnTitle(lastTurn: SessionView["lastTurn"]): string | null {
  if (lastTurn?.kind === "failed") {
    return NOTIFICATION_AGENT_FAILED;
  }
  return lastTurn !== null && lastTurn.stopReason !== STOP_REASON_CANCELLED
    ? NOTIFICATION_AGENT_FINISHED
    : null;
}

function hasNewApproval(before: SessionView, after: SessionView): boolean {
  return after.permissions.some(
    (permission) =>
      !before.permissions.some(
        (known) => known.requestId === permission.requestId,
      ),
  );
}

function sessionNotifications(
  before: SessionView,
  after: SessionView,
): DesktopNotification[] {
  const target = { kind: "session", sessionId: after.id } as const;
  const body = sessionBody(after);
  const finished = turnEnded(before, after) ? turnTitle(after.lastTurn) : null;
  return [
    ...(finished === null ? [] : [{ title: finished, body, target }]),
    ...(hasNewApproval(before, after)
      ? [{ title: NOTIFICATION_APPROVAL_NEEDED, body, target }]
      : []),
  ];
}

function flowNodeApprovals(
  previous: NotificationSource,
  next: NotificationSource,
): DesktopNotification[] {
  return next.flowSessions.flatMap(({ runId, view }) => {
    const before = previous.flowSessions.find((entry) => entry.runId === runId);
    const run = next.flowRuns.find((entry) => entry.runId === runId);
    return before !== undefined &&
      run !== undefined &&
      hasNewApproval(before.view, view)
      ? [
          {
            title: NOTIFICATION_APPROVAL_NEEDED,
            body: run.flowTitle,
            target: { kind: "flowRun", runId },
          } as const,
        ]
      : [];
  });
}

function flowRunNotifications(
  before: FlowRunView,
  after: FlowRunView,
): DesktopNotification[] {
  const title = FLOW_RUN_TITLES[after.status];
  if (title === undefined || before.status === after.status) {
    return [];
  }
  return [
    {
      title,
      body: after.flowTitle,
      target: { kind: "flowRun", runId: after.runId },
    },
  ];
}

export function notificationsFor(
  previous: NotificationSource | null,
  next: NotificationSource,
): DesktopNotification[] {
  if (previous === null) {
    return [];
  }
  const sessions = next.sessions.flatMap((after) => {
    const before = previous.sessions.find((entry) => entry.id === after.id);
    return before === undefined ? [] : sessionNotifications(before, after);
  });
  const runs = next.flowRuns.flatMap((after) => {
    const before = previous.flowRuns.find(
      (entry) => entry.runId === after.runId,
    );
    return before === undefined ? [] : flowRunNotifications(before, after);
  });
  return [...sessions, ...runs, ...flowNodeApprovals(previous, next)];
}
