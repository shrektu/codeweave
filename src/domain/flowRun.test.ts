import { describe, expect, it } from "vitest";

import {
  DecisionReason,
  FlowDecision,
  FlowNodeRunStatus,
  FlowRunStatus,
  InvalidDecisionError,
  NodeInputKind,
  Verdict,
  applyDecision,
  nodeFailed,
  nodeSucceeded,
  parseVerdict,
  startRun,
  stopRun,
  type FlowRunState,
  type NodeInput,
  type Transition,
} from "./flowRun";
import type { FlowDefinition } from "./flows";
import { EdgeKind } from "./types";

type EdgeSpec = readonly [
  from: string,
  to: string,
  kind: EdgeKind,
  gate?: true,
];

const HANDS_OFF = EdgeKind.handsOffTo;
const REVIEWS = EdgeKind.reviews;
const WAITS_FOR = EdgeKind.waitsFor;
const APPROVED = "Fine.\nVERDICT: APPROVED";
const CHANGES = "Not yet.\nVERDICT: CHANGES_REQUESTED";
const PLAIN = "done";

function flowOf(
  nodeIds: readonly string[],
  edges: readonly EdgeSpec[],
): FlowDefinition {
  return {
    id: "flow",
    title: "Flow title",
    nodes: nodeIds.map((id) => ({ id, agent: "coder" })),
    edges: edges.map(([from, to, kind, gate]) => ({
      from,
      to,
      kind,
      ...(gate === true ? { gate } : {}),
    })),
  };
}

function init(maxRounds = 2): Parameters<typeof startRun>[1] {
  return { runId: "run-1", cwd: "/work", task: "Do it", maxRounds };
}

function runNodeOf(transition: Transition): {
  nodeId: string;
  inputs: readonly NodeInput[];
} {
  const { command } = transition;
  if (command.type !== "run_node") {
    throw new Error(`expected run_node, got ${command.type}`);
  }
  return command;
}

type Replies = (nodeId: string, visit: number) => string;

interface Driven {
  readonly order: string[];
  readonly inputs: (readonly NodeInput[])[];
  readonly last: Transition;
}

function drive(flow: FlowDefinition, replies: Replies, maxRounds = 2): Driven {
  const order: string[] = [];
  const inputs: (readonly NodeInput[])[] = [];
  let transition = startRun(flow, init(maxRounds));
  while (transition.command.type === "run_node") {
    const { nodeId, inputs: given } = transition.command;
    order.push(nodeId);
    inputs.push(given);
    const visit = order.filter((id) => id === nodeId).length;
    transition = nodeSucceeded(
      transition.state,
      flow,
      nodeId,
      replies(nodeId, visit),
    );
  }
  return { order, inputs, last: transition };
}

function scripted(
  script: Readonly<Record<string, readonly string[]>>,
): Replies {
  return (nodeId, visit) => script[nodeId]?.[visit - 1] ?? PLAIN;
}

function nodeOf(
  state: FlowRunState,
  id: string,
): FlowRunState["nodes"][number] {
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
}

describe("parseVerdict", () => {
  it.each([
    ["Looks good.\nVERDICT: APPROVED", Verdict.approved],
    ["VERDICT: CHANGES_REQUESTED", Verdict.changesRequested],
    ["verdict: approved", Verdict.approved],
    ["Verdict:   Changes_Requested   ", Verdict.changesRequested],
    ["**VERDICT: APPROVED**", Verdict.approved],
    ["`VERDICT: CHANGES_REQUESTED`", Verdict.changesRequested],
    ["Text\r\nVERDICT: APPROVED\r\n", Verdict.approved],
    ["VERDICT: APPROVED\n\n   \n", Verdict.approved],
  ])("reads_%j", (text, expected) => {
    expect(parseVerdict(text)).toBe(expected);
  });

  it.each([
    ["", "an empty reply"],
    ["All good, ship it", "no verdict line"],
    [
      "VERDICT: APPROVED\nThanks for asking!",
      "the verdict not on the last line",
    ],
    ["VERDICT: MAYBE", "an unknown verdict word"],
    ["The VERDICT: APPROVED stands", "the verdict inside a sentence"],
    ["VERDICT: APPROVED, mostly", "trailing words after the verdict"],
  ])("rejects_%j_because_of_%s", (text) => {
    expect(parseVerdict(text)).toBeNull();
  });
});

