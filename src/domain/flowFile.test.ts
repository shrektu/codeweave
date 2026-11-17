import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { serializeFlowFile } from "./flowFile";
import { parseFlowFile, type FlowDefinition } from "./flows";

const BODY = "\n# Title\n\nProse\n---\nnot: front matter\n---\nend\n";

const ORIGINAL = `---
id: ship
# keep me
title: Old title
owner: team-a
maxRounds: 4
nodes:
  - id: build
    agent: coder
    provider: codex
edges: []
---${BODY}`;

const EDITED: FlowDefinition = {
  id: "ship",
  title: "New title",
  nodes: [
    { id: "build", agent: "coder" },
    { id: "check", agent: "reviewer", provider: "gemini" },
  ],
  edges: [
    { from: "build", to: "check", kind: "hands_off_to" },
    { from: "check", to: "build", kind: "reviews", gate: true },
  ],
};

function serialized(original: string, flow: FlowDefinition): string {
  const result = serializeFlowFile(original, flow);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.value;
}

describe("serializeFlowFile", () => {
  it("serialize_preserves_crlf_body_and_comments", () => {
    const crlf = ORIGINAL.replaceAll("\n", "\r\n");

    const text = serialized(crlf, EDITED);

    expect(text.endsWith(`---${BODY.replaceAll("\n", "\r\n")}`)).toBe(true);
    expect(text).toContain("# keep me\r\n");
    expect(text).toContain("owner: team-a\r\n");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expect(text.startsWith("---\r\nid: ship\r\n")).toBe(true);
  });

  it("serialize_keeps_body_with_triple_dash_lines", () => {
    const text = serialized(ORIGINAL, EDITED);

    expect(text.slice(text.indexOf("\n---\n") + "\n---".length)).toBe(BODY);
    expect(text).toContain("# keep me\n");
    expect(text).toContain("owner: team-a\n");
  });

  it("serialize_round_trips_definition", () => {
    const flows: FlowDefinition[] = [
      EDITED,
      { ...EDITED, maxRounds: 10 },
      {
        id: "ship",
        title: "Only one",
        nodes: [{ id: "a", agent: "x" }],
        edges: [],
      },
      {
        id: "ship",
        title: "Colon: and # hash 'quoted' \"double\"",
        maxRounds: 1,
        nodes: [
          { id: "a", agent: "x", provider: "claude" },
          { id: "b", agent: "y", provider: "opencode" },
          { id: "c", agent: "z" },
        ],
        edges: [
          { from: "a", to: "b", kind: "waits_for" },
          { from: "b", to: "c", kind: "reviews", gate: true },
        ],
      },
    ];

    for (const flow of flows) {
      const result = parseFlowFile(serialized(ORIGINAL, flow));

      expect(result).toEqual({ ok: true, value: flow });
    }
  });

  it("keeps node task class through save", () => {
    const flow: FlowDefinition = {
      ...EDITED,
      nodes: [
        { id: "build", agent: "coder", taskClass: "light" },
        { id: "check", agent: "reviewer" },
      ],
    };

    const text = serialized(ORIGINAL, flow);

    expect(text).toContain("taskClass: light\n");
    expect(parseFlowFile(text)).toEqual({ ok: true, value: flow });
  });

  it("serialize_drops_undefined_optional_keys", () => {
    const text = serialized(ORIGINAL, {
      ...EDITED,
      edges: [{ from: "build", to: "check", kind: "reviews", gate: false }],
    });

    expect(text).not.toContain("maxRounds");
    expect(text).not.toContain("provider: codex");
    expect(text).not.toContain("gate");
    expect(text).toContain("provider: gemini");
  });
});

