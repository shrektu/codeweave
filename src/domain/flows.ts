import { parse } from "yaml";
import { z } from "zod";

import { EdgeKind, PermissionProfile, ProviderId } from "./types";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_BLOCKS_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---$/gm;
const MISSING_FRONTMATTER = "Missing YAML frontmatter";

const AgentSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  provider: z.enum(ProviderId),
  model: z.string().min(1).optional(),
  permissionProfile: z.enum(PermissionProfile),
  taskClass: z.string().min(1).optional(),
});

const FlowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  nodes: z.array(z.object({ id: z.string().min(1), agent: z.string().min(1) })),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: z.enum(EdgeKind),
    }),
  ),
});

export type AgentDefinition = z.infer<typeof AgentSchema>;
export type FlowDefinition = z.infer<typeof FlowSchema>;

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
): ParseResult<AgentDefinition[]> {
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
    value: results.flatMap((result) => (result.ok ? [result.value] : [])),
  };
}

function findCycle(flow: FlowDefinition): string[] | null {
  const successors = Map.groupBy(
    flow.edges.filter((edge) => edge.kind === EdgeKind.waitsFor),
    (edge) => edge.from,
  );
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

export function validateFlow(
  flow: FlowDefinition,
  agents: readonly AgentDefinition[],
): string[] {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const nodeIds = new Set(flow.nodes.map((node) => node.id));
  const errors = [
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
    ? [...errors, `Cycle in waits_for edges: ${cycle.join(" -> ")}`]
    : errors;
}