describe("order", () => {
  it("runs_nodes_without_edges_in_file_order", () => {
    const { order, last } = drive(flowOf(["x", "y", "z"], []), scripted({}));

    expect(order).toEqual(["x", "y", "z"]);
    expect(last.state.status).toBe(FlowRunStatus.done);
    expect(last.command).toEqual({ type: "finished" });
  });

  it("breaks_ties_by_file_order_after_dependencies", () => {
    const flow = flowOf(
      ["c", "a", "b"],
      [
        ["a", "c", HANDS_OFF],
        ["b", "c", WAITS_FOR],
      ],
    );

    expect(drive(flow, scripted({})).order).toEqual(["a", "b", "c"]);
  });

  it("runs_the_reviewed_node_before_its_reviewer_regardless_of_file_order", () => {
    const flow = flowOf(["review", "build"], [["review", "build", REVIEWS]]);

    expect(drive(flow, scripted({ review: [APPROVED] })).order).toEqual([
      "build",
      "review",
    ]);
  });
});

describe("hand-offs", () => {
  it("passes_the_latest_result_of_each_hands_off_predecessor", () => {
    const flow = flowOf(
      ["a", "b", "c"],
      [
        ["a", "c", HANDS_OFF],
        ["b", "c", WAITS_FOR],
      ],
    );

    const { inputs } = drive(flow, scripted({ a: ["from a"], b: ["from b"] }));

    expect(inputs).toEqual([
      [],
      [],
      [{ from: "a", kind: NodeInputKind.handoff, text: "from a" }],
    ]);
  });
});

const BUILD_REVIEW = flowOf(
  ["build", "review"],
  [
    ["build", "review", HANDS_OFF],
    ["review", "build", REVIEWS],
  ],
);

describe("review loop", () => {
  it("reruns_the_target_with_findings_then_the_reviewer", () => {
    const { order, inputs, last } = drive(
      BUILD_REVIEW,
      scripted({ build: ["v1", "v2"], review: [CHANGES, APPROVED] }),
    );

    expect(order).toEqual(["build", "review", "build", "review"]);
    expect(inputs[2]).toEqual([
      { from: "review", kind: NodeInputKind.findings, text: CHANGES },
    ]);
    expect(inputs[3]).toEqual([
      { from: "build", kind: NodeInputKind.handoff, text: "v2" },
    ]);
    expect(last.state.status).toBe(FlowRunStatus.done);
    expect(last.state.rounds).toEqual(new Map([["review", 2]]));
  });

  it("consumes_findings_once_they_are_delivered", () => {
    const { inputs } = drive(
      BUILD_REVIEW,
      scripted({ review: [CHANGES, CHANGES, APPROVED] }),
      3,
    );

    expect(inputs[2]).toHaveLength(1);
    expect(inputs[4]).toHaveLength(1);
    expect(inputs[2]?.[0]?.text).toBe(CHANGES);
  });

  it("pauses_with_rounds_exhausted_on_the_last_allowed_round", () => {
    const { order, last } = drive(
      BUILD_REVIEW,
      scripted({ review: [CHANGES, CHANGES, APPROVED] }),
      2,
    );

    expect(order).toEqual(["build", "review", "build", "review"]);
    expect(last.command).toEqual({ type: "await_decision" });
    expect(last.state.status).toBe(FlowRunStatus.awaitingDecision);
    expect(last.state.decision).toEqual({
      reason: DecisionReason.roundsExhausted,
      nodeId: "review",
    });
  });

  it("honours_a_larger_max_rounds", () => {
    const { order, last } = drive(
      BUILD_REVIEW,
      scripted({ review: [CHANGES, CHANGES, APPROVED] }),
      3,
    );

    expect(order).toHaveLength(6);
    expect(last.state.status).toBe(FlowRunStatus.done);
  });

  it("pauses_when_the_reply_has_no_verdict", () => {
    const { last } = drive(BUILD_REVIEW, scripted({ review: ["Looks ok"] }));

    expect(last.state.decision).toEqual({
      reason: DecisionReason.missingVerdict,
      nodeId: "review",
    });
    expect(nodeOf(last.state, "review").status).toBe(FlowNodeRunStatus.done);
  });
});

