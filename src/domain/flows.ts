import { parse } from "yaml";
import { z } from "zod";

import { MAX_FLOW_ROUNDS, MIN_FLOW_ROUNDS } from "./constants";
import { EdgeKind, PermissionProfile, ProviderId } from "./types";

export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_BLOCKS_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---$/gm;
const MISSING_FRONTMATTER = "Missing YAML frontmatter";
const EMPTY_FLOW = "Flow has no nodes";

const AgentSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  provider: z.enum(ProviderId),
  model: z.string().min(1).optional(),
  permissionProfile: z.enum(PermissionProfile),
  taskClass: z.string().min(1).optional(),
});

export const FlowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  maxRounds: z.int().min(MIN_FLOW_ROUNDS).max(MAX_FLOW_ROUNDS).optional(),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      agent: z.string().min(1),
      provider: z.enum(ProviderId).optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: z.enum(EdgeKind),
      gate: z.boolean().optional(),
    }),
  ),
});

export type AgentDefinition = z.infer<typeof AgentSchema>;
export type FlowDefinition = z.infer<typeof FlowSchema>;

export interface AgentDocument {
  readonly definition: AgentDefinition;
  readonly body: string;
}

export interface OrderEdge {
  readonly from: string;
  readonly to: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: string[] };

function readFrontmatter(markdown: string): ParseResult<unknown> {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (match?.[1] === undefined) {
    return { ok: false, errors: [MISSING_FRONTMATTER] };
  }
  try {
    return { ok: true, value: parse(match[1]) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`Invalid YAML frontmatter: ${message}`] };
  }
}

function parseWith<T>(schema: z.ZodType<T>, markdown: string): ParseResult<T> {
  const frontmatter = readFrontmatter(markdown);
  if (!frontmatter.ok) {
    return frontmatter;
  }
  const result = schema.safeParse(frontmatter.value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

export function parseAgentFile(markdown: string): ParseResult<AgentDefinition> {
  return parseWith(AgentSchema, markdown);
}

export function parseFlowFile(markdown: string): ParseResult<FlowDefinition> {
  return parseWith(FlowSchema, markdown);
}

export function parseAgentDocuments(
  markdown: string,
): ParseResult<AgentDocument[]> {
  const blocks = [...markdown.matchAll(FRONTMATTER_BLOCKS_PATTERN)];
  if (blocks.length === 0) {
    return { ok: false, errors: [MISSING_FRONTMATTER] };
  }
  const results = blocks.map((block) =>
    parseAgentFile(`---\n${block[1] ?? ""}\n---`),
  );
  const errors = results.flatMap((result, index) =>
    result.ok
      ? []
      : result.errors.map((error) => `Agent ${String(index + 1)}: ${error}`),
  );
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: results.flatMap((result, index) => {
      const block = blocks[index];
      if (!result.ok || block === undefined) {
        return [];
      }
      const bodyStart = block.index + block[0].length;
      const bodyEnd = blocks[index + 1]?.index ?? markdown.length;
      return [
        {
          definition: result.value,
          body: markdown.slice(bodyStart, bodyEnd).trim(),
        },
      ];
    }),
  };
}

export function orderingEdges(flow: FlowDefinition): OrderEdge[] {
  return flow.edges.flatMap((edge): OrderEdge[] => {
    if (edge.kind !== EdgeKind.reviews) {
      return [{ from: edge.from, to: edge.to }];
    }
    return edge.from === edge.to ? [] : [{ from: edge.to, to: edge.from }];
  });
}

function findCycle(flow: FlowDefinition): string[] | null {
  const successors = Map.groupBy(orderingEdges(flow), (edge) => edge.from);
  const finished = new Set<string>();

  function visit(node: string, path: readonly string[]): string[] | null {
    const loopStart = path.indexOf(node);
    if (loopStart !== -1) {
      return [...path.slice(loopStart), node];
    }
    if (finished.has(node)) {
      return null;
    }
    for (const edge of successors.get(node) ?? []) {
      const cycle = visit(edge.to, [...path, node]);
      if (cycle) {
        return cycle;
      }
    }
    finished.add(node);
    return null;
  }

  for (const node of flow.nodes) {
    const cycle = visit(node.id, []);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function duplicateNodeErrors(flow: FlowDefinition): string[] {
  const groups = Map.groupBy(flow.nodes, (node) => node.id);
  return [...groups]
    .filter(([, nodes]) => nodes.length > 1)
    .map(([id]) => `Duplicate node id "${id}"`);
}

function edgeShapeErrors(flow: FlowDefinition): string[] {
  const groups = Map.groupBy(
    flow.edges,
    (edge) => `${edge.kind}\n${edge.from}\n${edge.to}`,
  );
  return [
    ...flow.edges
      .filter((edge) => edge.kind === EdgeKind.reviews && edge.from === edge.to)
      .map((edge) => `Node "${edge.from}" cannot review itself`),
    ...[...groups.values()]
      .filter((edges) => edges.length > 1)
      .flatMap(([edge]) =>
        edge === undefined
          ? []
          : [`Duplicate edge "${edge.from}" -> "${edge.to}" (${edge.kind})`],
      ),
  ];
}

export function validateFlow(
  flow: FlowDefinition,
  agents: readonly AgentDefinition[],
): string[] {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const nodeIds = new Set(flow.nodes.map((node) => node.id));
  const errors = [
    ...(flow.nodes.length === 0 ? [EMPTY_FLOW] : []),
    ...duplicateNodeErrors(flow),
    ...edgeShapeErrors(flow),
    ...flow.nodes
      .filter((node) => !agentIds.has(node.agent))
      .map((node) => `Node "${node.id}" uses unknown agent "${node.agent}"`),
    ...flow.edges.flatMap((edge) =>
      [edge.from, edge.to]
        .filter((id) => !nodeIds.has(id))
        .map(
          (id) =>
            `Edge "${edge.from}" -> "${edge.to}" references unknown node "${id}"`,
        ),
    ),
  ];
  const cycle = findCycle(flow);
  return cycle
    ? [...errors, `Cycle in flow order: ${cycle.join(" -> ")}`]
    : errors;
}
