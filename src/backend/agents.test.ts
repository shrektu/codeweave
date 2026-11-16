import { expect, it } from "vitest";

import { IpcErrorCode } from "../shared/protocol";
import type { AgentView, FlowsList } from "../shared/views";

import { listedAgent } from "./agents";

const CODER: AgentView = {
  id: "coder",
  file: "agents/coder.md",
  revision: "rev-coder",
  role: "Writes code",
  provider: "claude",
  model: null,
  permissionProfile: "plan",
  taskClass: null,
  body: "Prompt",
  usedBy: [{ file: "flows/ship.md", title: "Ship it" }],
};

const REVIEWER: AgentView = {
  ...CODER,
  id: "reviewer",
  file: "agents/team.md",
  revision: "rev-team",
  usedBy: [],
};

const LIST: FlowsList = { flows: [], agents: [CODER, REVIEWER], errors: [] };

it("listed_agent_returns_agent_for_listed_file_and_id", () => {
  expect(listedAgent(LIST, "agents/coder.md", "coder")).toBe(CODER);
  expect(listedAgent(LIST, "agents/team.md", "reviewer")).toBe(REVIEWER);
});

it("listed_agent_rejects_case_variant_of_listed_file", () => {
  expect(() => listedAgent(LIST, "agents/Coder.md", "coder")).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "coder" not found in agents/Coder.md',
    }) as Error,
  );
});

it("listed_agent_rejects_unlisted_file", () => {
  expect(() => listedAgent(LIST, "agents/alias.md", "coder")).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "coder" not found in agents/alias.md',
    }) as Error,
  );
});

it("listed_agent_rejects_listed_file_with_other_id", () => {
  expect(() => listedAgent(LIST, "agents/coder.md", "reviewer")).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "reviewer" not found in agents/coder.md',
    }) as Error,
  );
});