describe("review rework scope", () => {
  it("reruns_exactly_the_nodes_between_target_and_reviewer", () => {
    const flow = flowOf(
      ["prep", "build", "mid", "review", "deploy"],
      [
        ["prep", "build", HANDS_OFF],
        ["build", "mid", HANDS_OFF],
        ["mid", "review", HANDS_OFF],
        ["review", "build", REVIEWS],
        ["review", "deploy", HANDS_OFF],
      ],
    );

    const { order, last } = drive(
      flow,
      scripted({ review: [CHANGES, APPROVED] }),
      3,
    );

    expect(order).toEqual([
      "prep",
      "build",
      "mid",
      "review",
      "build",
      "mid",
      "review",
      "deploy",
    ]);
    expect(last.state.status).toBe(FlowRunStatus.done);
    expect(nodeOf(last.state, "prep").visits).toBe(1);
    expect(nodeOf(last.state, "deploy").visits).toBe(1);
  });

  it("marks_nodes_scheduled_for_another_pass_as_queued", () => {
    let transition = startRun(BUILD_REVIEW, init());
    transition = nodeSucceeded(transition.state, BUILD_REVIEW, "build", "v1");
    transition = nodeSucceeded(
      transition.state,
      BUILD_REVIEW,
      "review",
      CHANGES,
    );

    expect(runNodeOf(transition).nodeId).toBe("build");
    expect(
      transition.state.nodes.map((node) => [node.id, node.status, node.visits]),
    ).toEqual([
      ["build", FlowNodeRunStatus.running, 2],
      ["review", FlowNodeRunStatus.queued, 1],
    ]);
  });

  it("never_runs_a_single_reviewer_more_than_max_rounds_times", () => {
    const { order } = drive(BUILD_REVIEW, () => CHANGES, 4);

    expect(order.filter((id) => id === "review")).toHaveLength(4);
  });
});

describe("gates", () => {
  const GATED = flowOf(
    ["a", "b", "r"],
    [
      ["a", "b", HANDS_OFF, true],
      ["b", "r", HANDS_OFF],
      ["r", "b", REVIEWS],
    ],
  );

  it("pauses_before_the_target_until_approved", () => {
    const first = startRun(GATED, init());
    const paused = nodeSucceeded(first.state, GATED, "a", "from a");

    expect(paused.command).toEqual({ type: "await_decision" });
    expect(paused.state.decision).toEqual({
      reason: DecisionReason.gate,
      nodeId: "b",
    });
    expect(nodeOf(paused.state, "b").visits).toBe(0);

    const resumed = applyDecision(paused.state, GATED, FlowDecision.approve);

    expect(resumed.command).toEqual({
      type: "run_node",
      nodeId: "b",
      inputs: [{ from: "a", kind: NodeInputKind.handoff, text: "from a" }],
    });
    expect(resumed.state.status).toBe(FlowRunStatus.running);
    expect(resumed.state.decision).toBeNull();
  });

  it("is_not_asked_again_when_only_the_target_is_reworked", () => {
    let transition = startRun(GATED, init(3));
    transition = nodeSucceeded(transition.state, GATED, "a", "x");
    transition = applyDecision(transition.state, GATED, FlowDecision.approve);
    transition = nodeSucceeded(transition.state, GATED, "b", "y");
    transition = nodeSucceeded(transition.state, GATED, "r", CHANGES);

    expect(runNodeOf(transition).nodeId).toBe("b");
    expect(transition.state.decision).toBeNull();
  });

  it("is_asked_again_when_the_source_runs_another_visit", () => {
    const flow = flowOf(
      ["a", "b"],
      [
        ["a", "b", HANDS_OFF, true],
        ["b", "a", REVIEWS],
      ],
    );
    let transition = startRun(flow, init(3));
    transition = nodeSucceeded(transition.state, flow, "a", "x");
    transition = applyDecision(transition.state, flow, FlowDecision.approve);
    transition = nodeSucceeded(transition.state, flow, "b", CHANGES);

    expect(runNodeOf(transition).nodeId).toBe("a");

    transition = nodeSucceeded(transition.state, flow, "a", "x2");

    expect(transition.command).toEqual({ type: "await_decision" });
    expect(transition.state.decision).toEqual({
      reason: DecisionReason.gate,
      nodeId: "b",
    });
  });
});

