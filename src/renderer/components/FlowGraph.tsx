import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useState, type JSX } from "react";

import { FlowNodeState, flowNodeStates } from "../../domain/flowState";
import type { ProviderId } from "../../domain/types";
import type { AgentView, FlowView, SessionView } from "../../shared/views";
import { errorMessage } from "../errorMessage";
import {
  FLOW_EDGE_TYPE,
  FlowDirection,
  chooseDirection,
  layoutFlow,
  type FlowLayout,
  type FlowLayoutEdge,
} from "../flowLayout";
import { useElementSize } from "../useElementSize";

import { FlowEdge } from "./FlowEdge";

export interface FlowGraphProps {
  flow: FlowView;
  agents: readonly AgentView[];
  session: SessionView | null;
  onOpenSession: () => void;
}

type FlowNodeData = Record<string, unknown> & {
  role: string;
  state: FlowNodeState;
  isSession: boolean;
  direction: FlowDirection;
  provider: ProviderId | null;
};
type FlowGraphNode = Node<FlowNodeData, "flowNode">;

type FlowLayouts = Readonly<Record<FlowDirection, FlowLayout>>;

interface LayoutResult {
  layouts: FlowLayouts | null;
  error: string | null;
}

export const FLOW_MIN_ZOOM = 0.2;
const FIT_PADDING = 0.12;
const BACKGROUND_GAP = 24;
const BACKGROUND_DOT_SIZE = 1.5;

const STATE_LABELS: Readonly<Record<FlowNodeState, string>> = {
  [FlowNodeState.idle]: "Idle",
  [FlowNodeState.working]: "Working",
  [FlowNodeState.awaitingPermission]: "Needs approval",
  [FlowNodeState.rateLimited]: "Rate limited",
  [FlowNodeState.done]: "Done",
  [FlowNodeState.error]: "Error",
};

const HANDLE_POSITIONS: Readonly<
  Record<FlowDirection, { target: Position; source: Position }>
> = {
  [FlowDirection.RIGHT]: { target: Position.Left, source: Position.Right },
  [FlowDirection.DOWN]: { target: Position.Top, source: Position.Bottom },
};

function FlowNodeCard({ id, data }: NodeProps<FlowGraphNode>): JSX.Element {
  const positions = HANDLE_POSITIONS[data.direction];
  return (
    <div
      className={`flow-node${data.isSession ? " session" : ""}`}
      data-state={data.state}
      data-provider={data.provider ?? undefined}
    >
      <Handle type="target" position={positions.target} isConnectable={false} />
      <div className="flow-node-head">
        <span className="flow-node-id">{id}</span>
        <span className="pill flow-state">{STATE_LABELS[data.state]}</span>
      </div>
      <p className="flow-node-role">{data.role}</p>
      <Handle type="source" position={positions.source} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { flowNode: FlowNodeCard };
const EDGE_TYPES = { [FLOW_EDGE_TYPE]: FlowEdge };

function useFlowLayouts(flow: FlowView): LayoutResult {
  const [result, setResult] = useState<LayoutResult>({
    layouts: null,
    error: null,
  });

  useEffect(() => {
    let active = true;
    const run = async (): Promise<void> => {
      let next: LayoutResult;
      try {
        const [right, down] = await Promise.all([
          layoutFlow(flow, FlowDirection.RIGHT),
          layoutFlow(flow, FlowDirection.DOWN),
        ]);
        next = {
          layouts: { [FlowDirection.RIGHT]: right, [FlowDirection.DOWN]: down },
          error: null,
        };
      } catch (error: unknown) {
        next = { layouts: null, error: errorMessage(error) };
      }
      if (active) {
        setResult(next);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [flow]);

  return result;
}

function sessionNodeOf(
  flow: FlowView,
  session: SessionView | null,
): string | null {
  return session?.flowRef?.flowId === flow.id ? session.flowRef.nodeId : null;
}

function statesOf(
  flow: FlowView,
  session: SessionView | null,
): ReadonlyMap<string, FlowNodeState> {
  return flowNodeStates({
    nodeIds: flow.nodes.map((node) => node.id),
    sessionNodeId: sessionNodeOf(flow, session),
    phase: session?.phase.phase ?? null,
    pendingPermissions: session?.permissions.length ?? 0,
    turnInFlight: session?.turnInFlight ?? false,
    lastTurn: session?.lastTurn?.kind ?? null,
  });
}

interface GraphSource {
  layout: FlowLayout;
  direction: FlowDirection;
  flow: FlowView;
  agents: readonly AgentView[];
  session: SessionView | null;
}

function buildGraph({
  layout,
  direction,
  flow,
  agents,
  session,
}: GraphSource): { nodes: FlowGraphNode[]; edges: FlowLayoutEdge[] } {
  const activeNodeId = sessionNodeOf(flow, session);
  const states = statesOf(flow, session);
  const agentIds = new Map(flow.nodes.map((node) => [node.id, node.agent]));
  return {
    nodes: layout.nodes.map((node) => {
      const agentId = agentIds.get(node.id) ?? node.id;
      const agent = agents.find((item) => item.id === agentId);
      return {
        ...node,
        type: "flowNode",
        data: {
          role: agent?.role ?? agentId,
          state: states.get(node.id) ?? FlowNodeState.idle,
          isSession: node.id === activeNodeId,
          direction,
          provider: agent?.provider ?? null,
        },
      };
    }),
    edges: layout.edges.map((edge) => ({
      ...edge,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: states.get(edge.source) === FlowNodeState.working,
    })),
  };
}

function FlowCanvas({
  flow,
  agents,
  session,
  onOpenSession,
}: FlowGraphProps): JSX.Element {
  const { layouts, error } = useFlowLayouts(flow);
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const { fitView } = useReactFlow();
  const direction =
    layouts === null ? FlowDirection.RIGHT : chooseDirection(layouts, size);
  const layout = layouts?.[direction] ?? null;

  useEffect(() => {
    void fitView({
      padding: FIT_PADDING,
      minZoom: FLOW_MIN_ZOOM,
      duration: 0,
    });
  }, [fitView, layout, size]);

  if (error !== null) {
    return <p className="error">{error}</p>;
  }
  const graph = layout
    ? buildGraph({ layout, direction, flow, agents, session })
    : { nodes: [], edges: [] };

  return (
    <div className="flow-graph" ref={containerRef}>
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={{ padding: FIT_PADDING, minZoom: FLOW_MIN_ZOOM }}
        minZoom={FLOW_MIN_ZOOM}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        onNodeClick={(_event, node) => {
          if (node.data.isSession) {
            onOpenSession();
          }
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={BACKGROUND_GAP}
          size={BACKGROUND_DOT_SIZE}
        />
      </ReactFlow>
    </div>
  );
}

export function FlowGraph(props: FlowGraphProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
