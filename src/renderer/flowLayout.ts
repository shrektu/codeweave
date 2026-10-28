import { Position, type Edge, type Node, type NodeHandle } from "@xyflow/react";
import ELK, {
  type ElkEdgeSection,
  type ElkExtendedEdge,
  type ElkNode,
} from "elkjs/lib/elk.bundled.js";

import { EdgeKind } from "../domain/types";
import type { FlowView } from "../shared/views";

export const FLOW_NODE_WIDTH = 220;
export const FLOW_NODE_HEIGHT = 96;
export const FLOW_EDGE_TYPE = "elk";
const NODE_SPACING = "48";
const LAYER_SPACING = "40";
const LABEL_CHAR_WIDTH = 7;
const LABEL_PADDING = 20;
const LABEL_HEIGHT = 22;

export const FlowDirection = { RIGHT: "RIGHT", DOWN: "DOWN" } as const;
export type FlowDirection = (typeof FlowDirection)[keyof typeof FlowDirection];

export const EDGE_LABELS: Readonly<Record<EdgeKind, string>> = {
  [EdgeKind.waitsFor]: "waits for",
  [EdgeKind.handsOffTo]: "hands off to",
  [EdgeKind.reviews]: "reviews",
};

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowLabelBox extends FlowPoint {
  width: number;
  height: number;
  text: string;
}

export type FlowEdgeData = Record<string, unknown> & {
  points: FlowPoint[];
  label: FlowLabelBox;
  kind: EdgeKind;
};
export type FlowLayoutEdge = Edge<FlowEdgeData, typeof FLOW_EDGE_TYPE>;

export interface FlowSize {
  width: number;
  height: number;
}

export interface FlowLayout extends FlowSize {
  nodes: Node[];
  edges: FlowLayoutEdge[];
}

const HANDLES: Readonly<Record<FlowDirection, NodeHandle[]>> = {
  [FlowDirection.RIGHT]: [
    { type: "target", position: Position.Left, x: 0, y: FLOW_NODE_HEIGHT / 2 },
    {
      type: "source",
      position: Position.Right,
      x: FLOW_NODE_WIDTH,
      y: FLOW_NODE_HEIGHT / 2,
    },
  ],
  [FlowDirection.DOWN]: [
    { type: "target", position: Position.Top, x: FLOW_NODE_WIDTH / 2, y: 0 },
    {
      type: "source",
      position: Position.Bottom,
      x: FLOW_NODE_WIDTH / 2,
      y: FLOW_NODE_HEIGHT,
    },
  ],
};

const elk = new ELK();

function labelSize(text: string): FlowSize {
  return {
    width: text.length * LABEL_CHAR_WIDTH + LABEL_PADDING,
    height: LABEL_HEIGHT,
  };
}

function pointsOf(section: ElkEdgeSection | undefined): FlowPoint[] {
  if (section === undefined) {
    return [];
  }
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

function fitScale(size: FlowSize, canvas: FlowSize): number {
  return Math.min(canvas.width / size.width, canvas.height / size.height);
}

export function chooseDirection(
  sizes: Readonly<Record<FlowDirection, FlowSize>>,
  canvas: FlowSize,
): FlowDirection {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return FlowDirection.RIGHT;
  }
  return fitScale(sizes[FlowDirection.DOWN], canvas) >
    fitScale(sizes[FlowDirection.RIGHT], canvas)
    ? FlowDirection.DOWN
    : FlowDirection.RIGHT;
}

function toLayoutEdge(
  flowEdge: FlowView["edges"][number],
  laid: ElkExtendedEdge | undefined,
  index: number,
): FlowLayoutEdge {
  const text = EDGE_LABELS[flowEdge.kind];
  const placed = laid?.labels?.[0];
  const size = labelSize(text);
  return {
    id: `edge-${index.toString()}`,
    type: FLOW_EDGE_TYPE,
    source: flowEdge.from,
    target: flowEdge.to,
    data: {
      points: pointsOf(laid?.sections?.[0]),
      label: {
        x: placed?.x ?? 0,
        y: placed?.y ?? 0,
        width: size.width,
        height: size.height,
        text,
      },
      kind: flowEdge.kind,
    },
  };
}

export async function layoutFlow(
  flow: FlowView,
  direction: FlowDirection,
): Promise<FlowLayout> {
  const graph: ElkNode = {
    id: flow.id,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": NODE_SPACING,
      "elk.layered.spacing.nodeNodeBetweenLayers": LAYER_SPACING,
    },
    children: flow.nodes.map((node) => ({
      id: node.id,
      width: FLOW_NODE_WIDTH,
      height: FLOW_NODE_HEIGHT,
    })),
    edges: flow.edges.map((edge, index) => ({
      id: `edge-${index.toString()}`,
      sources: [edge.from],
      targets: [edge.to],
      labels: [
        { text: EDGE_LABELS[edge.kind], ...labelSize(EDGE_LABELS[edge.kind]) },
      ],
    })),
  };
  const laid = await elk.layout(graph);
  const positions = new Map(
    (laid.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ]),
  );
  const laidEdges = new Map((laid.edges ?? []).map((edge) => [edge.id, edge]));
  return {
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    nodes: flow.nodes.map((node) => ({
      id: node.id,
      type: "flowNode",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {},
      width: FLOW_NODE_WIDTH,
      height: FLOW_NODE_HEIGHT,
      handles: HANDLES[direction],
    })),
    edges: flow.edges.map((edge, index) =>
      toLayoutEdge(edge, laidEdges.get(`edge-${index.toString()}`), index),
    ),
  };
}
