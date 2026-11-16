import { orderingEdges, type FlowDefinition, type OrderEdge } from "./flows";
import { EdgeKind } from "./types";

export const FlowRunStatus = {
  running: "running",
  awaitingDecision: "awaiting_decision",
  done: "done",
  failed: "failed",
  stopped: "stopped",
} as const;
export type FlowRunStatus = (typeof FlowRunStatus)[keyof typeof FlowRunStatus];

export const FlowNodeRunStatus = {
  idle: "idle",
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
} as const;
export type FlowNodeRunStatus =
  (typeof FlowNodeRunStatus)[keyof typeof FlowNodeRunStatus];

export const DecisionReason = {
  gate: "gate",
  roundsExhausted: "rounds_exhausted",
  missingVerdict: "missing_verdict",
} as const;
export type DecisionReason =
  (typeof DecisionReason)[keyof typeof DecisionReason];

export const FlowDecision = {
  approve: "approve",
  anotherRound: "another_round",
  stop: "stop",
} as const;
export type FlowDecision = (typeof FlowDecision)[keyof typeof FlowDecision];

export const Verdict = {
  approved: "approved",
  changesRequested: "changes_requested",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export const NodeInputKind = {
  handoff: "handoff",
  findings: "findings",
} as const;
export type NodeInputKind = (typeof NodeInputKind)[keyof typeof NodeInputKind];

export interface NodeInput {
  readonly from: string;
  readonly kind: NodeInputKind;
  readonly text: string;
}

export interface FlowRunNode {
  readonly id: string;
  readonly status: FlowNodeRunStatus;
  readonly visits: number;
  readonly result: string | null;
}

export interface PendingDecision {
  readonly reason: DecisionReason;
  readonly nodeId: string;
}

export interface FlowRunState {
  readonly runId: string;
  readonly flowId: string;
  readonly flowTitle: string;
  readonly cwd: string;
  readonly task: string;
  readonly status: FlowRunStatus;
  readonly maxRounds: number;
  readonly rounds: ReadonlyMap<string, number>;
  readonly nodes: readonly FlowRunNode[];
  readonly pending: readonly string[];
  readonly findings: ReadonlyMap<string, readonly NodeInput[]>;
  readonly passedGates: ReadonlyMap<string, number>;
  readonly decision: PendingDecision | null;
  readonly failure: string | null;
}

export interface FlowRunInit {
  readonly runId: string;
  readonly cwd: string;
  readonly task: string;
  readonly maxRounds: number;
}

export type FlowCommand =
  | {
      readonly type: "run_node";
      readonly nodeId: string;
      readonly inputs: readonly NodeInput[];
    }
  | { readonly type: "await_decision" }
  | { readonly type: "finished" };

export interface Transition {
  readonly state: FlowRunState;
  readonly command: FlowCommand;
}

export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecisionError";
  }
}

const VERDICT_PATTERN = /^VERDICT:\s*(APPROVED|CHANGES_REQUESTED)\s*$/i;
const LINE_BREAK_PATTERN = /\r?\n/;
const MARKUP_PATTERN = /^[*`_\s]+|[*`_\s]+$/g;
const VERDICT_BY_WORD: Readonly<Record<string, Verdict>> = {
  APPROVED: Verdict.approved,
  CHANGES_REQUESTED: Verdict.changesRequested,
};
const REVIEW_DECISIONS: readonly FlowDecision[] = Object.values(FlowDecision);
const ALLOWED_DECISIONS: Readonly<
  Record<DecisionReason, readonly FlowDecision[]>
> = {
  [DecisionReason.gate]: [FlowDecision.approve, FlowDecision.stop],
  [DecisionReason.roundsExhausted]: REVIEW_DECISIONS,
  [DecisionReason.missingVerdict]: REVIEW_DECISIONS,
};
const NO_PENDING_DECISION = "The flow run is not waiting for a decision";

export function parseVerdict(text: string): Verdict | null {
  const lastLine = text
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trim())
    .findLast((line) => line !== "");
  const word = VERDICT_PATTERN.exec(
    lastLine?.replace(MARKUP_PATTERN, "") ?? "",
  )?.[1];
  return word === undefined
    ? null
    : (VERDICT_BY_WORD[word.toUpperCase()] ?? null);
}

