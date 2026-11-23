import type { JSX } from "react";

import { FlowRunStatus } from "../../domain/flowRun";
import { FlowPlacement, FlowRunOrigin } from "../../domain/types";
import type { FlowRunView, Snapshot } from "../../shared/views";
import { nodeModelOf, orchestratedRunsOf } from "../format";
import { useServices } from "../services";
import { useAppState } from "../store";

import {
  DECISION_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  outcomeText,
  reasonText,
} from "./FlowRunPanel";
import { StatusPill } from "./StatusPill";

const WAITING_FOR_ORCHESTRATOR = "Waiting for the orchestrator";
const IN_PLACE_LABEL = "In place";
const WORKTREE_LABEL = "Worktree";
const NODE_MODEL_SEPARATOR = " · ";
const MODELS_SEPARATOR = ", ";

function statusText(run: FlowRunView): string {
  return run.origin === FlowRunOrigin.orchestrator &&
    run.status === FlowRunStatus.awaitingDecision
    ? WAITING_FOR_ORCHESTRATOR
    : STATUS_LABELS[run.status];
}

function placementText(run: FlowRunView): string {
  if (run.placement !== FlowPlacement.worktree) {
    return IN_PLACE_LABEL;
  }
  return run.branch === null
    ? WORKTREE_LABEL
    : `${WORKTREE_LABEL} · ${run.branch}`;
}

function nodeModelLines(
  run: FlowRunView,
  flowSessions: Snapshot["flowSessions"],
): string[] {
  return run.nodes.flatMap((node) => {
    const model = nodeModelOf(run, node.id, flowSessions);
    return model === null ? [] : [`${node.id}${NODE_MODEL_SEPARATOR}${model}`];
  });
}

function TimelineRun({
  run,
  flowSessions,
  onShowGraph,
}: {
  run: FlowRunView;
  flowSessions: Snapshot["flowSessions"];
  onShowGraph: (runId: string) => void;
}): JSX.Element {
  const outcome = outcomeText(run);
  const models = nodeModelLines(run, flowSessions);
  return (
    <li className="timeline-run">
      <div className="timeline-head">
        <strong>{run.flowTitle}</strong>
        <StatusPill tone={STATUS_TONES[run.status]}>
          {statusText(run)}
        </StatusPill>
        <span>{placementText(run)}</span>
        <span>{`Round ${run.round.toString()} of ${run.maxRounds.toString()}`}</span>
        <div className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => {
            onShowGraph(run.runId);
          }}
        >
          Show graph
        </button>
      </div>
      {run.decision !== null && <p>{reasonText(run, run.decision.reason)}</p>}
      {run.decisions.map((entry, index) => (
        <p key={`${entry.nodeId}-${index.toString()}`} className="timeline-log">
          <span>{`${DECISION_LABELS[entry.decision]} at ${entry.nodeId}`}</span>
          {entry.note !== null && (
            <span className="timeline-note">{entry.note}</span>
          )}
        </p>
      ))}
      {models.length > 0 && (
        <p className="timeline-models">{models.join(MODELS_SEPARATOR)}</p>
      )}
      {outcome !== null && <p className="flow-run-outcome">{outcome}</p>}
    </li>
  );
}

export function OrchestratorTimeline({
  onShowGraph,
}: {
  onShowGraph: () => void;
}): JSX.Element {
  const { store } = useServices();
  const state = useAppState(store);
  const runs = orchestratedRunsOf(state.snapshot);
  return (
    <section
      className="glass panel orchestrator-timeline"
      aria-label="Orchestrator timeline"
    >
      <h2 className="sec">Flows run by the orchestrator</h2>
      {runs.length === 0 ? (
        <p className="empty">No flows yet.</p>
      ) : (
        <ol className="timeline">
          {runs.map((run) => (
            <TimelineRun
              key={run.runId}
              run={run}
              flowSessions={state.snapshot?.flowSessions ?? []}
              onShowGraph={(runId) => {
                store.focusRun(runId);
                onShowGraph();
              }}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
