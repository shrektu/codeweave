import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseAgentDocuments,
  parseAgentFile,
  parseFlowFile,
  validateFlow,
  type AgentDefinition,
  type FlowDefinition,
} from "./flows";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const AGENT_MARKDOWN = `---
id: implementer
role: Builds things
provider: claude
permissionProfile: accept-edits
---
Body`;

const AGENTS: readonly AgentDefinition[] = [
  {
    id: "implementer",
    role: "r",
    provider: "claude",
    permissionProfile: "ask",
  },
  { id: "reviewer", role: "r", provider: "codex", permissionProfile: "plan" },
];

function flow(overrides: Partial<FlowDefinition>): FlowDefinition {
  return {
    id: "f",
    title: "F",
    nodes: [
      { id: "a", agent: "implementer" },
      { id: "b", agent: "reviewer" },
    ],
    edges: [],
    ...overrides,
  };
}

describe("flows: parsing", () => {
  it("parses an agent file", () => {
    expect(parseAgentFile(AGENT_MARKDOWN)).toEqual({
      ok: true,
      value: {
        id: "implementer",
        role: "Builds things",
        provider: "claude",
        permissionProfile: "accept-edits",
      },
    });
  });

  it("reports missing frontmatter", () => {
    expect(parseAgentFile("# just text")).toEqual({
      ok: false,
      errors: ["Missing YAML frontmatter"],
    });
  });

  it("reports invalid YAML", () => {
    const result = parseAgentFile("---\nid: [unclosed\n---\n");

    expect(result.ok).toBe(false);
  });

  it("reports an unknown provider with the field path", () => {
    const result = parseAgentFile(AGENT_MARKDOWN.replace("claude", "cursor"));

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.errors.join()).toContain("provider");
  });

  it("reports every missing field of a flow", () => {
    const result = parseFlowFile("---\nid: only-id\n---\n");

    expect(!result.ok && result.errors.map((e) => e.split(":")[0])).toEqual([
      "title",
      "nodes",
      "edges",
    ]);
  });

  it("rejects an unknown edge kind", () => {
    const result = parseFlowFile(
      "---\nid: f\ntitle: F\nnodes: []\nedges:\n  - from: a\n    to: b\n    kind: blocks\n---\n",
    );

    expect(!result.ok && result.errors.join()).toContain("edges.0.kind");
  });
});

describe("flows: validation", () => {
  it("accepts a valid flow", () => {
    const valid = flow({
      edges: [{ from: "a", to: "b", kind: "hands_off_to" }],
    });

    expect(validateFlow(valid, AGENTS)).toEqual([]);
  });

  it("reports an unknown agent", () => {
    const errors = validateFlow(
      flow({ nodes: [{ id: "a", agent: "ghost" }] }),
      AGENTS,
    );

    expect(errors).toEqual(['Node "a" uses unknown agent "ghost"']);
  });

  it("reports an edge to an unknown node", () => {
    const errors = validateFlow(
      flow({ edges: [{ from: "a", to: "zzz", kind: "reviews" }] }),
      AGENTS,
    );

    expect(errors).toEqual(['Edge "a" -> "zzz" references unknown node "zzz"']);
  });

  it("reports a cycle in waits_for edges", () => {
    const errors = validateFlow(
      flow({
        edges: [
          { from: "a", to: "b", kind: "waits_for" },
          { from: "b", to: "a", kind: "waits_for" },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual(["Cycle in waits_for edges: a -> b -> a"]);
  });

  it("allows a loop made of non waits_for edges", () => {
    const errors = validateFlow(
      flow({
        edges: [
          { from: "a", to: "b", kind: "hands_off_to" },
          { from: "b", to: "a", kind: "reviews" },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual([]);
  });
});

describe("flows: example files", () => {
  it("parse and validate against each other", () => {
    const agents = parseAgentDocuments(
      readFileSync(join(REPO_ROOT, "agents", "example.md"), "utf8"),
    );
    const parsedFlow = parseFlowFile(
      readFileSync(join(REPO_ROOT, "flows", "example.md"), "utf8"),
    );

    expect(agents.ok && agents.value.map((agent) => agent.id)).toEqual([
      "implementer",
      "reviewer",
    ]);
    expect(
      parsedFlow.ok &&
        agents.ok &&
        validateFlow(parsedFlow.value, agents.value),
    ).toEqual([]);
    expect(
      parsedFlow.ok && parsedFlow.value.edges.map((edge) => edge.kind),
    ).toEqual(["hands_off_to", "reviews"]);
  });
});