describe("serializeFlowFile entries", () => {
  const WITH_ENTRIES = `---
id: ship
title: Ship
nodes:
  # builder node
  - id: build
    agent: coder
    label: Builder
  - id: gone
    agent: coder
edges:
  - from: build
    to: build
    kind: reviews
    gate: true
    # edge note
    note: keep
---
Body
`;

  it("serialize_keeps_comments_and_unknown_keys_inside_entries", () => {
    const text = serialized(WITH_ENTRIES, {
      id: "ship",
      title: "Ship",
      nodes: [{ id: "build", agent: "reviewer", provider: "codex" }],
      edges: [{ from: "build", to: "build", kind: "reviews" }],
    });

    expect(text).toContain("# builder node\n");
    expect(text).toContain("label: Builder\n");
    expect(text).toContain("# edge note\n");
    expect(text).toContain("note: keep\n");
    expect(text).toContain("agent: reviewer\n");
    expect(text).toContain("provider: codex\n");
    expect(text).not.toContain("gate");
    expect(text).not.toContain("gone");
  });

  it("serialize_orders_entries_like_the_edited_flow_and_appends_new_ones", () => {
    const text = serialized(WITH_ENTRIES, {
      id: "ship",
      title: "Ship",
      nodes: [
        { id: "fresh", agent: "reviewer" },
        { id: "gone", agent: "coder" },
        { id: "build", agent: "coder" },
      ],
      edges: [],
    });

    const parsed = parseFlowFile(text);
    expect(parsed.ok && parsed.value.nodes.map((node) => node.id)).toEqual([
      "fresh",
      "gone",
      "build",
    ]);
    expect(text).toContain("label: Builder\n");
    expect(text).toContain("edges: []\n");
  });
});

const WITH_ANCHORS = `---
id: f
title: T
x-defaults: &d { retries: 3 }
nodes:
  - id: a
    agent: x
    meta: &m { color: red }
  - id: b
    agent: x
    meta: *m
    settings: *d
edges:
  - from: a
    to: b
    kind: hands_off_to
---
Body
`;

function frontMatter(text: string): unknown {
  return parse(text.slice("---\n".length, text.indexOf("\n---", 1)));
}

describe("serializeFlowFile aliases", () => {
  it("serialize_resolves_aliases_when_anchored_entry_removed", () => {
    const text = serialized(WITH_ANCHORS, {
      id: "f",
      title: "T",
      nodes: [{ id: "b", agent: "x" }],
      edges: [],
    });

    expect(frontMatter(text)).toMatchObject({
      nodes: [
        {
          id: "b",
          meta: { color: "red" },
          settings: { retries: 3 },
        },
      ],
    });
    expect(text).not.toContain("*m");
  });

  it("serialize_resolves_aliases_when_anchored_entries_reordered", () => {
    const text = serialized(WITH_ANCHORS, {
      id: "f",
      title: "T",
      nodes: [
        { id: "b", agent: "x" },
        { id: "a", agent: "x" },
      ],
      edges: [{ from: "a", to: "b", kind: "hands_off_to" }],
    });

    expect(frontMatter(text)).toMatchObject({
      nodes: [
        { id: "b", meta: { color: "red" } },
        { id: "a", meta: { color: "red" } },
      ],
    });
  });

  it("serialize_keeps_aliases_anchored_outside_entries", () => {
    const text = serialized(WITH_ANCHORS, {
      id: "f",
      title: "T",
      nodes: [{ id: "b", agent: "x" }],
      edges: [],
    });

    expect(text).toContain("x-defaults: &d");
    expect(text).toContain("settings: *d");
  });
});

const RECURSIVE_MESSAGE =
  "Recursive YAML aliases in the flow front matter are not supported";

const RECURSIVE = `---
id: f
title: T
nodes:
  - id: a
    agent: x
    meta: &m { self: *m }
  - id: b
    agent: x
edges: []
---
Body
`;

const NESTED_ANCHORS = `---
id: f
title: T
nodes:
  - id: a
    agent: x
    meta: &m { inner: &i 1 }
  - id: b
    agent: x
    meta: *m
  - id: c
    agent: x
    other: *i
edges: []
---
Body
`;

const ROUNDS_ALIAS = `---
id: f
title: &t Old name
x-title: *t
maxRounds: &r 3
x-rounds: *r
nodes:
  - id: a
    agent: x
edges: []
---
Body
`;

const SINGLE_NODE: FlowDefinition = {
  id: "f",
  title: "Old name",
  maxRounds: 3,
  nodes: [{ id: "a", agent: "x" }],
  edges: [],
};

