import { describe, expect, it } from "vitest";

import { makeAgent } from "../../tests/fakes/fakeIpcClient";

import { agentDraftOf, emptyAgentDraft } from "./agentDraft";
import { agentEditorPinsFolder, type AgentSession } from "./useAgentEditor";

const CWD = "/home/user/project";
const VIEW = makeAgent();

function existingSession(role: string = VIEW.role): AgentSession {
  return {
    cwd: CWD,
    target: {
      kind: "existing",
      source: VIEW.source,
      file: VIEW.file,
      revision: VIEW.revision,
      id: VIEW.id,
    },
    saved: VIEW,
    draft: { ...agentDraftOf(VIEW), role },
    conflict: false,
    saveToken: null,
  };
}

function newSession(id: string): AgentSession {
  return {
    cwd: CWD,
    target: { kind: "new" },
    saved: null,
    draft: { ...emptyAgentDraft(), id },
    conflict: false,
    saveToken: null,
  };
}

describe("agentEditorPinsFolder", () => {
  it("agent_editor_pins_folder_only_when_dirty_or_saving", () => {
    expect(agentEditorPinsFolder(null, false)).toBe(false);
    expect(agentEditorPinsFolder(existingSession(), false)).toBe(false);
    expect(agentEditorPinsFolder(existingSession("Edited role"), false)).toBe(
      true,
    );
    expect(agentEditorPinsFolder(newSession(""), false)).toBe(false);
    expect(agentEditorPinsFolder(newSession("tester"), false)).toBe(true);
    expect(agentEditorPinsFolder(existingSession(), true)).toBe(true);
    expect(agentEditorPinsFolder(null, true)).toBe(true);
  });
});
