import { describe, expect, it } from "vitest";

import { PermissionProfile, ProviderId } from "../domain/types";
import { makeAgent } from "../../tests/fakes/fakeIpcClient";

import {
  agentDraftErrors,
  agentDraftOf,
  emptyAgentDraft,
  isAgentDraftChanged,
  toAgentDefinition,
  type AgentDraft,
} from "./agentDraft";

const VIEW = makeAgent({
  model: "sonnet",
  taskClass: "coding",
  body: "Do the work.",
});

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return { ...agentDraftOf(VIEW), ...overrides };
}

describe("emptyAgentDraft", () => {
  it("defaults to claude with the ask profile and empty text", () => {
    expect(emptyAgentDraft()).toEqual({
      id: "",
      role: "",
      provider: "claude",
      model: "",
      permissionProfile: "ask",
      taskClass: "",
      body: "",
    });
  });
});

describe("agentDraftOf", () => {
  it("copies every field of the view", () => {
    expect(agentDraftOf(VIEW)).toEqual({
      id: "implementer",
      role: "Implements the planned change",
      provider: "claude",
      model: "sonnet",
      permissionProfile: "plan",
      taskClass: "coding",
      body: "Do the work.",
    });
  });

  it("maps null model and task class to empty strings", () => {
    const result = agentDraftOf(makeAgent({ model: null, taskClass: null }));

    expect(result.model).toBe("");
    expect(result.taskClass).toBe("");
  });
});

describe("toAgentDefinition", () => {
  it("trims model and task class", () => {
    expect(
      toAgentDefinition(draft({ model: "  gpt-5  ", taskClass: " qa " })),
    ).toEqual({
      id: "implementer",
      role: "Implements the planned change",
      provider: "claude",
      permissionProfile: "plan",
      model: "gpt-5",
      taskClass: "qa",
    });
  });

  it("omits blank model and task class", () => {
    const definition = toAgentDefinition(
      draft({ model: "   ", taskClass: "" }),
    );

    expect(Object.keys(definition).toSorted()).toEqual([
      "id",
      "permissionProfile",
      "provider",
      "role",
    ]);
  });
});

describe("agentDraftErrors", () => {
  const others = [
    makeAgent({ id: "reviewer" }),
    makeAgent({ id: "implementer" }),
  ];

  it("excludes the original id from duplicate checks", () => {
    expect(agentDraftErrors(draft(), others, "implementer")).toEqual([]);
  });

  it("catches duplicates that differ only by case", () => {
    expect(
      agentDraftErrors(draft({ id: "REVIEWER" }), others, "implementer"),
    ).toEqual(['Agent id "REVIEWER" is already used by another agent']);
  });

  it("treats a new agent's own id as taken when it already exists", () => {
    expect(agentDraftErrors(draft(), others, null)).toEqual([
      'Agent id "implementer" is already used by another agent',
    ]);
  });

  it("reports a blank role and a fence line in the body", () => {
    expect(
      agentDraftErrors(
        draft({ role: " ", body: "a\n---\nb" }),
        others,
        "implementer",
      ),
    ).toEqual([
      "Role must not be blank",
      'Instructions must not contain a line that is exactly "---"',
    ]);
  });
});

describe("isAgentDraftChanged", () => {
  it("is false for an unmodified draft", () => {
    expect(isAgentDraftChanged(agentDraftOf(VIEW), VIEW)).toBe(false);
  });

  it.each<[string, Partial<AgentDraft>]>([
    ["id", { id: "other" }],
    ["role", { role: "Other role" }],
    ["provider", { provider: ProviderId.codex }],
    ["model", { model: "gpt-5" }],
    ["permissionProfile", { permissionProfile: PermissionProfile.bypass }],
    ["taskClass", { taskClass: "qa" }],
    ["body", { body: "Changed." }],
  ])("is true when %s differs", (_field, change) => {
    expect(isAgentDraftChanged(draft(change), VIEW)).toBe(true);
  });

  it("compares a new agent against the empty draft", () => {
    expect(isAgentDraftChanged(emptyAgentDraft(), null)).toBe(false);
    expect(isAgentDraftChanged({ ...emptyAgentDraft(), id: "x" }, null)).toBe(
      true,
    );
  });
});
