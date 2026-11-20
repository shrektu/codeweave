import type { FlowDecision } from "../../domain/flowRun";
import type { FlowPlacement, MergeOutcome } from "../../domain/types";
import type { FlowRunView, FlowsList } from "../../shared/views";

export interface FlowStartRequest {
  readonly flowId: string;
  readonly task: string;
  readonly placement: FlowPlacement;
}

export interface FlowControl {
  listFlows(): Promise<FlowsList>;
  startFlow(request: FlowStartRequest): Promise<FlowRunView>;
  status(runId: string): FlowRunView;
  nodeResult(runId: string, nodeId: string): string;
  diff(runId: string): Promise<string>;
  decide(runId: string, decision: FlowDecision): Promise<FlowRunView>;
  stop(runId: string): Promise<void>;
  merge(runId: string): Promise<MergeOutcome>;
  finishMerge(runId: string): Promise<MergeOutcome>;
  abortMerge(runId: string): Promise<void>;
}
