import { expect, it } from "vitest";

import {
  makeFlowRun,
  makePermission,
  makePrompt,
  makeSession,
} from "../../tests/fakes/fakeIpcClient";
import type { SessionView } from "../shared/views";

import { notificationsFor, type NotificationSource } from "./notifications";

const ENDED = { kind: "ended", stopReason: "end_turn" } as const;

function sourceOf(
  sessions: SessionView[],
  flowRuns: NotificationSource["flowRuns"] = [],
  flowSessions: NotificationSource["flowSessions"] = [],
): NotificationSource {
  return { sessions, flowRuns, flowSessions };
}

function running(overrides: Partial<SessionView> = {}): SessionView {
  return makeSession({
    id: "sess-1",
    turnInFlight: true,
    prompts: [makePrompt({ text: "Fix the login bug" })],
    ...overrides,
  });
}

it("user_cancel_is_not_notified", () => {
  const before = running();
  const after = {
    ...before,
    turnInFlight: false,
    lastTurn: { kind: "ended", stopReason: "cancelled" },
  } satisfies SessionView;

  expect(notificationsFor(sourceOf([before]), sourceOf([after]))).toEqual([]);
});

it("unchanged_last_turn_is_not_renotified", () => {
  const idle = running({ turnInFlight: false, lastTurn: ENDED });

  expect(notificationsFor(sourceOf([idle]), sourceOf([{ ...idle }]))).toEqual(
    [],
  );
});

it("second_identical_turn_end_is_notified_again", () => {
  const idle = running({ turnInFlight: false, lastTurn: ENDED });
  const again = { ...idle, turnInFlight: true };
  const done = { ...idle };

  expect(notificationsFor(sourceOf([again]), sourceOf([done]))).toEqual([
    {
      title: "Agent finished",
      body: "Fix the login bug",
      target: { kind: "session", sessionId: "sess-1" },
    },
  ]);
});

it("last_turn_set_while_turn_still_in_flight_is_not_notified_yet", () => {
  const before = running();
  const after = { ...before, lastTurn: ENDED };

  expect(notificationsFor(sourceOf([before]), sourceOf([after]))).toEqual([]);
});

it("existing_approval_is_not_renotified", () => {
  const waiting = running({ permissions: [makePermission()] });

  expect(
    notificationsFor(sourceOf([waiting]), sourceOf([{ ...waiting }])),
  ).toEqual([]);
});

it("new_approval_next_to_an_existing_one_is_notified_once", () => {
  const before = running({ permissions: [makePermission()] });
  const after = {
    ...before,
    permissions: [
      makePermission(),
      makePermission({ requestId: "req-2" }),
      makePermission({ requestId: "req-3" }),
    ],
  };

  expect(notificationsFor(sourceOf([before]), sourceOf([after]))).toEqual([
    {
      title: "Approval needed",
      body: "Fix the login bug",
      target: { kind: "session", sessionId: "sess-1" },
    },
  ]);
});

it("untitled_session_body_uses_fallback", () => {
  const before = running({ prompts: [] });
  const after = { ...before, turnInFlight: false, lastTurn: ENDED };

  expect(notificationsFor(sourceOf([before]), sourceOf([after]))).toEqual([
    {
      title: "Agent finished",
      body: "Untitled session",
      target: { kind: "session", sessionId: "sess-1" },
    },
  ]);
});

it("body_is_the_first_prompt_line_trimmed", () => {
  const before = running({
    prompts: [makePrompt({ text: "  Fix the bug  \nwith details" })],
  });
  const after = { ...before, turnInFlight: false, lastTurn: ENDED };

  expect(notificationsFor(sourceOf([before]), sourceOf([after]))[0]?.body).toBe(
    "Fix the bug",
  );
});

it("session_absent_from_previous_is_not_notified", () => {
  const loaded = running({
    turnInFlight: false,
    lastTurn: ENDED,
    permissions: [makePermission()],
  });

  expect(notificationsFor(sourceOf([]), sourceOf([loaded]))).toEqual([]);
});

it("first_snapshot_is_not_notified", () => {
  const loaded = running({ turnInFlight: false, lastTurn: ENDED });

  expect(
    notificationsFor(
      null,
      sourceOf([loaded], [makeFlowRun({ status: "done" })]),
    ),
  ).toEqual([]);
});

it("stopped_flow_run_is_not_notified", () => {
  const run = makeFlowRun();

  expect(
    notificationsFor(
      sourceOf([], [run]),
      sourceOf([], [{ ...run, status: "stopped" }]),
    ),
  ).toEqual([]);
});

it("unchanged_flow_run_status_is_not_renotified", () => {
  const run = makeFlowRun({ status: "done" });

  expect(
    notificationsFor(sourceOf([], [run]), sourceOf([], [{ ...run }])),
  ).toEqual([]);
});

it("flow_run_absent_from_previous_is_not_notified", () => {
  expect(
    notificationsFor(
      sourceOf([], []),
      sourceOf([], [makeFlowRun({ status: "done" })]),
    ),
  ).toEqual([]);
});

it("awaiting_decision_is_notified_with_flow_title", () => {
  const run = makeFlowRun({ runId: "run-9", flowTitle: "Ship it" });

  expect(
    notificationsFor(
      sourceOf([], [run]),
      sourceOf([], [{ ...run, status: "awaiting_decision" }]),
    ),
  ).toEqual([
    {
      title: "Decision needed",
      body: "Ship it",
      target: { kind: "flowRun", runId: "run-9" },
    },
  ]);
});

const FLOW_NODE = makeSession({ id: "node-1", turnInFlight: true });

it("flow_node_approval_notifies", () => {
  const run = makeFlowRun({ runId: "run-1", flowTitle: "Ship it" });
  const before = sourceOf([], [run], [{ runId: "run-1", view: FLOW_NODE }]);
  const waiting = { ...FLOW_NODE, permissions: [makePermission()] };
  const after = sourceOf([], [run], [{ runId: "run-1", view: waiting }]);

  expect(notificationsFor(before, after)).toEqual([
    {
      title: "Approval needed",
      body: "Ship it",
      target: { kind: "flowRun", runId: "run-1" },
    },
  ]);
});

it("existing_flow_node_approval_is_not_renotified", () => {
  const run = makeFlowRun({ runId: "run-1" });
  const waiting = { ...FLOW_NODE, permissions: [makePermission()] };
  const entry = [{ runId: "run-1", view: waiting }];

  expect(
    notificationsFor(
      sourceOf([], [run], entry),
      sourceOf([], [run], [{ runId: "run-1", view: { ...waiting } }]),
    ),
  ).toEqual([]);
});

it("new_flow_node_session_is_not_notified", () => {
  const run = makeFlowRun({ runId: "run-1" });
  const waiting = { ...FLOW_NODE, permissions: [makePermission()] };

  expect(
    notificationsFor(
      sourceOf([], [run]),
      sourceOf([], [run], [{ runId: "run-1", view: waiting }]),
    ),
  ).toEqual([]);
});
