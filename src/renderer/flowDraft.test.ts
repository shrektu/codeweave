import { describe, expect, it } from "vitest";

import { EdgeKind, ProviderId } from "../domain/types";
import { makeAgent, makeFlow } from "../../tests/fakes/fakeIpcClient";

import {
  addEdge,
  addNode,
  baseOf,
  draftErrors,
  draftOf,
  edgeKey,
  isDraftChanged,
  removeEdge,
  removeNode,
  saveParamsOf,
  setMaxRounds,
  toDefinition,
  updateEdge,
  updateNode,
  type FlowDraft,
} from "./flowDraft";

const AGENTS = [makeAgent(), makeAgent({ id: "reviewer" })];

function baseDraft(): FlowDraft {
  return draftOf(makeFlow());
}

function ok(result: ReturnType<typeof addNode>): FlowDraft {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.draft;
}

describe("addNode", () => {
  it("appends a valid node", () => {
    const draft = ok(
      addNode(baseDraft(), { id: "docs_1", agent: "reviewer", provider: null }),
    );
    expect(draft.nodes.map((node) => node.id)).toEqual([
      "build",
      "review",
      "docs_1",
    ]);
  });

  it.each([
    ["", "Node id is required"],
    ["has space", "Node id may only contain letters, digits, - and _"],
    ["dot.id", "Node id may only contain letters, digits, - and _"],
    ["build", 'Node id "build" already exists'],
  ])("rejects id %j", (id, message) => {
    expect(
      addNode(baseDraft(), { id, agent: "reviewer", provider: null }),
    ).toEqual({ ok: false, error: message });
  });
});

describe("removeNode", () => {
  it("drops the node and every edge touching it", () => {
    const draft = ok(
      addEdge(baseDraft(), {
        from: "review",
        to: "build",
        kind: EdgeKind.reviews,
        gate: false,
      }),
    );
    const next = removeNode(draft, "review");
    expect(next.nodes.map((node) => node.id)).toEqual(["build"]);
    expect(next.edges).toEqual([]);
  });

  it("keeps unrelated edges", () => {
    const draft = ok(
      addNode(baseDraft(), { id: "docs", agent: "reviewer", provider: null }),
    );
    expect(removeNode(draft, "docs").edges).toEqual(draft.edges);
  });
});

describe("updateNode", () => {
  it("changes agent and provider of one node only", () => {
    const next = updateNode(baseDraft(), "build", {
      agent: "reviewer",
      provider: ProviderId.gemini,
    });
    expect(next.nodes).toEqual([
      { id: "build", agent: "reviewer", provider: "gemini" },
      { id: "review", agent: "reviewer", provider: null },
    ]);
  });

  it("clears the provider override with null", () => {
    const withProvider = updateNode(baseDraft(), "build", {
      provider: ProviderId.codex,
    });
    expect(
      updateNode(withProvider, "build", { provider: null }).nodes[0],
    ).toEqual({ id: "build", agent: "implementer", provider: null });
  });
});

describe("addEdge", () => {
  it("rejects a self edge", () => {
    expect(
      addEdge(baseDraft(), {
        from: "build",
        to: "build",
        kind: EdgeKind.waitsFor,
        gate: false,
      }),
    ).toEqual({ ok: false, error: "A node cannot connect to itself" });
  });

  it("rejects a duplicate from/to/kind but allows another kind", () => {
    const duplicate = addEdge(baseDraft(), {
      from: "build",
      to: "review",
      kind: EdgeKind.handsOffTo,
      gate: true,
    });
    expect(duplicate).toEqual({
      ok: false,
      error: "Edge build->review:hands_off_to already exists",
    });
    const other = ok(
      addEdge(baseDraft(), {
        from: "build",
        to: "review",
        kind: EdgeKind.waitsFor,
        gate: false,
      }),
    );
    expect(other.edges).toHaveLength(2);
  });
});