describe("gate on a reviews edge", () => {
  const GATED_REVIEW = flowOf(
    ["build", "review"],
    [
      ["build", "review", HANDS_OFF],
      ["review", "build", REVIEWS, true],
    ],
  );

  it("flow_run_gate_on_reviews_edge_pauses_rework", () => {
    let transition = startRun(GATED_REVIEW, init(3));
    transition = nodeSucceeded(transition.state, GATED_REVIEW, "build", "v1");
    transition = nodeSucceeded(
      transition.state,
      GATED_REVIEW,
      "review",
      CHANGES,
    );

    expect(transition.command).toEqual({ type: "await_decision" });
    expect(transition.state.decision).toEqual({
      reason: DecisionReason.gate,
      nodeId: "build",
    });
    expect(nodeOf(transition.state, "build").visits).toBe(1);

    transition = applyDecision(
      transition.state,
      GATED_REVIEW,
      FlowDecision.approve,
    );

    expect(runNodeOf(transition).nodeId).toBe("build");

    transition = nodeSucceeded(transition.state, GATED_REVIEW, "build", "v2");

    expect(runNodeOf(transition).nodeId).toBe("review");

    transition = nodeSucceeded(
      transition.state,
      GATED_REVIEW,
      "review",
      CHANGES,
    );

    expect(transition.state.decision).toEqual({
      reason: DecisionReason.gate,
      nodeId: "build",
    });
  });

  it("flow_run_another_round_does_not_ask_gate_twice", () => {
    const flow = GATED_REVIEW;
    let transition = startRun(flow, init(1));
    transition = nodeSucceeded(transition.state, flow, "build", "v1");
    transition = nodeSucceeded(transition.state, flow, "review", CHANGES);

    expect(transition.state.decision).toEqual({
      reason: DecisionReason.roundsExhausted,
      nodeId: "review",
    });

    transition = applyDecision(
      transition.state,
      flow,
      FlowDecision.anotherRound,
    );

    expect(runNodeOf(transition).nodeId).toBe("build");
    expect(transition.state.decision).toBeNull();
  });

  it("flow_run_other_reviewer_rework_skips_foreign_gate", () => {
    const flow = flowOf(
      ["build", "r1", "r2"],
      [
        ["build", "r1", HANDS_OFF],
        ["r1", "r2", HANDS_OFF],
        ["r1", "build", REVIEWS, true],
        ["r2", "build", REVIEWS],
      ],
    );
    let transition = startRun(flow, init(3));
    transition = nodeSucceeded(transition.state, flow, "build", "v1");
    transition = nodeSucceeded(transition.state, flow, "r1", APPROVED);
    transition = nodeSucceeded(transition.state, flow, "r2", CHANGES);

    expect(runNodeOf(transition).nodeId).toBe("build");
    expect(transition.state.decision).toBeNull();
  });

  describe("with parallel reviewers", () => {
    const PARALLEL = flowOf(
      ["build", "r1", "r2"],
      [
        ["r1", "build", REVIEWS, true],
        ["r2", "build", REVIEWS],
      ],
    );

    it("flow_run_parallel_reviewer_rework_skips_foreign_gate", () => {
      let transition = startRun(PARALLEL, init(3));
      transition = nodeSucceeded(transition.state, PARALLEL, "build", "v1");
      transition = nodeSucceeded(transition.state, PARALLEL, "r1", APPROVED);
      transition = nodeSucceeded(transition.state, PARALLEL, "r2", CHANGES);

      expect(runNodeOf(transition).nodeId).toBe("build");
      expect(transition.state.decision).toBeNull();
    });

    it("flow_run_approved_gated_reviewer_does_not_block_later_rework", () => {
      let transition = startRun(PARALLEL, init(3));
      transition = nodeSucceeded(transition.state, PARALLEL, "build", "v1");
      transition = nodeSucceeded(transition.state, PARALLEL, "r1", CHANGES);

      expect(transition.state.decision).toEqual({
        reason: DecisionReason.gate,
        nodeId: "build",
      });

      transition = applyDecision(
        transition.state,
        PARALLEL,
        FlowDecision.approve,
      );
      transition = nodeSucceeded(transition.state, PARALLEL, "build", "v2");

      expect(runNodeOf(transition).nodeId).toBe("r1");

      transition = nodeSucceeded(transition.state, PARALLEL, "r1", APPROVED);
      transition = nodeSucceeded(transition.state, PARALLEL, "r2", CHANGES);

      expect(runNodeOf(transition).nodeId).toBe("build");
      expect(transition.state.decision).toBeNull();
    });
  });
});

