import { FlowNodeRunStatus, FlowRunStatus } from "./flowRun";
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

export interface SessionStateInput {
  readonly phase: RotationPhase["phase"] | null;
  readonly pendingPermissions: number;
  readonly turnInFlight: boolean;
  readonly lastTurn: "ended" | "failed" | null;
}

export interface FlowStateInput extends SessionStateInput {
  readonly nodeIds: readonly string[];
  readonly sessionNodeId: string | null;
}

const ERROR_PHASES: readonly RotationPhase["phase"][] = ["failed", "halted"];
const RATE_LIMITED_PHASES: readonly RotationPhase["phase"][] = [
  "waiting",
  "switching",
];

function sessionNodeState(input: SessionStateInput): FlowNodeState {
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

export function isRunOpen(status: FlowRunStatus): boolean {
  return (
    status === FlowRunStatus.running ||
    status === FlowRunStatus.awaitingDecision
  );
}

export interface RunSessionInput extends SessionStateInput {
  readonly flowRef: {
    readonly flowId: string;
    readonly nodeId: string;
  } | null;
}

export interface RunStateInput {
  readonly flowId: string;
  readonly currentNodeId: string | null;
  readonly nodeIds: readonly string[];
  readonly runNodes: readonly {
    readonly id: string;
    readonly status: FlowNodeRunStatus;
  }[];
  readonly session: RunSessionInput | null;
}

function ownSessionOf(input: RunStateInput): SessionStateInput | null {
  const { session } = input;
  const owned =
    session?.flowRef?.flowId === input.flowId &&
    session.flowRef.nodeId === input.currentNodeId;
  return owned && session.phase !== "stopped" ? session : null;
}

function runningNodeState(session: SessionStateInput | null): FlowNodeState {
  const state = session === null ? null : sessionNodeState(session);
  return state === null ||
    state === FlowNodeState.idle ||
    state === FlowNodeState.done
    ? FlowNodeState.working
    : state;
}

function runNodeState(
  status: FlowNodeRunStatus | undefined,
  session: SessionStateInput | null,
): FlowNodeState {
  switch (status) {
    case FlowNodeRunStatus.done:
      return FlowNodeState.done;
    case FlowNodeRunStatus.failed:
      return FlowNodeState.error;
    case FlowNodeRunStatus.running:
      return runningNodeState(session);
    case FlowNodeRunStatus.idle:
    case FlowNodeRunStatus.queued:
    case undefined:
      return FlowNodeState.idle;
  }
}

export function runNodeStates(
  input: RunStateInput,
): ReadonlyMap<string, FlowNodeState> {
  const statuses = new Map(
    input.runNodes.map((node) => [node.id, node.status]),
  );
  const session = ownSessionOf(input);
  return new Map(
    input.nodeIds.map((id) => [id, runNodeState(statuses.get(id), session)]),
  );
}
