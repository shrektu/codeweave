import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";
import { IpcErrorCode } from "../shared/protocol";
import type { AgentView, FlowsList } from "../shared/views";

import { listedAgent } from "./agents";
import { listFlows } from "./flows";

const CODER: AgentView = {
  id: "coder",
  file: "agents/coder.md",
  source: "project",
  revision: "rev-coder",
  role: "Writes code",
  provider: "claude",
  model: null,
  permissionProfile: "plan",
  taskClass: null,
  body: "Prompt",
  usedBy: [{ file: "flows/ship.md", source: "project", title: "Ship it" }],
};

const REVIEWER: AgentView = {
  ...CODER,
  id: "reviewer",
  file: "agents/team.md",
  revision: "rev-team",
  usedBy: [],
};

const LIBRARY_CODER: AgentView = {
  ...CODER,
  file: "agents/lib-coder.md",
  source: "library",
  revision: "rev-lib-coder",
};

const LIST: FlowsList = {
  flows: [],
  agents: [CODER, REVIEWER, LIBRARY_CODER],
  errors: [],
  locations: { project: "/work", library: "/lib" },
};

it("listed_agent_returns_agent_for_listed_file_and_id", () => {
  expect(listedAgent(LIST, "agents/coder.md", "project", "coder")).toBe(CODER);
  expect(listedAgent(LIST, "agents/team.md", "project", "reviewer")).toBe(
    REVIEWER,
  );
});

it("listed_agent_matches_the_source_of_the_agent", () => {
  expect(listedAgent(LIST, "agents/lib-coder.md", "library", "coder")).toBe(
    LIBRARY_CODER,
  );
  expect(() =>
    listedAgent(LIST, "agents/lib-coder.md", "project", "coder"),
  ).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "coder" not found in agents/lib-coder.md',
    }) as Error,
  );
  expect(() =>
    listedAgent(LIST, "agents/coder.md", "library", "coder"),
  ).toThrow(expect.objectContaining({ code: IpcErrorCode.NOT_FOUND }) as Error);
});

it("listed_agent_rejects_case_variant_of_listed_file", () => {
  expect(() =>
    listedAgent(LIST, "agents/Coder.md", "project", "coder"),
  ).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "coder" not found in agents/Coder.md',
    }) as Error,
  );
});

it("listed_agent_rejects_unlisted_file", () => {
  expect(() =>
    listedAgent(LIST, "agents/alias.md", "project", "coder"),
  ).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "coder" not found in agents/alias.md',
    }) as Error,
  );
});

it("listed_agent_rejects_listed_file_with_other_id", () => {
  expect(() =>
    listedAgent(LIST, "agents/coder.md", "project", "reviewer"),
  ).toThrow(
    expect.objectContaining({
      code: IpcErrorCode.NOT_FOUND,
      message: 'Agent "reviewer" not found in agents/coder.md',
    }) as Error,
  );
});

it("library_agent_used_by_a_shadowed_library_flow_lists_that_flow", async () => {
  const flow = (title: string, agent: string): string =>
    `---\nid: ship\ntitle: ${title}\nnodes:\n  - id: build\n    agent: ${agent}\nedges: []\n---\n\nBody\n`;
  const agent = (id: string): string =>
    `---\nid: ${id}\nrole: Role\nprovider: claude\npermissionProfile: plan\n---\n\nPrompt\n`;
  const project = await makeTempDir();
  const library = await makeTempDir();
  await mkdir(join(project, "flows"));
  await mkdir(join(project, "agents"));
  await mkdir(join(library, "flows"));
  await mkdir(join(library, "agents"));
  await writeFile(join(project, "flows", "ship.md"), flow("Project", "tester"));
  await writeFile(join(project, "agents", "tester.md"), agent("tester"));
  await writeFile(join(library, "flows", "ship.md"), flow("Library", "coder"));
  await writeFile(join(library, "agents", "coder.md"), agent("coder"));

  const { agents } = await listFlows({ project, library });

  expect(agents.find(({ id }) => id === "coder")?.usedBy).toEqual([
    { file: "flows/ship.md", source: "library", title: "Library" },
  ]);
});
