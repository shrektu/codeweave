import type {
  FlowControl,
  FlowStartRequest,
} from "../../src/backend/flowTools/control";
import {
  DecisionReason,
  FlowNodeRunStatus,
  FlowRunStatus,
  type FlowDecision,
} from "../../src/domain/flowRun";
import {
  EdgeKind,
  FlowPlacement,
  FlowRunOrigin,
  MergeStatus,
  type MergeOutcome,
} from "../../src/domain/types";
import type { FlowRunView, FlowsList } from "../../src/shared/views";

export const FlowControlOp = {
  listFlows: "listFlows",
  startFlow: "startFlow",
  status: "status",
  nodeResult: "nodeResult",
  diff: "diff",
  decide: "decide",
  stop: "stop",
  merge: "merge",
  finishMerge: "finishMerge",
  abortMerge: "abortMerge",
} as const;
export type FlowControlOp = (typeof FlowControlOp)[keyof typeof FlowControlOp];

export interface FlowControlCall {
  readonly op: FlowControlOp;
  readonly args: readonly unknown[];
}

export const SAMPLE_FLOWS: FlowsList = {
  flows: [
    {
      id: "review",
      file: "review.md",
      source: "project",
      revision: "r1",
      title: "Review flow",
      maxRounds: 3,
      nodes: [
        { id: "write", agent: "writer", provider: null, taskClass: null },
        { id: "check", agent: "checker", provider: null, taskClass: null },
      ],
      edges: [
        { from: "write", to: "check", kind: EdgeKind.reviews, gate: true },
      ],
    },
  ],
  agents: [],
  errors: [],
  locations: { project: "/work/repo", library: "/data/library" },
};

export const SAMPLE_RUN: FlowRunView = {
  runId: "run-1",
  flowId: "review",
  flowTitle: "Review flow",
  cwd: "/work/repo",
  task: "Fix the bug",
  status: FlowRunStatus.awaitingDecision,
  round: 1,
  maxRounds: 3,
  currentNodeId: "check",
  nodes: [
    { id: "write", status: FlowNodeRunStatus.done, visits: 1, result: "done" },
    { id: "check", status: FlowNodeRunStatus.done, visits: 1, result: null },
  ],
  decision: { reason: DecisionReason.gate, nodeId: "check" },
  decisions: [],
  failure: null,
  origin: FlowRunOrigin.orchestrator,
  placement: FlowPlacement.inPlace,
  branch: null,
  ownerSessionId: null,
};

export class FakeFlowControl implements FlowControl {
  readonly calls: FlowControlCall[] = [];
  flows: FlowsList = SAMPLE_FLOWS;
  run: FlowRunView = SAMPLE_RUN;
  nodeResultText = "";
  diffText = "";
  mergeOutcome: MergeOutcome = {
    status: MergeStatus.merged,
    commit: "abc123",
  };
  failure: Error | null = null;

  listFlows(): Promise<FlowsList> {
    return this.answer(FlowControlOp.listFlows, [], this.flows);
  }

  startFlow(request: FlowStartRequest): Promise<FlowRunView> {
    return this.answer(FlowControlOp.startFlow, [request], this.run);
  }

  status(runId: string): FlowRunView {
    return this.answerNow(FlowControlOp.status, [runId], this.run);
  }

  nodeResult(runId: string, nodeId: string): string {
    return this.answerNow(
      FlowControlOp.nodeResult,
      [runId, nodeId],
      this.nodeResultText,
    );
  }

  diff(runId: string): Promise<string> {
    return this.answer(FlowControlOp.diff, [runId], this.diffText);
  }

  decide(
    runId: string,
    decision: FlowDecision,
    note?: string,
  ): Promise<FlowRunView> {
    const args =
      note === undefined ? [runId, decision] : [runId, decision, note];
    return this.answer(FlowControlOp.decide, args, this.run);
  }

  async stop(runId: string): Promise<void> {
    await this.answer(FlowControlOp.stop, [runId], undefined);
  }

  merge(runId: string): Promise<MergeOutcome> {
    return this.answer(FlowControlOp.merge, [runId], this.mergeOutcome);
  }

  finishMerge(runId: string): Promise<MergeOutcome> {
    return this.answer(FlowControlOp.finishMerge, [runId], this.mergeOutcome);
  }

  async abortMerge(runId: string): Promise<void> {
    await this.answer(FlowControlOp.abortMerge, [runId], undefined);
  }

  private answerNow<T>(
    op: FlowControlOp,
    args: readonly unknown[],
    value: T,
  ): T {
    this.calls.push({ op, args });
    if (this.failure !== null) {
      throw this.failure;
    }
    return value;
  }

  private answer<T>(
    op: FlowControlOp,
    args: readonly unknown[],
    value: T,
  ): Promise<T> {
    try {
      return Promise.resolve(this.answerNow(op, args, value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error());
    }
  }
}
