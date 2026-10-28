import { expect, it } from "vitest";

import { EdgeKind } from "../domain/types";
import { makeFlow } from "../../tests/fakes/fakeIpcClient";

import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  FlowDirection,
  chooseDirection,
  layoutFlow,
  type FlowLabelBox,
} from "./flowLayout";

it("flow_layout_positions_every_node_and_labels_edges", async () => {
  const flow = makeFlow({
    nodes: [
      { id: "plan", agent: "planner" },
      { id: "build", agent: "implementer" },
      { id: "review", agent: "reviewer" },
    ],
    edges: [
      { from: "plan", to: "build", kind: EdgeKind.waitsFor },
      { from: "build", to: "review", kind: EdgeKind.handsOffTo },
      { from: "plan", to: "review", kind: EdgeKind.reviews },
    ],
  });

  const layout = await layoutFlow(flow, FlowDirection.RIGHT);

  expect(layout.nodes.map((node) => node.id)).toEqual([
    "plan",
    "build",
    "review",
  ]);
  const xs = layout.nodes.map((node) => node.position.x);
  expect(xs[0]).toBeLessThan(xs[1] ?? Number.NaN);
  expect(xs[1]).toBeLessThan(xs[2] ?? Number.NaN);
  expect(
    layout.edges.map((edge) => [
      edge.source,
      edge.target,
      edge.data?.label.text,
      edge.data?.kind,
    ]),
  ).toEqual([
    ["plan", "build", "waits for", EdgeKind.waitsFor],
    ["build", "review", "hands off to", EdgeKind.handsOffTo],
    ["plan", "review", "reviews", EdgeKind.reviews],
  ]);
});

it("flow_layout_of_empty_flow_is_empty", async () => {
  const layout = await layoutFlow(
    makeFlow({ nodes: [], edges: [] }),
    FlowDirection.RIGHT,
  );

  expect(layout.nodes).toEqual([]);
  expect(layout.edges).toEqual([]);
});

it("flow_layout_single_node_without_edges", async () => {
  const layout = await layoutFlow(
    makeFlow({ nodes: [{ id: "solo", agent: "planner" }], edges: [] }),
    FlowDirection.DOWN,
  );

  expect(layout.nodes.map((node) => node.id)).toEqual(["solo"]);
  expect(layout.edges).toEqual([]);
  expect(layout.width).toBeGreaterThanOrEqual(FLOW_NODE_WIDTH);
  expect(layout.height).toBeGreaterThanOrEqual(FLOW_NODE_HEIGHT);
});

const FEATURE_DELIVERY = makeFlow({
  id: "feature-delivery",
  nodes: [
    { id: "plan", agent: "planner" },
    { id: "api", agent: "implementer" },
    { id: "ui", agent: "implementer" },
    { id: "test", agent: "tester" },
    { id: "review", agent: "reviewer" },
  ],
  edges: [
    { from: "plan", to: "api", kind: EdgeKind.handsOffTo },
    { from: "plan", to: "ui", kind: EdgeKind.handsOffTo },
    { from: "api", to: "test", kind: EdgeKind.waitsFor },
    { from: "ui", to: "test", kind: EdgeKind.waitsFor },
    { from: "test", to: "review", kind: EdgeKind.handsOffTo },
    { from: "review", to: "api", kind: EdgeKind.reviews },
  ],
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

it.each([FlowDirection.RIGHT, FlowDirection.DOWN])(
  "flow_layout_edge_labels_do_not_overlap_%s",
  async (direction) => {
    const layout = await layoutFlow(FEATURE_DELIVERY, direction);

    const labels: FlowLabelBox[] = layout.edges.flatMap((edge) =>
      edge.data === undefined ? [] : [edge.data.label],
    );
    expect(labels).toHaveLength(6);
    const nodeBoxes: Box[] = layout.nodes.map((node) => ({
      ...node.position,
      width: FLOW_NODE_WIDTH,
      height: FLOW_NODE_HEIGHT,
    }));
    labels.forEach((label, index) => {
      expect(label.x).toBeGreaterThan(0);
      expect(label.y).toBeGreaterThan(0);
      expect(label.x + label.width).toBeLessThanOrEqual(layout.width);
      expect(label.y + label.height).toBeLessThanOrEqual(layout.height);
      labels.slice(index + 1).forEach((other) => {
        expect(overlaps(label, other)).toBe(false);
      });
      nodeBoxes.forEach((node) => {
        expect(overlaps(label, node)).toBe(false);
      });
    });
  },
);

const READABLE_CANVAS = { width: 790, height: 640 };
const MIN_READABLE_FIT_SCALE = 0.75;

it("flow_fit_scale_readable_for_feature_delivery", async () => {
  const right = await layoutFlow(FEATURE_DELIVERY, FlowDirection.RIGHT);
  const down = await layoutFlow(FEATURE_DELIVERY, FlowDirection.DOWN);
  const sizes = {
    [FlowDirection.RIGHT]: right,
    [FlowDirection.DOWN]: down,
  };

  const chosen = sizes[chooseDirection(sizes, READABLE_CANVAS)];

  const scale = Math.min(
    READABLE_CANVAS.width / chosen.width,
    READABLE_CANVAS.height / chosen.height,
  );
  expect(scale).toBeGreaterThanOrEqual(MIN_READABLE_FIT_SCALE);
});

it("flow_layout_reports_graph_bounds_per_direction", async () => {
  const right = await layoutFlow(FEATURE_DELIVERY, FlowDirection.RIGHT);
  const down = await layoutFlow(FEATURE_DELIVERY, FlowDirection.DOWN);

  expect(right.width).toBeGreaterThan(right.height);
  expect(down.height).toBeGreaterThan(down.width);
  expect(
    right.edges.every((edge) => (edge.data?.points.length ?? 0) >= 2),
  ).toBe(true);
});

it("flow_direction_prefers_larger_fit_scale", () => {
  const sizes = {
    RIGHT: { width: 1400, height: 300 },
    DOWN: { width: 500, height: 700 },
  } as const;

  expect(chooseDirection(sizes, { width: 950, height: 800 })).toBe(
    FlowDirection.DOWN,
  );
  expect(chooseDirection(sizes, { width: 3000, height: 400 })).toBe(
    FlowDirection.RIGHT,
  );
});

it("flow_direction_zero_canvas_defaults_right", () => {
  const sizes = {
    RIGHT: { width: 1400, height: 300 },
    DOWN: { width: 500, height: 700 },
  } as const;

  expect(chooseDirection(sizes, { width: 0, height: 800 })).toBe(
    FlowDirection.RIGHT,
  );
  expect(chooseDirection(sizes, { width: 950, height: 0 })).toBe(
    FlowDirection.RIGHT,
  );
});

it("flow_direction_follows_real_feature_delivery_layouts", async () => {
  const sizes = {
    RIGHT: await layoutFlow(FEATURE_DELIVERY, FlowDirection.RIGHT),
    DOWN: await layoutFlow(FEATURE_DELIVERY, FlowDirection.DOWN),
  };

  expect(chooseDirection(sizes, { width: 950, height: 800 })).toBe(
    FlowDirection.DOWN,
  );
  expect(chooseDirection(sizes, { width: 4000, height: 500 })).toBe(
    FlowDirection.RIGHT,
  );
});
