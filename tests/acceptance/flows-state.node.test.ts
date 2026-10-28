import { expect, it } from "vitest";

import {
  FlowNodeState,
  flowNodeStates,
  type FlowStateInput,
} from "../../src/domain/flowState";

const BASE_INPUT: FlowStateInput = {
  nodeIds: ["build", "review"],
  sessionNodeId: "build",
  phase: "running",
  pendingPermissions: 0,
  turnInFlight: false,
  lastTurn: null,
};

it("flow_state_session_awaiting_permission_others_idle", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    pendingPermissions: 1,
    turnInFlight: true,
  });

  expect(states.get("build")).toBe(FlowNodeState.awaitingPermission);
  expect(states.get("review")).toBe(FlowNodeState.idle);
  expect(states.size).toBe(2);
});

it("flow_state_rate_limited_during_waiting_phase", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    phase: "waiting",
    turnInFlight: true,
  });

  expect(states.get("build")).toBe(FlowNodeState.rateLimited);
  expect(states.get("review")).toBe(FlowNodeState.idle);
});

const PRECEDENCE_CASES: readonly [
  string,
  Partial<FlowStateInput>,
  FlowNodeState,
][] = [
  [
    "failed phase beats a pending permission",
    { phase: "failed", pendingPermissions: 2 },
    FlowNodeState.error,
  ],
  [
    "halted phase",
    { phase: "halted", turnInFlight: true },
    FlowNodeState.error,
  ],
  [
    "failed last turn beats waiting",
    { phase: "waiting", lastTurn: "failed" },
    FlowNodeState.error,
  ],
  [
    "switching phase beats a pending permission",
    { phase: "switching", pendingPermissions: 1 },
    FlowNodeState.rateLimited,
  ],
  [
    "pending permission beats a turn in flight",
    { pendingPermissions: 1, turnInFlight: true },
    FlowNodeState.awaitingPermission,
  ],
  [
    "turn in flight beats an ended turn",
    { turnInFlight: true, lastTurn: "ended" },
    FlowNodeState.working,
  ],
  ["ended last turn", { lastTurn: "ended" }, FlowNodeState.done],
  ["running without activity", {}, FlowNodeState.idle],
  ["stopped phase without a turn", { phase: "stopped" }, FlowNodeState.idle],
  ["no phase yet", { phase: null }, FlowNodeState.idle],
];

it.each(PRECEDENCE_CASES)(
  "flow_state_rule_precedence: %s",
  (_name, overrides, expected) => {
    const states = flowNodeStates({ ...BASE_INPUT, ...overrides });

    expect(states.get("build")).toBe(expected);
    expect(states.get("review")).toBe(FlowNodeState.idle);
  },
);

it("flow_state_unknown_session_node_leaves_all_idle", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    sessionNodeId: "ghost",
    pendingPermissions: 3,
  });

  expect([...states.entries()]).toEqual([
    ["build", FlowNodeState.idle],
    ["review", FlowNodeState.idle],
  ]);
});

it("flow_state_without_session_node_leaves_all_idle", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    sessionNodeId: null,
    turnInFlight: true,
  });

  expect([...states.values()]).toEqual([
    FlowNodeState.idle,
    FlowNodeState.idle,
  ]);
});

it("flow_state_new_turn_after_failed_turn_is_working", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    lastTurn: "failed",
    turnInFlight: true,
  });

  expect(states.get("build")).toBe(FlowNodeState.working);
});

it("flow_state_new_turn_after_failed_turn_awaiting_permission", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    lastTurn: "failed",
    turnInFlight: true,
    pendingPermissions: 1,
  });

  expect(states.get("build")).toBe(FlowNodeState.awaitingPermission);
});

it("flow_state_failed_turn_without_new_turn_stays_error", () => {
  const states = flowNodeStates({
    ...BASE_INPUT,
    lastTurn: "failed",
    turnInFlight: false,
  });

  expect(states.get("build")).toBe(FlowNodeState.error);
});
