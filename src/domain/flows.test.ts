import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentBlocks,
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

  it("accepts the three task classes", () => {
    for (const taskClass of ["light", "standard", "heavy"]) {
      const result = parseAgentFile(
        AGENT_MARKDOWN.replace(
          "---\nBody",
          `taskClass: ${taskClass}\n---\nBody`,
        ),
      );

      expect(result.ok && result.value.taskClass).toBe(taskClass);
    }
  });

  it("rejects unknown task class with the allowed values", () => {
    const result = parseAgentFile(
      AGENT_MARKDOWN.replace("---\nBody", "taskClass: M\n---\nBody"),
    );

    expect(result).toEqual({
      ok: false,
      errors: ["taskClass: Task class must be one of: light, standard, heavy"],
    });
  });

  it("parses a node task class", () => {
    const result = parseFlowFile(`---
id: f
title: F
nodes:
  - id: a
    agent: implementer
    taskClass: heavy
edges: []
---`);

    expect(result.ok && result.value.nodes[0]?.taskClass).toBe("heavy");
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

  it("parse_agent_documents_returns_bodies", () => {
    const result = parseAgentDocuments(`${AGENT_MARKDOWN}
more

---
id: reviewer
role: Reviews
provider: codex
permissionProfile: plan
---

Second body
`);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          definition: {
            id: "implementer",
            role: "Builds things",
            provider: "claude",
            permissionProfile: "accept-edits",
          },
          body: "Body\nmore",
        },
        {
          definition: {
            id: "reviewer",
            role: "Reviews",
            provider: "codex",
            permissionProfile: "plan",
          },
          body: "Second body",
        },
      ],
    });
  });

  it("parses optional provider, gate and maxRounds", () => {
    const result = parseFlowFile(
      "---\nid: f\ntitle: F\nmaxRounds: 4\nnodes:\n  - id: a\n    agent: x\n    provider: codex\nedges:\n  - from: a\n    to: a\n    kind: reviews\n    gate: true\n---\n",
    );

    expect(result).toEqual({
      ok: true,
      value: {
        id: "f",
        title: "F",
        maxRounds: 4,
        nodes: [{ id: "a", agent: "x", provider: "codex" }],
        edges: [{ from: "a", to: "a", kind: "reviews", gate: true }],
      },
    });
  });

  it("rejects maxRounds outside 1..10 and unknown node provider", () => {
    const header = "---\nid: f\ntitle: F\n";
    const low = parseFlowFile(
      `${header}maxRounds: 0\nnodes: []\nedges: []\n---\n`,
    );
    const high = parseFlowFile(
      `${header}maxRounds: 11\nnodes: []\nedges: []\n---\n`,
    );
    const fractional = parseFlowFile(
      `${header}maxRounds: 2.5\nnodes: []\nedges: []\n---\n`,
    );
    const provider = parseFlowFile(
      `${header}nodes:\n  - id: a\n    agent: x\n    provider: cursor\nedges: []\n---\n`,
    );

    expect(!low.ok && low.errors.join()).toContain("maxRounds");
    expect(!high.ok && high.errors.join()).toContain("maxRounds");
    expect(!fractional.ok && fractional.errors.join()).toContain("maxRounds");
    expect(!provider.ok && provider.errors.join()).toContain(
      "nodes.0.provider",
    );
  });

  it("rejects an unknown edge kind", () => {
    const result = parseFlowFile(
      "---\nid: f\ntitle: F\nnodes: []\nedges:\n  - from: a\n    to: b\n    kind: blocks\n---\n",
    );

    expect(!result.ok && result.errors.join()).toContain("edges.0.kind");
  });
});

describe("flows: agentBlocks", () => {
  const THREE_BLOCKS =
    "---\nid: a\n---\n\nbody a\n\n---\nid: b\n---\nbody b\n\n---\nid: c\n---\nbody c\n";

  it("locates the first, middle and last block", () => {
    expect(agentBlocks(THREE_BLOCKS)).toEqual([
      { yaml: "id: a", start: 0, bodyStart: 13, end: 23 },
      { yaml: "id: b", start: 23, bodyStart: 36, end: 45 },
      { yaml: "id: c", start: 45, bodyStart: 58, end: 66 },
    ]);
  });

  it("locates CRLF blocks without the line ending in the yaml", () => {
    const markdown =
      "---\r\nid: a\r\n---\r\n\r\nbody a\r\n\r\n---\r\nid: b\r\n---\r\nbody b\r\n";

    expect(agentBlocks(markdown)).toEqual([
      { yaml: "id: a", start: 0, bodyStart: 15, end: 29 },
      { yaml: "id: b", start: 29, bodyStart: 44, end: 54 },
    ]);
  });

  it("finds no block without front matter", () => {
    expect(agentBlocks("just prose\n")).toEqual([]);
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

    expect(errors).toEqual(["Cycle in flow order: a -> b -> a"]);
  });

  it("validate_rejects_duplicate_node_ids", () => {
    const errors = validateFlow(
      flow({
        nodes: [
          { id: "a", agent: "implementer" },
          { id: "a", agent: "reviewer" },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual(['Duplicate node id "a"']);
  });

  it("validate_rejects_handoff_cycle", () => {
    const errors = validateFlow(
      flow({
        edges: [
          { from: "a", to: "b", kind: "hands_off_to" },
          { from: "b", to: "a", kind: "hands_off_to" },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual(["Cycle in flow order: a -> b -> a"]);
  });

  it("validate_rejects_cycle_through_review_order", () => {
    const errors = validateFlow(
      flow({
        edges: [
          { from: "a", to: "b", kind: "hands_off_to" },
          { from: "a", to: "b", kind: "reviews" },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual(["Cycle in flow order: a -> b -> a"]);
  });

  it("validate_rejects_self_review", () => {
    const errors = validateFlow(
      flow({ edges: [{ from: "a", to: "a", kind: "reviews" }] }),
      AGENTS,
    );

    expect(errors).toEqual(['Node "a" cannot review itself']);
  });

  it("validate_rejects_duplicate_edge", () => {
    const errors = validateFlow(
      flow({
        edges: [
          { from: "a", to: "b", kind: "hands_off_to" },
          { from: "a", to: "b", kind: "hands_off_to", gate: true },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual(['Duplicate edge "a" -> "b" (hands_off_to)']);
  });

  it("validate_allows_same_pair_with_different_kinds", () => {
    const errors = validateFlow(
      flow({
        edges: [
          { from: "a", to: "b", kind: "hands_off_to" },
          { from: "b", to: "a", kind: "reviews" },
          { from: "a", to: "b", kind: "waits_for" },
        ],
      }),
      AGENTS,
    );

    expect(errors).toEqual([]);
  });

  it("validate_rejects_empty_flow", () => {
    const errors = validateFlow(flow({ nodes: [], edges: [] }), AGENTS);

    expect(errors).toEqual(["Flow has no nodes"]);
  });

  it("validate_accepts_review_back_edge", () => {
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

  it("allows a review back edge over a hand-off", () => {
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

    expect(
      agents.ok && agents.value.map(({ definition }) => definition.id),
    ).toEqual(["implementer", "reviewer"]);
    expect(
      parsedFlow.ok &&
        agents.ok &&
        validateFlow(
          parsedFlow.value,
          agents.value.map(({ definition }) => definition),
        ),
    ).toEqual([]);
    expect(
      parsedFlow.ok && parsedFlow.value.edges.map((edge) => edge.kind),
    ).toEqual(["hands_off_to", "reviews"]);
  });
});
