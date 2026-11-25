import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Node,
  type NodeProps,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useEffect, useMemo, useState, type JSX } from "react";

import {
  FlowNodeState,
  flowNodeStates,
  isRunOpen,
  runNodeStates,
} from "../../domain/flowState";
import { EdgeKind, type ProviderId } from "../../domain/types";
import type {
  AgentView,
  FlowRunView,
  FlowView,
  SessionView,
  Snapshot,
} from "../../shared/views";
import { errorMessage } from "../errorMessage";
import {
  addEdge,
  edgeKey,
  removeEdge,
  removeNode,
  type FlowDraft,
  type FlowSelection,
} from "../flowDraft";
import {
  FLOW_EDGE_TYPE,
  FlowDirection,
  chooseDirection,
  layoutFlow,
  type FlowLayout,
  type FlowLayoutEdge,
  type FlowSize,
} from "../flowLayout";
import {
  PROVIDER_LABELS,
  contextUsageText,
  nodeContextUsageOf,
  nodeModelOf,
} from "../format";
import { useElementSize } from "../useElementSize";

import { FlowEdge } from "./FlowEdge";
import { StatusPill, StatusTone } from "./StatusPill";

interface FlowGraphBaseProps {
  flow: FlowView;
  agents: readonly AgentView[];
  session: SessionView | null;
  run?: FlowRunView | null;
  flowSessions: Snapshot["flowSessions"];
  onOpenSession: () => void;
}

interface FlowGraphReadOnlyProps extends FlowGraphBaseProps {
  editable?: false;
}

interface FlowGraphEditProps extends FlowGraphBaseProps {
  editable: true;
  draft: FlowDraft;
  selection: FlowSelection;
  locked?: boolean;
  onDraftChange: (draft: FlowDraft) => void;
  onSelectionChange: (selection: FlowSelection) => void;
}

export type FlowGraphProps = FlowGraphReadOnlyProps | FlowGraphEditProps;

