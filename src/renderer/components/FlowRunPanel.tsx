import { useState, type JSX } from "react";

import {
  DecisionReason,
  FlowDecision,
  FlowRunStatus,
} from "../../domain/flowRun";
import { isRunOpen } from "../../domain/flowState";
import type { FlowRunView, FlowView } from "../../shared/views";
import { useApp } from "../services";
import { useAsyncAction, type AsyncAction } from "../useAsyncAction";

const SESSION_LIVE_MESSAGE = "End the current session to run a flow.";
const EDITING_MESSAGE = "Save or discard your edits to run the flow.";

interface DecisionChoice {
  decision: FlowDecision;
  label: string;
  offered: (reason: DecisionReason) => boolean;
}

const DECISION_CHOICES: readonly DecisionChoice[] = [
  { decision: FlowDecision.approve, label: "Approve", offered: () => true },
  {
    decision: FlowDecision.anotherRound,
    label: "Another round",
    offered: (reason) => reason !== DecisionReason.gate,
  },
  { decision: FlowDecision.stop, label: "Stop", offered: () => true },
];

const STATUS_LABELS: Readonly<Record<FlowRunStatus, string>> = {
  [FlowRunStatus.running]: "Running",
  [FlowRunStatus.awaitingDecision]: "Waiting for your decision",
  [FlowRunStatus.done]: "Done",
  [FlowRunStatus.failed]: "Failed",
  [FlowRunStatus.stopped]: "Stopped",
};

function reviewsText({ round, maxRounds }: FlowRunView): string {
  return round <= maxRounds
    ? `Reviews: ${round.toString()} of ${maxRounds.toString()}`
    : `Reviews: ${round.toString()} (limit ${maxRounds.toString()})`;
}

function reasonText(run: FlowRunView, reason: DecisionReason): string {
  const nodeId = run.decision?.nodeId ?? "";
  const reviews = run.nodes.find((node) => node.id === nodeId)?.visits ?? 0;
  switch (reason) {
    case DecisionReason.gate:
      return `Approve to continue to ${nodeId}.`;
    case DecisionReason.roundsExhausted:
      return `${nodeId} still requests changes after ${reviews.toString()} reviews.`;
    case DecisionReason.missingVerdict:
      return `${nodeId} ended without a verdict.`;
  }
}

function outcomeText(run: FlowRunView): string | null {
  switch (run.status) {
    case FlowRunStatus.done:
      return "Flow finished.";
    case FlowRunStatus.failed:
      return `Flow failed: ${run.failure ?? "unknown error"}`;
    case FlowRunStatus.stopped:
      return "Flow stopped.";
    case FlowRunStatus.running:
    case FlowRunStatus.awaitingDecision:
      return null;
  }
}

function blockerOf(sessionLive: boolean, editing: boolean): string | null {
  if (sessionLive) {
    return SESSION_LIVE_MESSAGE;
  }
  return editing ? EDITING_MESSAGE : null;
}

function DecisionBanner({
  run,
  action,
}: {
  run: FlowRunView;
  action: AsyncAction;
}): JSX.Element | null {
  const { client } = useApp();
  if (run.status !== FlowRunStatus.awaitingDecision || run.decision === null) {
    return null;
  }
  const { reason } = run.decision;
  return (
    <div className="flow-run-banner" role="alert">
      <p>{reasonText(run, reason)}</p>
      <div className="flow-run-actions">
        {DECISION_CHOICES.filter((choice) => choice.offered(reason)).map(
          (choice) => (
            <button
              key={choice.decision}
              type="button"
              className={
                choice.decision === FlowDecision.approve ? "btn pri" : "btn"
              }
              disabled={action.pending}
              onClick={() => {
                void action.run(() =>
                  client.request("flow/decide", {
                    runId: run.runId,
                    decision: choice.decision,
                  }),
                );
              }}
            >
              {choice.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function NodeResults({ run }: { run: FlowRunView }): JSX.Element | null {
  const withResults = run.nodes.filter((node) => node.result !== null);
  if (withResults.length === 0) {
    return null;
  }
  return (
    <div className="flow-run-results">
      {withResults.map((node) => (
        <details key={node.id}>
          <summary>{`${node.id} · visits ${node.visits.toString()}`}</summary>
          <pre>{node.result}</pre>
        </details>
      ))}
    </div>
  );
}

function OpenRun({
  run,
  action,
}: {
  run: FlowRunView;
  action: AsyncAction;
}): JSX.Element {
  const { client } = useApp();
  return (
    <div className="flow-run-open">
      <div className="flow-run-head">
        <strong>{run.flowTitle}</strong>
        <span className="pill">{STATUS_LABELS[run.status]}</span>
        <span>{reviewsText(run)}</span>
        {run.currentNodeId !== null && (
          <span>{`Node: ${run.currentNodeId}`}</span>
        )}
        <div className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={action.pending}
          onClick={() => {
            void action.run(() =>
              client.request("flow/stop", { runId: run.runId }),
            );
          }}
        >
          Stop flow
        </button>
      </div>
      <p className="flow-run-task" title={run.task}>
        {run.task}
      </p>
      <DecisionBanner run={run} action={action} />
    </div>
  );
}

function RunForm({
  cwd,
  flow,
  disabledReason,
  action,
}: {
  cwd: string;
  flow: FlowView;
  disabledReason: string | null;
  action: AsyncAction;
}): JSX.Element {
  const { client } = useApp();
  const [task, setTask] = useState("");
  const trimmed = task.trim();
  return (
    <form
      className="flow-run-form"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <label className="flow-run-label">
        Task
        <textarea
          rows={2}
          value={task}
          onChange={(event) => {
            setTask(event.target.value);
          }}
        />
      </label>
      <div className="flow-run-actions">
        <button
          type="button"
          className="btn pri"
          disabled={trimmed === "" || disabledReason !== null || action.pending}
          onClick={() => {
            void action.run(() =>
              client.request("flow/start", {
                cwd,
                flowId: flow.id,
                task: trimmed,
              }),
            );
          }}
        >
          Run flow
        </button>
        {disabledReason !== null && (
          <span className="empty">{disabledReason}</span>
        )}
      </div>
    </form>
  );
}

export function FlowRunPanel({
  cwd,
  flow,
  run,
  sessionLive,
  editing,
}: {
  cwd: string;
  flow: FlowView | undefined;
  run: FlowRunView | null;
  sessionLive: boolean;
  editing: boolean;
}): JSX.Element {
  const action = useAsyncAction();
  const outcome = run === null ? null : outcomeText(run);

  return (
    <section className="flow-run" aria-label="Flow run">
      {run !== null && isRunOpen(run.status) ? (
        <OpenRun run={run} action={action} />
      ) : (
        <>
          {outcome !== null && <p className="flow-run-outcome">{outcome}</p>}
          {flow !== undefined && (
            <RunForm
              cwd={cwd}
              flow={flow}
              disabledReason={blockerOf(sessionLive, editing)}
              action={action}
            />
          )}
        </>
      )}
      {action.error !== null && <p className="error">{action.error}</p>}
      {run !== null && <NodeResults run={run} />}
    </section>
  );
}