const GATED_PAIR = flowOf(["a", "b"], [["a", "b", HANDS_OFF, true]]);

function exhausted(): FlowRunState {
  return drive(BUILD_REVIEW, scripted({ review: [CHANGES, CHANGES] })).last
    .state;
}

function gated(): FlowRunState {
  const first = startRun(GATED_PAIR, init());
  return nodeSucceeded(first.state, GATED_PAIR, "a", "x").state;
}

describe("decisions at a gate", () => {
  it("rejects_another_round_at_a_gate", () => {
    expect(() =>
      applyDecision(gated(), GATED_PAIR, FlowDecision.anotherRound),
    ).toThrow(InvalidDecisionError);
  });

  it("rejects_any_decision_when_none_is_pending", () => {
    const running = startRun(BUILD_REVIEW, init()).state;

    expect(() =>
      applyDecision(running, BUILD_REVIEW, FlowDecision.approve),
    ).toThrow(InvalidDecisionError);
  });

  it("stops_the_run_at_a_gate", () => {
    const { state, command } = applyDecision(
      gated(),
      GATED_PAIR,
      FlowDecision.stop,
    );

    expect(state.status).toBe(FlowRunStatus.stopped);
    expect(state.decision).toBeNull();
    expect(command).toEqual({ type: "finished" });
  });
});

describe("decisions after a review", () => {
  it("treats_approve_after_exhausted_rounds_as_approved", () => {
    const { state, command } = applyDecision(
      exhausted(),
      BUILD_REVIEW,
      FlowDecision.approve,
    );

    expect(state.status).toBe(FlowRunStatus.done);
    expect(command).toEqual({ type: "finished" });
  });

  it("allows_one_more_round_past_max_rounds_and_pauses_again", () => {
    const resumed = applyDecision(
      exhausted(),
      BUILD_REVIEW,
      FlowDecision.anotherRound,
    );

    expect(runNodeOf(resumed).nodeId).toBe("build");
    expect(runNodeOf(resumed).inputs).toEqual([
      { from: "review", kind: NodeInputKind.findings, text: CHANGES },
    ]);

    const afterBuild = nodeSucceeded(
      resumed.state,
      BUILD_REVIEW,
      "build",
      "v3",
    );
    const afterReview = nodeSucceeded(
      afterBuild.state,
      BUILD_REVIEW,
      "review",
      CHANGES,
    );

    expect(afterReview.state.decision?.reason).toBe(
      DecisionReason.roundsExhausted,
    );
    expect(afterReview.state.rounds).toEqual(new Map([["review", 3]]));
  });
});

describe("decisions after a missing verdict", () => {
  it("feeds_the_unverdicted_reply_back_on_another_round", () => {
    const paused = drive(
      BUILD_REVIEW,
      scripted({ review: ["Needs work"] }),
    ).last;

    const resumed = applyDecision(
      paused.state,
      BUILD_REVIEW,
      FlowDecision.anotherRound,
    );

    expect(runNodeOf(resumed).inputs).toEqual([
      { from: "review", kind: NodeInputKind.findings, text: "Needs work" },
    ]);
  });
});

describe("terminal transitions", () => {
  it("fails_the_run_and_the_node_with_the_message", () => {
    const flow = flowOf(["a", "b"], []);
    const started = startRun(flow, init());

    const { state, command } = nodeFailed(started.state, "a", "boom");

    expect(state.status).toBe(FlowRunStatus.failed);
    expect(state.failure).toBe("boom");
    expect(nodeOf(state, "a").status).toBe(FlowNodeRunStatus.failed);
    expect(command).toEqual({ type: "finished" });
  });

  it("stops_a_running_run_and_releases_the_running_node", () => {
    const flow = flowOf(["a", "b"], []);
    const started = startRun(flow, init());

    const { state } = stopRun(started.state);

    expect(state.status).toBe(FlowRunStatus.stopped);
    expect(nodeOf(state, "a").status).toBe(FlowNodeRunStatus.idle);
  });
});