describe("serializeFlowFile managed-value aliases", () => {
  it("serialize_rejects_recursive_alias_without_overflow", () => {
    const result = serializeFlowFile(RECURSIVE, {
      id: "f",
      title: "T",
      nodes: [
        { id: "a", agent: "x" },
        { id: "b", agent: "y" },
      ],
      edges: [],
    });

    expect(result).toEqual({ ok: false, errors: [RECURSIVE_MESSAGE] });
  });

  it("serialize_inlines_nested_anchor_aliases_when_entries_reordered", () => {
    const text = serialized(NESTED_ANCHORS, {
      id: "f",
      title: "T",
      nodes: [
        { id: "c", agent: "x" },
        { id: "b", agent: "x" },
      ],
      edges: [],
    });

    expect(frontMatter(text)).toMatchObject({
      nodes: [
        { id: "c", other: 1 },
        { id: "b", meta: { inner: 1 } },
      ],
    });
    expect(text).not.toContain("*");
    expect(text).not.toContain("&");
  });

  it("serialize_keeps_value_of_alias_to_removed_max_rounds", () => {
    const text = serialized(ROUNDS_ALIAS, {
      ...SINGLE_NODE,
      maxRounds: undefined,
    });

    expect(frontMatter(text)).toMatchObject({ "x-rounds": 3 });
    expect(frontMatter(text)).not.toHaveProperty("maxRounds");
  });

  it("serialize_keeps_value_of_alias_to_replaced_title", () => {
    const text = serialized(ROUNDS_ALIAS, {
      ...SINGLE_NODE,
      title: "New name",
    });

    expect(frontMatter(text)).toMatchObject({
      title: "New name",
      "x-title": "Old name",
      "x-rounds": 3,
    });
  });
});

const REUSED_MESSAGE =
  "Reused YAML anchor names in the flow front matter are not supported";

const REUSED_ANCHORS = `---
id: f
title: T
v: &z 1
nodes:
  - id: a
    agent: x
    meta: &m { v: *z }
w: &z 2
y: *m
edges: []
---
Body
`;

const REUSED_OUTSIDE = `---
id: f
title: T
v: &z 1
w: &z 2
y: *z
nodes:
  - id: a
    agent: x
edges: []
---
Body
`;

const ANCHORED_KEY = `---
id: f
title: T
&k maxRounds: 3
x: *k
nodes:
  - id: a
    agent: x
edges: []
---
Body
`;

describe("serializeFlowFile anchor edge cases", () => {
  it("serialize_rejects_reused_anchor_names_when_inlining", () => {
    const result = serializeFlowFile(REUSED_ANCHORS, {
      id: "f",
      title: "T",
      nodes: [{ id: "a", agent: "x" }],
      edges: [],
    });

    expect(result).toEqual({ ok: false, errors: [REUSED_MESSAGE] });
  });

  it("serialize_allows_reused_anchor_names_without_managed_aliases", () => {
    const text = serialized(REUSED_OUTSIDE, {
      id: "f",
      title: "T",
      nodes: [{ id: "a", agent: "x" }],
      edges: [],
    });

    expect(frontMatter(text)).toMatchObject({ v: 1, w: 2, y: 2 });
  });

  it("serialize_inlines_alias_to_anchored_max_rounds_key", () => {
    const text = serialized(ANCHORED_KEY, {
      id: "f",
      title: "T",
      nodes: [{ id: "a", agent: "x" }],
      edges: [],
    });

    expect(frontMatter(text)).toMatchObject({ x: "maxRounds" });
    expect(frontMatter(text)).not.toHaveProperty("maxRounds");
  });
});

describe("serializeFlowFile errors", () => {
  it("serialize_rejects_file_without_front_matter", () => {
    expect(serializeFlowFile("# no front matter\n", EDITED)).toEqual({
      ok: false,
      errors: ["Missing YAML frontmatter"],
    });
  });

  it("serialize_rejects_invalid_yaml_front_matter", () => {
    const result = serializeFlowFile("---\nid: [unclosed\n---\nbody\n", EDITED);

    expect(result.ok).toBe(false);
  });

  it("serialize_rejects_front_matter_that_is_not_a_mapping", () => {
    const result = serializeFlowFile("---\n- a\n- b\n---\nbody\n", EDITED);

    expect(result.ok).toBe(false);
  });
});