type FlowNodeData = Record<string, unknown> & {
  role: string;
  state: FlowNodeState;
  isSession: boolean;
  direction: FlowDirection;
  provider: ProviderId | null;
  custom: boolean;
  editable: boolean;
  model: string | null;
  context: string | null;
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
const DELETE_KEYS = ["Delete", "Backspace"];

const STATE_LABELS: Readonly<Record<FlowNodeState, string>> = {
  [FlowNodeState.idle]: "Idle",
  [FlowNodeState.working]: "Working",
  [FlowNodeState.awaitingPermission]: "Needs approval",
  [FlowNodeState.rateLimited]: "Rate limited",
  [FlowNodeState.done]: "Done",
  [FlowNodeState.error]: "Error",
};

const STATE_TONES: Readonly<Record<FlowNodeState, StatusTone>> = {
  [FlowNodeState.idle]: StatusTone.neutral,
  [FlowNodeState.working]: StatusTone.active,
  [FlowNodeState.awaitingPermission]: StatusTone.waiting,
  [FlowNodeState.rateLimited]: StatusTone.waiting,
  [FlowNodeState.done]: StatusTone.success,
  [FlowNodeState.error]: StatusTone.danger,
};

const HANDLE_POSITIONS: Readonly<
  Record<FlowDirection, { target: Position; source: Position }>
> = {
  [FlowDirection.RIGHT]: { target: Position.Left, source: Position.Right },
  [FlowDirection.DOWN]: { target: Position.Top, source: Position.Bottom },
};

function FlowNodeCardView({ id, data }: NodeProps<FlowGraphNode>): JSX.Element {
  const positions = HANDLE_POSITIONS[data.direction];
  return (
    <div
      className={`flow-node${data.isSession ? " session" : ""}`}
      data-state={data.state}
      data-provider={data.provider ?? undefined}
    >
      <Handle
        type="target"
        position={positions.target}
        isConnectable={data.editable}
      />
      <div className="flow-node-head">
        <span className="flow-node-id">{id}</span>
        <StatusPill tone={STATE_TONES[data.state]} className="flow-state">
          {STATE_LABELS[data.state]}
        </StatusPill>
      </div>
      <p className="flow-node-role">{data.role}</p>
      {data.model !== null && (
        <span className="flow-node-model">{data.model}</span>
      )}
      {data.context !== null && (
        <span className="flow-node-context">{data.context}</span>
      )}
      {data.editable && data.provider !== null && (
        <p className="flow-node-provider">
          {PROVIDER_LABELS[data.provider]}
          {data.custom && <span className="flow-custom">custom</span>}
        </p>
      )}
      <Handle
        type="source"
        position={positions.source}
        isConnectable={data.editable}
      />
    </div>
  );
}

const FlowNodeCard = memo(FlowNodeCardView);

const NODE_TYPES = { flowNode: FlowNodeCard };
const EDGE_TYPES = { [FLOW_EDGE_TYPE]: FlowEdge };

function structureKey(flow: FlowView): string {
  return JSON.stringify([
    flow.nodes.map((node) => node.id),
    flow.edges.map(edgeKey),
  ]);
}

function useFlowLayouts(flow: FlowView): LayoutResult {
  const [result, setResult] = useState<LayoutResult>({
    layouts: null,
    error: null,
  });
  const key = structureKey(flow);
  const [stable, setStable] = useState({ key, flow });
  if (stable.key !== key) {
    setStable({ key, flow });
  }

  useEffect(() => {
    let active = true;
    const run = async (): Promise<void> => {
      let next: LayoutResult;
      try {
        const [right, down] = await Promise.all([
          layoutFlow(stable.flow, FlowDirection.RIGHT),
          layoutFlow(stable.flow, FlowDirection.DOWN),
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
  }, [stable]);

  return result;
}

function sessionNodeOf(
  flow: FlowView,
  session: SessionView | null,
): string | null {
  return session?.flowRef?.flowId === flow.id ? session.flowRef.nodeId : null;
}

type NodeStates = ReadonlyMap<string, FlowNodeState>;

function statesOf(
  flow: FlowView,
  session: SessionView | null,
  run: FlowRunView | null,
): NodeStates {
  const nodeIds = flow.nodes.map((node) => node.id);
  const sessionInput = {
    phase: session?.phase.phase ?? null,
    pendingPermissions: session?.permissions.length ?? 0,
    turnInFlight: session?.turnInFlight ?? false,
    lastTurn: session?.lastTurn?.kind ?? null,
  };
  return run === null
    ? flowNodeStates({
        ...sessionInput,
        nodeIds,
        sessionNodeId: sessionNodeOf(flow, session),
      })
    : runNodeStates({
        nodeIds,
        flowId: run.flowId,
        currentNodeId: run.currentNodeId,
        runNodes: run.nodes,
        session:
          session === null
            ? null
            : { ...sessionInput, flowRef: session.flowRef },
      });
}

function activeNodeOf(
  flow: FlowView,
  session: SessionView | null,
  run: FlowRunView | null,
): string | null {
  if (run === null) {
    return sessionNodeOf(flow, session);
  }
  return isRunOpen(run.status) ? run.currentNodeId : null;
}

function sameEntries<T>(
  a: ReadonlyMap<string, T>,
  b: ReadonlyMap<string, T>,
): boolean {
  return (
    a.size === b.size && [...a].every(([id, value]) => b.get(id) === value)
  );
}

function useStableEntries<T>(
  next: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  const [stable, setStable] = useState(next);
  if (sameEntries(stable, next)) {
    return stable;
  }
  setStable(next);
  return next;
}

interface GraphSource {
  layout: FlowLayout;
  direction: FlowDirection;
  flow: FlowView;
  agents: readonly AgentView[];
  states: NodeStates;
  models: ReadonlyMap<string, string>;
  contexts: ReadonlyMap<string, string>;
  activeNodeId: string | null;
  editable: boolean;
  selection: FlowSelection;
}

function modelsOf(
  flow: FlowView,
  run: FlowRunView | null,
  flowSessions: Snapshot["flowSessions"],
): ReadonlyMap<string, string> {
  if (run === null) {
    return new Map();
  }
  return new Map(
    flow.nodes.flatMap((node) => {
      const model = nodeModelOf(run, node.id, flowSessions);
      return model === null ? [] : [[node.id, model] as const];
    }),
  );
}

function contextsOf(
  flow: FlowView,
  run: FlowRunView | null,
  flowSessions: Snapshot["flowSessions"],
): ReadonlyMap<string, string> {
  if (run === null) {
    return new Map();
  }
  return new Map(
    flow.nodes.flatMap((node) => {
      const usage = nodeContextUsageOf(run, node.id, flowSessions);
      return usage === null
        ? []
        : [[node.id, contextUsageText(usage)] as const];
    }),
  );
}

function layoutEdgeKey(edge: FlowLayoutEdge): string | null {
  return edge.data === undefined
    ? null
    : edgeKey({ from: edge.source, to: edge.target, kind: edge.data.kind });
}

function buildGraph({
  layout,
  direction,
  flow,
  agents,
  states,
  models,
  contexts,
  activeNodeId,
  editable,
  selection,
}: GraphSource): { nodes: FlowGraphNode[]; edges: FlowLayoutEdge[] } {
  const flowNodes = new Map(flow.nodes.map((node) => [node.id, node]));
  return {
    nodes: layout.nodes.map((node) => {
      const flowNode = flowNodes.get(node.id);
      const agentId = flowNode?.agent ?? node.id;
      const agent = agents.find((item) => item.id === agentId);
      return {
        ...node,
        type: "flowNode",
        ...(editable
          ? { selected: selection?.kind === "node" && selection.id === node.id }
          : {}),
        data: {
          role: agent?.role ?? agentId,
          state: states.get(node.id) ?? FlowNodeState.idle,
          isSession: node.id === activeNodeId,
          direction,
          provider: flowNode?.provider ?? agent?.provider ?? null,
          custom: (flowNode?.provider ?? null) !== null,
          editable,
          model: models.get(node.id) ?? null,
          context: contexts.get(node.id) ?? null,
        },
      };
    }),
    edges: layout.edges.map((edge) => ({
      ...edge,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: states.get(edge.source) === FlowNodeState.working,
      ...(editable
        ? {
            selected:
              selection?.kind === "edge" &&
              selection.key === layoutEdgeKey(edge),
          }
        : {}),
    })),
  };
}

type CanvasHandlers = Pick<
  ReactFlowProps<FlowGraphNode, FlowLayoutEdge>,
  | "nodesConnectable"
  | "edgesFocusable"
  | "deleteKeyCode"
  | "onNodeClick"
  | "onEdgeClick"
  | "onPaneClick"
  | "onConnect"
  | "onDelete"
>;

function layoutEdgeSelection(edge: FlowLayoutEdge): FlowSelection {
  const key = layoutEdgeKey(edge);
  return key === null ? null : { kind: "edge", key };
}

function connectHandler(
  props: FlowGraphEditProps,
): (connection: Connection) => void {
  return (connection) => {
    const edge = {
      from: connection.source,
      to: connection.target,
      kind: EdgeKind.handsOffTo,
      gate: false,
    };
    const result = addEdge(props.draft, edge);
    if (result.ok) {
      props.onDraftChange(result.draft);
      props.onSelectionChange({ kind: "edge", key: edgeKey(edge) });
    }
  };
}

function deleteHandler(
  props: FlowGraphEditProps,
): NonNullable<CanvasHandlers["onDelete"]> {
  return ({ nodes, edges }) => {
    const withoutNodes = nodes.reduce(
      (draft, node) => removeNode(draft, node.id),
      props.draft,
    );
    const remaining = edges.reduce((draft, edge) => {
      const key = layoutEdgeKey(edge);
      return key === null ? draft : removeEdge(draft, key);
    }, withoutNodes);
    props.onDraftChange(remaining);
    props.onSelectionChange(null);
  };
}

function editHandlers(props: FlowGraphEditProps): CanvasHandlers {
  const selecting: CanvasHandlers = {
    edgesFocusable: true,
    onNodeClick: (_event, node) => {
      props.onSelectionChange({ kind: "node", id: node.id });
    },
    onEdgeClick: (_event, edge) => {
      props.onSelectionChange(layoutEdgeSelection(edge));
    },
    onPaneClick: () => {
      props.onSelectionChange(null);
    },
  };
  if (props.locked === true) {
    return { ...selecting, nodesConnectable: false, deleteKeyCode: null };
  }
  return {
    ...selecting,
    nodesConnectable: true,
    deleteKeyCode: DELETE_KEYS,
    onConnect: connectHandler(props),
    onDelete: deleteHandler(props),
  };
}

function readOnlyHandlers(onOpenSession: () => void): CanvasHandlers {
  return {
    nodesConnectable: false,
    edgesFocusable: false,
    deleteKeyCode: null,
    onNodeClick: (_event, node) => {
      if (node.data.isSession) {
        onOpenSession();
      }
    },
  };
}

function useFitOnChange(layout: FlowLayout | null, size: FlowSize): void {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({
      padding: FIT_PADDING,
      minZoom: FLOW_MIN_ZOOM,
      duration: 0,
    });
  }, [fitView, layout, size]);
}

function FlowCanvas(props: FlowGraphProps): JSX.Element {
  const {
    flow,
    agents,
    session,
    run = null,
    flowSessions,
    onOpenSession,
  } = props;
  const editable = props.editable === true;
  const draft = props.editable === true ? props.draft : null;
  const shown = useMemo<FlowView>(
    () => (draft === null ? flow : { ...flow, ...draft }),
    [flow, draft],
  );
  const selection = props.editable === true ? props.selection : null;
  const { layouts, error } = useFlowLayouts(shown);
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const direction =
    layouts === null ? FlowDirection.RIGHT : chooseDirection(layouts, size);
  const layout = layouts?.[direction] ?? null;
  useFitOnChange(layout, size);
  const states = useStableEntries(statesOf(shown, session, run));
  const activeNodeId = activeNodeOf(shown, session, run);
  const models = useStableEntries(modelsOf(shown, run, flowSessions));
  const contexts = useStableEntries(contextsOf(shown, run, flowSessions));
  const graph = useMemo(
    () =>
      layout
        ? buildGraph({
            layout,
            direction,
            flow: shown,
            agents,
            states,
            models,
            contexts,
            activeNodeId,
            editable,
            selection,
          })
        : { nodes: [], edges: [] },
    [
      layout,
      direction,
      shown,
      agents,
      states,
      models,
      contexts,
      activeNodeId,
      editable,
      selection,
    ],
  );

  if (error !== null) {
    return <p className="error">{error}</p>;
  }
  const handlers =
    props.editable === true
      ? editHandlers(props)
      : readOnlyHandlers(onOpenSession);

  return (
    <div
      className={`flow-graph${editable ? " editing" : ""}`}
      ref={containerRef}
    >
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
        {...handlers}
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