function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface GeneratedFlow {
  readonly flow: FlowDefinition;
  readonly reviewers: readonly string[];
}

function generateFlow(random: () => number): GeneratedFlow {
  const count = 2 + Math.floor(random() * 5);
  const ids = Array.from({ length: count }, (_, index) => `n${String(index)}`);
  const edges: EdgeSpec[] = [];
  for (let from = 0; from < count; from += 1) {
    for (let to = from + 1; to < count; to += 1) {
      const roll = random();
      const source = ids[from] ?? "";
      const target = ids[to] ?? "";
      if (roll < 0.3) {
        edges.push([source, target, HANDS_OFF]);
      } else if (roll < 0.5) {
        edges.push([target, source, REVIEWS]);
      }
    }
  }
  const fileOrder = ids.toSorted(() => random() - 0.5);
  return {
    flow: flowOf(fileOrder, edges),
    reviewers: [
      ...new Set(
        edges.filter(([, , kind]) => kind === REVIEWS).map(([from]) => from),
      ),
    ],
  };
}

function randomReply(random: () => number): string {
  const roll = random();
  if (roll < 0.4) {
    return APPROVED;
  }
  return roll < 0.9 ? CHANGES : PLAIN;
}

describe("generated flows without human decisions", () => {
  const FLOW_COUNT = 300;

  it.each(Array.from({ length: FLOW_COUNT }, (_, seed) => seed))(
    "terminates_within_the_round_budget_for_seed_%i",
    (seed) => {
      const random = makeRandom(seed);
      const { flow, reviewers } = generateFlow(random);
      const maxRounds = 1 + Math.floor(random() * 3);
      const budget = flow.nodes.length * (maxRounds * reviewers.length + 1);

      const { order, last } = drive(flow, () => randomReply(random), maxRounds);

      expect([FlowRunStatus.done, FlowRunStatus.awaitingDecision]).toContain(
        last.state.status,
      );
      expect(order.length).toBeLessThanOrEqual(budget);
      if (last.state.status === FlowRunStatus.done) {
        expect(last.state.pending).toEqual([]);
      }
      for (const reviewer of reviewers) {
        const runs = order.filter((id) => id === reviewer).length;
        expect(runs).toBeLessThanOrEqual(
          1 + reviewers.length * (maxRounds - 1),
        );
      }
      if (reviewers.length === 1) {
        const [only] = reviewers;
        expect(order.filter((id) => id === only).length).toBeLessThanOrEqual(
          maxRounds,
        );
      }
    },
  );

  it("fails_cleanly_when_a_random_node_fails", () => {
    for (let seed = 0; seed < FLOW_COUNT; seed += 1) {
      const random = makeRandom(seed);
      const { flow } = generateFlow(random);
      let transition = startRun(flow, init());
      let steps = 0;
      while (transition.command.type === "run_node") {
        const { nodeId } = runNodeOf(transition);
        steps += 1;
        transition =
          random() < 0.15
            ? nodeFailed(transition.state, nodeId, "boom")
            : nodeSucceeded(
                transition.state,
                flow,
                nodeId,
                randomReply(random),
              );
      }
      expect(steps).toBeGreaterThan(0);
      expect(transition.command.type).not.toBe("run_node");
      if (transition.state.status === FlowRunStatus.failed) {
        expect(transition.state.failure).toBe("boom");
      }
    }
  });
});

describe("prototype-named nodes", () => {
  it("flow_run_handles_prototype_named_node_ids", () => {
    const flow = flowOf(
      ["constructor", "__proto__"],
      [
        ["constructor", "__proto__", HANDS_OFF],
        ["__proto__", "constructor", REVIEWS],
      ],
    );

    const { order, inputs, last } = drive(flow, (nodeId, visit) =>
      nodeId === "__proto__" && visit === 1 ? CHANGES : APPROVED,
    );

    expect(order).toEqual([
      "constructor",
      "__proto__",
      "constructor",
      "__proto__",
    ]);
    expect(inputs[2]).toEqual([
      { from: "__proto__", kind: NodeInputKind.findings, text: CHANGES },
    ]);
    expect(last.state.status).toBe(FlowRunStatus.done);
    expect(last.state.rounds).toEqual(new Map([["__proto__", 2]]));
  });
});
