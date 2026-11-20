import {
  DEFAULT_MAX_RESULT_CHARS,
  ORCHESTRATOR_WAKEUP_PREFIX,
} from "./constants";
import { truncate } from "./contextPackage";
import { ALLOWED_DECISIONS, FlowRunStatus } from "./flowRun";
import type { FlowRunView } from "../shared/views";

export interface FlowReportEntry {
  readonly view: FlowRunView;
  readonly note: string | null;
}

type ReportNode = FlowRunView["nodes"][number];

const REPORT_INTRO = `${ORCHESTRATOR_WAKEUP_PREFIX} These flows need your attention.`;
const RUN_SEPARATOR = "\n\n";

function describePlacement(view: FlowRunView): string {
  return view.branch === null
    ? view.placement
    : `${view.placement}, branch ${view.branch}`;
}

function describeDecision(view: FlowRunView): string[] {
  if (
    view.status !== FlowRunStatus.awaitingDecision ||
    view.decision === null
  ) {
    return [];
  }
  const { reason, nodeId } = view.decision;
  const options = ALLOWED_DECISIONS[reason].join(", ");
  return [
    `Decision needed: ${reason} at node ${nodeId}. Call decide with one of: ${options}.`,
  ];
}

function describeFailure(view: FlowRunView): string[] {
  return view.status === FlowRunStatus.failed && view.failure !== null
    ? [`Failure: ${view.failure}`]
    : [];
}

function describeResult(view: FlowRunView, node: ReportNode): string[] {
  return node.result === null
    ? []
    : [
        `Result of node ${node.id}:`,
        truncate(node.result, DEFAULT_MAX_RESULT_CHARS),
        `Use node_result with runId ${view.runId} and nodeId ${node.id} for the full text.`,
      ];
}

function describeRun({ view, note }: FlowReportEntry): string {
  return [
    `Run ${view.runId}: flow ${view.flowId} (${view.flowTitle})`,
    `Placement: ${describePlacement(view)}`,
    `Status: ${view.status}`,
    `Round: ${String(view.round)}/${String(view.maxRounds)}`,
    "Nodes:",
    ...view.nodes.map(
      (node) => `- ${node.id}: ${node.status}, visits ${String(node.visits)}`,
    ),
    ...describeDecision(view),
    ...describeFailure(view),
    ...(note === null ? [] : [`Note: ${note}`]),
    ...view.nodes.flatMap((node) => describeResult(view, node)),
  ].join("\n");
}

export function buildFlowReport(entries: readonly FlowReportEntry[]): string {
  return [REPORT_INTRO, ...entries.map(describeRun)].join(RUN_SEPARATOR);
}
