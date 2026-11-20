import { expect, it } from "vitest";

import { SAMPLE_RUN } from "../../tests/fakes/fakeFlowControl";
import type { FlowRunView } from "../shared/views";

import { DEFAULT_MAX_RESULT_CHARS } from "./constants";
import { DecisionReason, FlowNodeRunStatus, FlowRunStatus } from "./flowRun";
import { FlowPlacement } from "./types";
import { buildFlowReport } from "./orchestratorReport";

const LONG_RESULT_LENGTH = DEFAULT_MAX_RESULT_CHARS + 500;

function view(overrides: Partial<FlowRunView>): FlowRunView {
  return { ...SAMPLE_RUN, ...overrides };
}

it("starts_with_the_codeweave_marker_and_describes_every_run", () => {
  const report = buildFlowReport([
    { view: view({ runId: "run-1" }), note: null },
    {
      view: view({
        runId: "run-2",
        status: FlowRunStatus.done,
        decision: null,
        placement: FlowPlacement.worktree,
        branch: "codeweave/run-2",
      }),
      note: null,
    },
  ]);

  expect(report.startsWith("[Codeweave]")).toBe(true);
  expect(report).toContain("Run run-1: flow review (Review flow)");
  expect(report).toContain("Run run-2: flow review (Review flow)");
  expect(report).toContain("Placement: in_place\n");
  expect(report).toContain("Placement: worktree, branch codeweave/run-2");
  expect(report).toContain("Status: awaiting_decision");
  expect(report).toContain("Round: 1/3");
  expect(report).toContain("- write: done, visits 1");
  expect(report).toContain("- check: done, visits 1");
});

it("names_the_decision_reason_the_node_and_the_decide_values_of_a_gate", () => {
  const report = buildFlowReport([{ view: view({}), note: null }]);

  expect(report).toContain(
    "Decision needed: gate at node check. Call decide with one of: approve, stop.",
  );
});

it("offers_another_round_when_the_rounds_are_exhausted", () => {
  const report = buildFlowReport([
    {
      view: view({
        decision: { reason: DecisionReason.roundsExhausted, nodeId: "check" },
      }),
      note: null,
    },
  ]);

  expect(report).toContain(
    "Decision needed: rounds_exhausted at node check. Call decide with one of: approve, another_round, stop.",
  );
});

it("reports_the_failure_of_a_failed_run_and_no_decision", () => {
  const report = buildFlowReport([
    {
      view: view({
        status: FlowRunStatus.failed,
        decision: null,
        failure: "The agent exited",
      }),
      note: null,
    },
  ]);

  expect(report).toContain("Failure: The agent exited");
  expect(report).not.toContain("Decision needed");
});

it("truncates_a_long_node_result_and_points_to_node_result", () => {
  const long = "x".repeat(LONG_RESULT_LENGTH);
  const report = buildFlowReport([
    {
      view: view({
        nodes: [
          {
            id: "write",
            status: FlowNodeRunStatus.done,
            visits: 1,
            result: long,
          },
        ],
      }),
      note: null,
    },
  ]);

  expect(report).toContain("Result of node write:");
  expect(report).toContain(
    `${"x".repeat(DEFAULT_MAX_RESULT_CHARS)}\n[truncated, 500 more characters]`,
  );
  expect(report).not.toContain("x".repeat(DEFAULT_MAX_RESULT_CHARS + 1));
  expect(report).toContain(
    "Use node_result with runId run-1 and nodeId write for the full text.",
  );
});

it("keeps_a_short_result_whole_and_skips_nodes_without_a_result", () => {
  const report = buildFlowReport([{ view: view({}), note: null }]);

  expect(report).toContain("Result of node write:\ndone\n");
  expect(report).not.toContain("Result of node check");
  expect(report).not.toContain("[truncated");
});

it("includes_the_note_of_a_run", () => {
  const report = buildFlowReport([
    {
      view: view({ status: FlowRunStatus.done, decision: null }),
      note: "Committing the flow changes failed: hook declined",
    },
  ]);

  expect(report).toContain(
    "Note: Committing the flow changes failed: hook declined",
  );
});

it("omits_the_note_line_when_there_is_no_note", () => {
  const report = buildFlowReport([{ view: view({}), note: null }]);

  expect(report).not.toContain("Note:");
});