describe("updateEdge", () => {
  it("updates kind and gate and refuses a kind that collides", () => {
    const withTwo = ok(
      addEdge(baseDraft(), {
        from: "build",
        to: "review",
        kind: EdgeKind.waitsFor,
        gate: false,
      }),
    );
    const gated = ok(
      updateEdge(withTwo, "build->review:hands_off_to", { gate: true }),
    );
    expect(gated.edges[0]).toEqual({
      from: "build",
      to: "review",
      kind: "hands_off_to",
      gate: true,
    });
    expect(
      updateEdge(withTwo, "build->review:hands_off_to", {
        kind: EdgeKind.waitsFor,
      }),
    ).toEqual({
      ok: false,
      error: "Edge build->review:waits_for already exists",
    });
    const renamed = ok(
      updateEdge(baseDraft(), "build->review:hands_off_to", {
        kind: EdgeKind.reviews,
      }),
    );
    expect(renamed.edges.map(edgeKey)).toEqual(["build->review:reviews"]);
  });

  it("reports an unknown edge key", () => {
    expect(updateEdge(baseDraft(), "x->y:reviews", { gate: true })).toEqual({
      ok: false,
      error: "Edge x->y:reviews does not exist",
    });
  });
});

describe("removeEdge", () => {
  it("removes by key", () => {
    expect(removeEdge(baseDraft(), "build->review:hands_off_to").edges).toEqual(
      [],
    );
  });
});

describe("setMaxRounds", () => {
  it.each([1, 5, 10])("accepts %i", (rounds) => {
    expect(ok(setMaxRounds(baseDraft(), rounds)).maxRounds).toBe(rounds);
  });

  it.each([0, 11, 2.5, Number.NaN])("rejects %s", (rounds) => {
    expect(setMaxRounds(baseDraft(), rounds)).toEqual({
      ok: false,
      error: "Max rounds must be a whole number from 1 to 10",
    });
  });
});

describe("toDefinition", () => {
  it("omits null providers and false gates and keeps set ones", () => {
    const draft = ok(
      addEdge(
        updateNode(baseDraft(), "review", { provider: ProviderId.codex }),
        { from: "review", to: "build", kind: EdgeKind.reviews, gate: true },
      ),
    );
    expect(toDefinition(draft)).toEqual({
      id: "ship",
      title: "Ship it",
      maxRounds: 2,
      nodes: [
        { id: "build", agent: "implementer" },
        { id: "review", agent: "reviewer", provider: "codex" },
      ],
      edges: [
        { from: "build", to: "review", kind: "hands_off_to" },
        { from: "review", to: "build", kind: "reviews", gate: true },
      ],
    });
  });
});

describe("draftErrors", () => {
  it("is empty for the untouched flow", () => {
    expect(draftErrors(baseDraft(), AGENTS)).toEqual([]);
  });

  it("surfaces cycle, unknown agent and duplicate id messages", () => {
    const cyclic = ok(
      addEdge(baseDraft(), {
        from: "review",
        to: "build",
        kind: EdgeKind.handsOffTo,
        gate: false,
      }),
    );
    const broken: FlowDraft = {
      ...cyclic,
      nodes: [...cyclic.nodes, { id: "build", agent: "ghost", provider: null }],
    };
    expect(draftErrors(broken, AGENTS)).toEqual([
      'Duplicate node id "build"',
      'Node "build" uses unknown agent "ghost"',
      "Cycle in flow order: build -> review -> build",
    ]);
  });

  it("reports an empty flow", () => {
    expect(
      draftErrors({ ...baseDraft(), nodes: [], edges: [] }, AGENTS),
    ).toEqual(["Flow has no nodes"]);
  });
});

describe("saveParamsOf", () => {
  it("save_params_use_draft_base_revision", () => {
    const started = makeFlow({ revision: "rev-1" });
    const base = baseOf(started);
    const draft = ok(
      addNode(draftOf(started), {
        id: "docs",
        agent: "reviewer",
        provider: null,
      }),
    );

    expect(saveParamsOf("/work", base, draft)).toEqual({
      cwd: "/work",
      file: "flows/ship.md",
      revision: "rev-1",
      flow: {
        id: "ship",
        title: "Ship it",
        maxRounds: 2,
        nodes: [
          { id: "build", agent: "implementer" },
          { id: "review", agent: "reviewer" },
          { id: "docs", agent: "reviewer" },
        ],
        edges: [{ from: "build", to: "review", kind: "hands_off_to" }],
      },
    });
  });
});

describe("isDraftChanged", () => {
  it("is false for a fresh draft and true after an edit", () => {
    const view = makeFlow();
    expect(isDraftChanged(draftOf(view), view)).toBe(false);
    expect(isDraftChanged(ok(setMaxRounds(draftOf(view), 3)), view)).toBe(true);
  });
});
