import { Play, Square } from "lucide-react";
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

import { Icon } from "./Icon";
import { StatusPill, StatusTone } from "./StatusPill";

const NO_FOLDER_MESSAGE = "Choose a project folder to run this flow.";
const SESSION_LIVE_MESSAGE = "End the current session to run a flow.";
const EDITING_MESSAGE = "Save or discard your edits to run the flow.";

interface DecisionChoice {
  decision: FlowDecision;
  label: string;
  offered: (reason: DecisionReason) => boolean;
}

export const DECISION_LABELS: Readonly<Record<FlowDecision, string>> = {
  [FlowDecision.approve]: "Approve",
  [FlowDecision.anotherRound]: "Another round",
  [FlowDecision.stop]: "Stop",
};

const DECISION_CHOICES: readonly DecisionChoice[] = [
  {
    decision: FlowDecision.approve,
    label: DECISION_LABELS[FlowDecision.approve],
    offered: () => true,
  },
  {
    decision: FlowDecision.anotherRound,
    label: DECISION_LABELS[FlowDecision.anotherRound],
    offered: (reason) => reason !== DecisionReason.gate,
  },
  {
    decision: FlowDecision.stop,
    label: DECISION_LABELS[FlowDecision.stop],
    offered: () => true,
  },
];

export const STATUS_LABELS: Readonly<Record<FlowRunStatus, string>> = {
  [FlowRunStatus.running]: "Running",
  [FlowRunStatus.awaitingDecision]: "Waiting for your decision",
  [FlowRunStatus.done]: "Done",
  [FlowRunStatus.failed]: "Failed",
  [FlowRunStatus.stopped]: "Stopped",
};

export const STATUS_TONES: Readonly<Record<FlowRunStatus, StatusTone>> = {
  [FlowRunStatus.running]: StatusTone.active,
  [FlowRunStatus.awaitingDecision]: StatusTone.waiting,
  [FlowRunStatus.done]: StatusTone.success,
  [FlowRunStatus.failed]: StatusTone.danger,
  [FlowRunStatus.stopped]: StatusTone.neutral,
};

function reviewsText({ round, maxRounds }: FlowRunView): string {
  return round <= maxRounds
    ? `Reviews: ${round.toString()} of ${maxRounds.toString()}`
    : `Reviews: ${round.toString()} (limit ${maxRounds.toString()})`;
}

export function reasonText(run: FlowRunView, reason: DecisionReason): string {
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

export function outcomeText(run: FlowRunView): string | null {
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

function blockerOf(
  cwd: string | null,
  sessionLive: boolean,
  editing: boolean,
): string | null {
  if (cwd === null) {
    return NO_FOLDER_MESSAGE;
  }
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
        <StatusPill tone={STATUS_TONES[run.status]}>
          {STATUS_LABELS[run.status]}
        </StatusPill>
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
          <Icon icon={Square} />
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
  cwd: string | null;
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
            if (cwd !== null) {
              void action.run(() =>
                client.request("flow/start", {
                  cwd,
                  flowId: flow.id,
                  task: trimmed,
                }),
              );
            }
          }}
        >
          <Icon icon={Play} />
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
  cwd: string | null;
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
              disabledReason={blockerOf(cwd, sessionLive, editing)}
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