function topologicalOrder(flow: FlowDefinition): string[] {
  const edges = orderingEdges(flow);
  const remaining = flow.nodes.map((node) => node.id);
  const order: string[] = [];
  while (remaining.length > 0) {
    const next =
      remaining.find(
        (id) =>
          !edges.some(
            (edge) => edge.to === id && remaining.includes(edge.from),
          ),
      ) ?? remaining[0];
    if (next === undefined) {
      break;
    }
    order.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

function closure(
  edges: readonly OrderEdge[],
  start: string,
  forward: boolean,
): ReadonlySet<string> {
  const seen = new Set([start]);
  const queue = [start];
  for (const current of queue) {
    for (const edge of edges) {
      const [near, far] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
      if (near === current && !seen.has(far)) {
        seen.add(far);
        queue.push(far);
      }
    }
  }
  return seen;
}

function nodesBetween(
  edges: readonly OrderEdge[],
  from: string,
  to: string,
): string[] {
  const downstream = closure(edges, from, true);
  const upstream = closure(edges, to, false);
  return [...downstream].filter((id) => upstream.has(id));
}

function nodeOf(state: FlowRunState, id: string): FlowRunNode {
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`Unknown node "${id}"`);
  }
  return node;
}

function withNode(
  state: FlowRunState,
  id: string,
  patch: Partial<FlowRunNode>,
): FlowRunState {
  return {
    ...state,
    nodes: state.nodes.map((node) =>
      node.id === id ? { ...node, ...patch } : node,
    ),
  };
}

function gateKey(edge: { from: string; to: string }): string {
  return `${edge.from}->${edge.to}`;
}

function gatesBefore(
  state: FlowRunState,
  flow: FlowDefinition,
  nodeId: string,
): FlowDefinition["edges"] {
  return flow.edges.filter(
    (edge) =>
      edge.to === nodeId &&
      edge.gate === true &&
      edge.kind !== EdgeKind.reviews &&
      nodeOf(state, edge.from).status === FlowNodeRunStatus.done &&
      state.passedGates.get(gateKey(edge)) !== nodeOf(state, edge.from).visits,
  );
}

function handoffInputs(
  state: FlowRunState,
  flow: FlowDefinition,
  nodeId: string,
): NodeInput[] {
  return flow.edges
    .filter((edge) => edge.kind === EdgeKind.handsOffTo && edge.to === nodeId)
    .flatMap((edge) => {
      const { result } = nodeOf(state, edge.from);
      return result === null
        ? []
        : [{ from: edge.from, kind: NodeInputKind.handoff, text: result }];
    });
}

function finish(state: FlowRunState): Transition {
  return { state, command: { type: "finished" } };
}

function pause(
  state: FlowRunState,
  reason: DecisionReason,
  nodeId: string,
): Transition {
  return {
    state: {
      ...state,
      status: FlowRunStatus.awaitingDecision,
      decision: { reason, nodeId },
    },
    command: { type: "await_decision" },
  };
}

function dispatch(
  state: FlowRunState,
  flow: FlowDefinition,
  nodeId: string,
): Transition {
  const inputs = [
    ...handoffInputs(state, flow, nodeId),
    ...(state.findings.get(nodeId) ?? []),
  ];
  const started = withNode(state, nodeId, {
    status: FlowNodeRunStatus.running,
    visits: nodeOf(state, nodeId).visits + 1,
  });
  return {
    state: {
      ...started,
      pending: state.pending.filter((id) => id !== nodeId),
      findings: new Map([...state.findings].filter(([id]) => id !== nodeId)),
    },
    command: { type: "run_node", nodeId, inputs },
  };
}

function advance(state: FlowRunState, flow: FlowDefinition): Transition {
  const ready = { ...state, status: FlowRunStatus.running, decision: null };
  const next = topologicalOrder(flow).find((id) => ready.pending.includes(id));
  if (next === undefined) {
    return finish({ ...ready, status: FlowRunStatus.done });
  }
  return gatesBefore(ready, flow, next).length > 0
    ? pause(ready, DecisionReason.gate, next)
    : dispatch(ready, flow, next);
}

function reviewTargets(flow: FlowDefinition, reviewerId: string): string[] {
  return flow.edges
    .filter(
      (edge) => edge.kind === EdgeKind.reviews && edge.from === reviewerId,
    )
    .map((edge) => edge.to);
}

function reworkState(
  state: FlowRunState,
  flow: FlowDefinition,
  reviewerId: string,
): FlowRunState {
  const edges = orderingEdges(flow);
  const targets = reviewTargets(flow, reviewerId);
  const scope = new Set(
    targets.flatMap((target) => nodesBetween(edges, target, reviewerId)),
  );
  const feedback: NodeInput = {
    from: reviewerId,
    kind: NodeInputKind.findings,
    text: nodeOf(state, reviewerId).result ?? "",
  };
  const requeued = state.nodes.map((node) =>
    scope.has(node.id) && node.status === FlowNodeRunStatus.done
      ? { ...node, status: FlowNodeRunStatus.queued }
      : node,
  );
  return {
    ...state,
    nodes: requeued,
    pending: [...new Set([...state.pending, ...scope])],
    findings: new Map([
      ...state.findings,
      ...targets.map((target): [string, readonly NodeInput[]] => [
        target,
        [...(state.findings.get(target) ?? []), feedback],
      ]),
    ]),
  };
}

