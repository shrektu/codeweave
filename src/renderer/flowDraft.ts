import { MAX_FLOW_ROUNDS, MIN_FLOW_ROUNDS } from "../domain/constants";
import { validateFlow, type FlowDefinition } from "../domain/flows";
import type { TaskClass } from "../domain/taskClass";
import { DefinitionSource, EdgeKind, ProviderId } from "../domain/types";
import type { ParamsMap } from "../shared/protocol";
import type { AgentView, FlowView } from "../shared/views";

export interface DraftNode {
  id: string;
  agent: string;
  provider: ProviderId | null;
  taskClass: TaskClass | null;
}

export interface DraftEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  gate: boolean;
}

export interface FlowDraft {
  id: string;
  title: string;
  maxRounds: number;
  nodes: DraftNode[];
  edges: DraftEdge[];
}

export interface FlowBase {
  flowId: string;
  source: DefinitionSource;
  file: string;
  revision: string;
}

export type DraftResult =
  | { readonly ok: true; readonly draft: FlowDraft }
  | { readonly ok: false; readonly error: string };

export type FlowSelection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly key: string }
  | null;

export interface NodePatch {
  agent?: string;
  provider?: ProviderId | null;
  taskClass?: TaskClass | null;
}

export interface EdgePatch {
  kind?: EdgeKind;
  gate?: boolean;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const ROUNDS_RANGE_MESSAGE = `Max rounds must be a whole number from ${MIN_FLOW_ROUNDS.toString()} to ${MAX_FLOW_ROUNDS.toString()}`;

export function edgeKey(edge: Pick<DraftEdge, "from" | "to" | "kind">): string {
  return `${edge.from}->${edge.to}:${edge.kind}`;
}

export function parseEdgeKind(value: string): EdgeKind | null {
  return Object.values(EdgeKind).find((kind) => kind === value) ?? null;
}

export function parseProviderId(value: string): ProviderId | null {
  return Object.values(ProviderId).find((id) => id === value) ?? null;
}

export function draftOf(view: FlowView): FlowDraft {
  return {
    id: view.id,
    title: view.title,
    maxRounds: view.maxRounds,
    nodes: view.nodes.map((node) => ({ ...node })),
    edges: view.edges.map((edge) => ({ ...edge })),
  };
}

function fail(error: string): DraftResult {
  return { ok: false, error };
}

function succeed(draft: FlowDraft): DraftResult {
  return { ok: true, draft };
}

export function addNode(draft: FlowDraft, node: DraftNode): DraftResult {
  if (node.id === "") {
    return fail("Node id is required");
  }
  if (!NODE_ID_PATTERN.test(node.id)) {
    return fail("Node id may only contain letters, digits, - and _");
  }
  if (draft.nodes.some((existing) => existing.id === node.id)) {
    return fail(`Node id "${node.id}" already exists`);
  }
  return succeed({ ...draft, nodes: [...draft.nodes, node] });
}

export function removeNode(draft: FlowDraft, id: string): FlowDraft {
  return {
    ...draft,
    nodes: draft.nodes.filter((node) => node.id !== id),
    edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

export function updateNode(
  draft: FlowDraft,
  id: string,
  patch: NodePatch,
): FlowDraft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === id ? { ...node, ...patch } : node,
    ),
  };
}

export function addEdge(draft: FlowDraft, edge: DraftEdge): DraftResult {
  if (edge.from === edge.to) {
    return fail("A node cannot connect to itself");
  }
  const key = edgeKey(edge);
  if (draft.edges.some((existing) => edgeKey(existing) === key)) {
    return fail(`Edge ${key} already exists`);
  }
  return succeed({ ...draft, edges: [...draft.edges, edge] });
}

export function removeEdge(draft: FlowDraft, key: string): FlowDraft {
  return {
    ...draft,
    edges: draft.edges.filter((edge) => edgeKey(edge) !== key),
  };
}

export function updateEdge(
  draft: FlowDraft,
  key: string,
  patch: EdgePatch,
): DraftResult {
  const target = draft.edges.find((edge) => edgeKey(edge) === key);
  if (target === undefined) {
    return fail(`Edge ${key} does not exist`);
  }
  const updated = { ...target, ...patch };
  const updatedKey = edgeKey(updated);
  if (
    updatedKey !== key &&
    draft.edges.some((edge) => edgeKey(edge) === updatedKey)
  ) {
    return fail(`Edge ${updatedKey} already exists`);
  }
  return succeed({
    ...draft,
    edges: draft.edges.map((edge) => (edge === target ? updated : edge)),
  });
}

export function setMaxRounds(draft: FlowDraft, rounds: number): DraftResult {
  if (
    !Number.isInteger(rounds) ||
    rounds < MIN_FLOW_ROUNDS ||
    rounds > MAX_FLOW_ROUNDS
  ) {
    return fail(ROUNDS_RANGE_MESSAGE);
  }
  return succeed({ ...draft, maxRounds: rounds });
}

export function baseOf(view: FlowView): FlowBase {
  return {
    flowId: view.id,
    source: view.source,
    file: view.file,
    revision: view.revision,
  };
}

export function cwdParams(cwd: string | null): { cwd?: string } {
  return cwd === null ? {} : { cwd };
}

export function saveParamsOf(
  cwd: string | null,
  base: FlowBase,
  draft: FlowDraft,
): ParamsMap["flows/save"] {
  return {
    ...cwdParams(cwd),
    source: base.source,
    file: base.file,
    revision: base.revision,
    flow: toDefinition(draft),
  };
}

export function toDefinition(draft: FlowDraft): FlowDefinition {
  return {
    id: draft.id,
    title: draft.title,
    maxRounds: draft.maxRounds,
    nodes: draft.nodes.map((node) => ({
      id: node.id,
      agent: node.agent,
      ...(node.provider === null ? {} : { provider: node.provider }),
      ...(node.taskClass === null ? {} : { taskClass: node.taskClass }),
    })),
    edges: draft.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.gate ? { gate: true } : {}),
    })),
  };
}

export function draftErrors(
  draft: FlowDraft,
  agents: readonly AgentView[],
): string[] {
  return validateFlow(toDefinition(draft), agents);
}

export function isDraftChanged(draft: FlowDraft, view: FlowView): boolean {
  return (
    JSON.stringify(toDefinition(draft)) !==
    JSON.stringify(toDefinition(draftOf(view)))
  );
}
