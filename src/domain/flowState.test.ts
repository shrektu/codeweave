import { expect, it } from "vitest";

import { FlowNodeRunStatus, FlowRunStatus } from "./flowRun";
import {
  FlowNodeState,
  isRunOpen,
  runNodeStates,
  type RunSessionInput,
  type RunStateInput,
  type SessionStateInput,
} from "./flowState";

const IDLE_SESSION: SessionStateInput = {
  phase: "running",
  pendingPermissions: 0,
  turnInFlight: false,
  lastTurn: null,
};

function input(
  statuses: Record<string, FlowNodeRunStatus>,
  session: Partial<RunSessionInput> | null = {},
  nodeIds: readonly string[] = Object.keys(statuses),
): RunStateInput {
  return {
    flowId: "flow",
    currentNodeId: "a",
    nodeIds,
    runNodes: Object.entries(statuses).map(([id, status]) => ({ id, status })),
    session:
      session === null
        ? null
        : {
            ...IDLE_SESSION,
            flowRef: { flowId: "flow", nodeId: "a" },
            ...session,
          },
  };
}

it("run_node_states_maps_non_running_statuses", () => {
  const states = runNodeStates(
    input({
      a: FlowNodeRunStatus.idle,
      b: FlowNodeRunStatus.queued,
      c: FlowNodeRunStatus.done,
      d: FlowNodeRunStatus.failed,
    }),
  );

  expect([...states]).toEqual([
    ["a", FlowNodeState.idle],
    ["b", FlowNodeState.idle],
    ["c", FlowNodeState.done],
    ["d", FlowNodeState.error],
  ]);
});

it.each([
  ["between turns", {}, FlowNodeState.working],
  ["after an ended turn", { lastTurn: "ended" }, FlowNodeState.working],
  ["turn in flight", { turnInFlight: true }, FlowNodeState.working],
  [
    "pending permission",
    { pendingPermissions: 1, turnInFlight: true },
    FlowNodeState.awaitingPermission,
  ],
  ["waiting phase", { phase: "waiting" }, FlowNodeState.rateLimited],
  ["switching phase", { phase: "switching" }, FlowNodeState.rateLimited],
  ["failed phase", { phase: "failed" }, FlowNodeState.error],
  ["halted phase", { phase: "halted" }, FlowNodeState.error],
  ["failed last turn", { lastTurn: "failed" }, FlowNodeState.error],
  [
    "failed last turn with a new turn running",
    { lastTurn: "failed", turnInFlight: true },
    FlowNodeState.working,
  ],
] as const)("run_node_states_running_node_%s", (_name, session, expected) => {
  const states = runNodeStates(
    input({ a: FlowNodeRunStatus.running, b: FlowNodeRunStatus.done }, session),
  );

  expect(states.get("a")).toBe(expected);
  expect(states.get("b")).toBe(FlowNodeState.done);
});

it.each([
  ["another node", { flowId: "flow", nodeId: "b" }],
  ["another flow", { flowId: "other", nodeId: "a" }],
  ["no flow reference", null],
] as const)(
  "run_node_states_ignore_session_of_another_node_%s",
  (_name, flowRef) => {
    const states = runNodeStates(
      input(
        { a: FlowNodeRunStatus.running, b: FlowNodeRunStatus.queued },
        { phase: "failed", lastTurn: "failed", flowRef },
      ),
    );

    expect(states.get("a")).toBe(FlowNodeState.working);
  },
);

it("run_node_states_ignore_stopped_session", () => {
  const states = runNodeStates(
    input(
      { a: FlowNodeRunStatus.running },
      { phase: "stopped", lastTurn: "failed" },
    ),
  );

  expect(states.get("a")).toBe(FlowNodeState.working);
});

it("run_node_states_without_session_running_node_is_working", () => {
  const states = runNodeStates(input({ a: FlowNodeRunStatus.running }, null));

  expect(states.get("a")).toBe(FlowNodeState.working);
});

it("run_node_states_session_never_colours_non_running_nodes", () => {
  const states = runNodeStates(
    input(
      { a: FlowNodeRunStatus.queued, b: FlowNodeRunStatus.done },
      { phase: "waiting", pendingPermissions: 2, turnInFlight: true },
    ),
  );

  expect(states.get("a")).toBe(FlowNodeState.idle);
  expect(states.get("b")).toBe(FlowNodeState.done);
});

it("run_node_states_node_absent_from_run_is_idle", () => {
  const states = runNodeStates(
    input({ a: FlowNodeRunStatus.done }, {}, ["a", "extra"]),
  );

  expect(states.get("extra")).toBe(FlowNodeState.idle);
  expect(states.size).toBe(2);
});

it("run_node_states_ignores_run_nodes_outside_the_flow", () => {
  const states = runNodeStates(
    input({ a: FlowNodeRunStatus.done, stale: FlowNodeRunStatus.failed }, {}, [
      "a",
    ]),
  );

  expect([...states]).toEqual([["a", FlowNodeState.done]]);
});

it("is_run_open_only_for_running_and_awaiting_decision", () => {
  expect(Object.values(FlowRunStatus).filter(isRunOpen)).toEqual([
    FlowRunStatus.running,
    FlowRunStatus.awaitingDecision,
  ]);
});
