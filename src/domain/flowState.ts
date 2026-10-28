import type { RotationPhase } from "./rotation";

export const FlowNodeState = {
  idle: "idle",
  working: "working",
  awaitingPermission: "awaiting_permission",
  rateLimited: "rate_limited",
  done: "done",
  error: "error",
} as const;
export type FlowNodeState = (typeof FlowNodeState)[keyof typeof FlowNodeState];

export interface FlowStateInput {
  readonly nodeIds: readonly string[];
  readonly sessionNodeId: string | null;
  readonly phase: RotationPhase["phase"] | null;
  readonly pendingPermissions: number;
  readonly turnInFlight: boolean;
  readonly lastTurn: "ended" | "failed" | null;
}

const ERROR_PHASES: readonly RotationPhase["phase"][] = ["failed", "halted"];
const RATE_LIMITED_PHASES: readonly RotationPhase["phase"][] = [
  "waiting",
  "switching",
];

function sessionNodeState(input: FlowStateInput): FlowNodeState {
  if (
    (input.phase !== null && ERROR_PHASES.includes(input.phase)) ||
    (input.lastTurn === "failed" && !input.turnInFlight)
  ) {
    return FlowNodeState.error;
  }
  if (input.phase !== null && RATE_LIMITED_PHASES.includes(input.phase)) {
    return FlowNodeState.rateLimited;
  }
  if (input.pendingPermissions > 0) {
    return FlowNodeState.awaitingPermission;
  }
  if (input.turnInFlight) {
    return FlowNodeState.working;
  }
  return input.lastTurn === "ended" ? FlowNodeState.done : FlowNodeState.idle;
}

export function flowNodeStates(
  input: FlowStateInput,
): ReadonlyMap<string, FlowNodeState> {
  const sessionState = sessionNodeState(input);
  return new Map(
    input.nodeIds.map((id) => [
      id,
      id === input.sessionNodeId ? sessionState : FlowNodeState.idle,
    ]),
  );
}