function rework(
  state: FlowRunState,
  flow: FlowDefinition,
  reviewerId: string,
): Transition {
  return advance(reworkState(state, flow, reviewerId), flow);
}

function gatedRework(
  state: FlowRunState,
  flow: FlowDefinition,
  reviewerId: string,
): Transition {
  const gates = flow.edges.filter(
    (edge) =>
      edge.kind === EdgeKind.reviews &&
      edge.from === reviewerId &&
      edge.gate === true,
  );
  const [first] = gates;
  if (first === undefined) {
    return rework(state, flow, reviewerId);
  }
  const visits = nodeOf(state, reviewerId).visits;
  return pause(
    {
      ...reworkState(state, flow, reviewerId),
      passedGates: new Map([
        ...state.passedGates,
        ...gates.map((edge): [string, number] => [gateKey(edge), visits]),
      ]),
    },
    DecisionReason.gate,
    first.to,
  );
}

function afterReview(
  state: FlowRunState,
  flow: FlowDefinition,
  reviewerId: string,
  result: string,
): Transition {
  const verdict = parseVerdict(result);
  if (verdict === null) {
    return pause(state, DecisionReason.missingVerdict, reviewerId);
  }
  if (verdict === Verdict.approved) {
    return advance(state, flow);
  }
  return (state.rounds.get(reviewerId) ?? 0) < state.maxRounds
    ? gatedRework(state, flow, reviewerId)
    : pause(state, DecisionReason.roundsExhausted, reviewerId);
}

export function startRun(
  flow: FlowDefinition,
  { runId, cwd, task, maxRounds }: FlowRunInit,
): Transition {
  return advance(
    {
      runId,
      flowId: flow.id,
      flowTitle: flow.title,
      cwd,
      task,
      status: FlowRunStatus.running,
      maxRounds,
      rounds: new Map(),
      nodes: flow.nodes.map(({ id }) => ({
        id,
        status: FlowNodeRunStatus.idle,
        visits: 0,
        result: null,
      })),
      pending: flow.nodes.map(({ id }) => id),
      findings: new Map(),
      passedGates: new Map(),
      decision: null,
      failure: null,
    },
    flow,
  );
}

export function nodeSucceeded(
  state: FlowRunState,
  flow: FlowDefinition,
  nodeId: string,
  result: string,
): Transition {
  const finished = withNode(state, nodeId, {
    status: FlowNodeRunStatus.done,
    result,
  });
  if (reviewTargets(flow, nodeId).length === 0) {
    return advance(finished, flow);
  }
  return afterReview(
    {
      ...finished,
      rounds: new Map(state.rounds).set(
        nodeId,
        (state.rounds.get(nodeId) ?? 0) + 1,
      ),
    },
    flow,
    nodeId,
    result,
  );
}

export function nodeFailed(
  state: FlowRunState,
  nodeId: string,
  message: string,
): Transition {
  return finish({
    ...withNode(state, nodeId, { status: FlowNodeRunStatus.failed }),
    status: FlowRunStatus.failed,
    failure: message,
  });
}

export function stopRun(state: FlowRunState): Transition {
  return finish({
    ...state,
    nodes: state.nodes.map((node) =>
      node.status === FlowNodeRunStatus.running
        ? { ...node, status: FlowNodeRunStatus.idle }
        : node,
    ),
    status: FlowRunStatus.stopped,
    decision: null,
  });
}

function approveGate(
  state: FlowRunState,
  flow: FlowDefinition,
  nodeId: string,
): Transition {
  return advance(
    {
      ...state,
      passedGates: new Map([
        ...state.passedGates,
        ...gatesBefore(state, flow, nodeId).map((edge): [string, number] => [
          gateKey(edge),
          nodeOf(state, edge.from).visits,
        ]),
      ]),
    },
    flow,
  );
}

export function applyDecision(
  state: FlowRunState,
  flow: FlowDefinition,
  decision: FlowDecision,
): Transition {
  if (state.decision === null) {
    throw new InvalidDecisionError(NO_PENDING_DECISION);
  }
  const { reason, nodeId } = state.decision;
  if (!ALLOWED_DECISIONS[reason].includes(decision)) {
    throw new InvalidDecisionError(
      `Decision "${decision}" is not allowed for "${reason}"`,
    );
  }
  if (decision === FlowDecision.stop) {
    return stopRun(state);
  }
  if (reason === DecisionReason.gate) {
    return approveGate(state, flow, nodeId);
  }
  return decision === FlowDecision.anotherRound
    ? rework(state, flow, nodeId)
    : advance(state, flow);
}
