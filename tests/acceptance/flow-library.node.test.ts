import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createAgent, deleteAgent, saveAgent } from "../../src/backend/agents";
import { createFlowRunService } from "../../src/backend/flowRuns";
import { listFlows, saveFlow } from "../../src/backend/flows";
import type { AgentDefinition, FlowDefinition } from "../../src/domain/flows";
import type { DefinitionSource } from "../../src/domain/types";
import type { SessionView } from "../../src/shared/views";
import { fakeSessions } from "../fakes/fakeSessions";
import { makeTempDir } from "../fakes/processHelpers";

const CODER_AGENT = `---
id: coder
role: Writes code
provider: claude
permissionProfile: plan
---

Prompt
`;

const LIBRARY_CODER_AGENT = CODER_AGENT.replace("Writes code", "Library coder");

const SHIP_FLOW = `---
id: ship
title: Ship it
nodes:
  - id: build
    agent: coder
edges: []
---

Body
`;

const LIBRARY_SHIP_FLOW = SHIP_FLOW.replace("Ship it", "Library ship");

const RUNNING_VIEW: SessionView = {
  id: "session-1",
  cwd: "",
  provider: "claude",
  profile: "plan",
  phase: { phase: "running", accountId: "acc-a" },
  activeAccountId: "acc-a",
  activeProvider: "claude",
  messages: [],
  toolCalls: [],
  permissions: [],
  limits: [],
  lastTurn: null,
  turnInFlight: true,
  flowRef: { flowId: "ship", nodeId: "build" },
  currentModel: null,
  turns: [],
  orchestrate: false,
};

async function populate(
  root: string,
  files: Record<string, string>,
): Promise<string> {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

interface Roots {
  readonly project: string;
  readonly library: string;
}

async function roots(
  projectFiles: Record<string, string>,
  libraryFiles: Record<string, string>,
): Promise<Roots> {
  return {
    project: await populate(await makeTempDir(), projectFiles),
    library: await populate(await makeTempDir(), libraryFiles),
  };
}

async function text(root: string, file: string): Promise<string> {
  return readFile(join(root, file), "utf8");
}

it("lists_library_flows_and_agents_when_the_project_has_none", async () => {
  const dirs = await roots(
    {},
    { "flows/ship.md": LIBRARY_SHIP_FLOW, "agents/coder.md": CODER_AGENT },
  );

  const result = await listFlows(dirs);

  expect(result.errors).toEqual([]);
  expect(result.flows.map(({ id, source }) => ({ id, source }))).toEqual([
    { id: "ship", source: "library" },
  ]);
  expect(result.agents.map(({ id, source }) => ({ id, source }))).toEqual([
    { id: "coder", source: "library" },
  ]);
  expect(result.locations).toEqual(dirs);
});

it("project_definitions_override_library_ones_with_the_same_id", async () => {
  const dirs = await roots(
    { "flows/ship.md": SHIP_FLOW, "agents/coder.md": CODER_AGENT },
    {
      "flows/ship.md": LIBRARY_SHIP_FLOW,
      "agents/coder.md": LIBRARY_CODER_AGENT,
    },
  );

  const result = await listFlows(dirs);

  expect(result.errors).toEqual([]);
  expect(result.flows.map(({ title, source }) => ({ title, source }))).toEqual([
    { title: "Ship it", source: "project" },
  ]);
  expect(result.agents.map(({ role, source }) => ({ role, source }))).toEqual([
    { role: "Writes code", source: "project" },
  ]);
});

it("saving_a_library_agent_and_flow_writes_into_the_library", async () => {
  const dirs = await roots(
    { "agents/other.md": CODER_AGENT.replace("coder", "other") },
    { "flows/ship.md": LIBRARY_SHIP_FLOW, "agents/coder.md": CODER_AGENT },
  );
  const before = await listFlows(dirs);
  const flow: FlowDefinition = {
    id: "ship",
    title: "Edited ship",
    nodes: [{ id: "build", agent: "coder" }],
    edges: [],
  };

  await expect(
    saveFlow(dirs, {
      source: "library",
      file: "flows/ship.md",
      revision: before.flows[0]?.revision ?? "",
      flow,
    }),
  ).resolves.toMatchObject({
    flows: [{ id: "ship", title: "Edited ship", source: "library" }],
  });
  await expect(
    saveAgent(dirs, {
      source: "library",
      file: "agents/coder.md",
      revision: before.agents.find(({ id }) => id === "coder")?.revision ?? "",
      id: "coder",
      agent: {
        id: "coder",
        role: "Edited coder",
        provider: "claude",
        permissionProfile: "plan",
      },
      body: "Edited prompt",
    }),
  ).resolves.toMatchObject({
    agents: expect.arrayContaining([
      expect.objectContaining({ id: "coder", role: "Edited coder" }),
    ]) as unknown[],
  });

  expect(await text(dirs.library, "flows/ship.md")).toContain("Edited ship");
  expect(await text(dirs.library, "agents/coder.md")).toContain(
    "Edited prompt",
  );
  expect(await text(dirs.project, "agents/other.md")).toBe(
    CODER_AGENT.replace("coder", "other"),
  );
});

it("a_library_only_flow_runs_in_the_project_cwd", async () => {
  const dirs = await roots(
    {},
    { "flows/ship.md": LIBRARY_SHIP_FLOW, "agents/coder.md": CODER_AGENT },
  );
  const start = vi.fn(() => Promise.resolve({ ...RUNNING_VIEW }));
  const service = createFlowRunService({
    sessions: () => fakeSessions({ start }),
    releaseSessions: () => Promise.resolve(),
    mainSessionLive: () => false,
    listFlows: (cwd) => listFlows({ project: cwd, library: dirs.library }),
    inspectWorktree: (cwd) => Promise.resolve({ isRepo: false, cwd }),
    broadcast: vi.fn(),
    newRunId: () => "run-1",
  });

  const view = await service.start({
    cwd: dirs.project,
    flowId: "ship",
    task: "Do it",
  });

  expect(view.flowTitle).toBe("Library ship");
  await vi.waitFor(() => {
    expect(start).toHaveBeenCalledTimes(1);
  });
  expect(start.mock.calls[0]).toEqual([
    expect.objectContaining({ cwd: dirs.project }),
  ]);
});

const CODER: AgentDefinition = {
  id: "coder",
  role: "Writes code",
  provider: "claude",
  permissionProfile: "plan",
};

const TESTER_AGENT = CODER_AGENT.replace("coder", "tester");

function rejectedWith(
  promise: Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code,
    ...(message === undefined
      ? {}
      : { message: expect.stringContaining(message) as unknown }),
  });
}

async function agentRevision(
  dirs: Roots,
  id: string,
  source: DefinitionSource,
): Promise<string> {
  const { agents } = await listFlows(dirs);
  const found = agents.find(
    (agent) => agent.id === id && agent.source === source,
  );
  return found?.revision ?? "";
}

it("missing_library_dir_lists_nothing_without_errors", async () => {
  const dirs = await roots(
    { "flows/ship.md": SHIP_FLOW, "agents/coder.md": CODER_AGENT },
    {},
  );

  const result = await listFlows({
    project: dirs.project,
    library: join(dirs.library, "absent"),
  });

  expect(result.errors).toEqual([]);
  expect(result.flows.map(({ source }) => source)).toEqual(["project"]);
});

it("library_path_that_is_a_file_yields_library_errors_and_keeps_project_definitions", async () => {
  const dirs = await roots(
    { "flows/ship.md": SHIP_FLOW, "agents/coder.md": CODER_AGENT },
    { "notes.md": "not a folder" },
  );

  const result = await listFlows({
    project: dirs.project,
    library: join(dirs.library, "notes.md"),
  });

  expect(result.flows.map(({ id }) => id)).toEqual(["ship"]);
  expect(result.errors.map(({ file, source }) => ({ file, source }))).toEqual([
    { file: "flows", source: "library" },
    { file: "agents", source: "library" },
  ]);
});

it("library_equal_to_project_is_not_duplicated", async () => {
  const project = await populate(await makeTempDir(), {
    "flows/ship.md": SHIP_FLOW,
    "agents/coder.md": CODER_AGENT,
  });

  const result = await listFlows({ project, library: project });

  expect(result.errors).toEqual([]);
  expect(result.flows.map(({ source }) => source)).toEqual(["project"]);
  expect(result.agents.map(({ source }) => source)).toEqual(["project"]);
});

it.skipIf(process.platform === "win32")(
  "library_symlinked_to_project_is_not_duplicated",
  async () => {
    const project = await populate(await makeTempDir(), {
      "flows/ship.md": SHIP_FLOW,
      "agents/coder.md": CODER_AGENT,
    });
    const link = join(await makeTempDir(), "library-link");
    await symlink(project, link);

    const result = await listFlows({ project, library: link });

    expect(result.errors).toEqual([]);
    expect(result.flows).toHaveLength(1);
    expect(result.agents).toHaveLength(1);
  },
);

it("saving_with_source_library_a_file_that_exists_only_in_the_project_is_not_found", async () => {
  const dirs = await roots(
    { "flows/ship.md": SHIP_FLOW, "agents/coder.md": CODER_AGENT },
    { "agents/tester.md": TESTER_AGENT },
  );
  const before = await listFlows(dirs);

  await rejectedWith(
    saveFlow(dirs, {
      source: "library",
      file: "flows/ship.md",
      revision: before.flows[0]?.revision ?? "",
      flow: {
        id: "ship",
        title: "X",
        nodes: [{ id: "build", agent: "coder" }],
        edges: [],
      },
    }),
    "NOT_FOUND",
  );
  await rejectedWith(
    saveAgent(dirs, {
      source: "library",
      file: "agents/coder.md",
      revision: await agentRevision(dirs, "coder", "project"),
      id: "coder",
      agent: { ...CODER, role: "Hacked" },
      body: "Prompt",
    }),
    "NOT_FOUND",
  );
  expect(await text(dirs.project, "agents/coder.md")).toBe(CODER_AGENT);
});

it("project_flow_may_use_a_library_agent_and_library_flow_may_use_a_project_agent", async () => {
  const dirs = await roots(
    {
      "flows/ship.md": SHIP_FLOW.replace("coder", "tester"),
      "agents/coder.md": CODER_AGENT,
    },
    {
      "agents/tester.md": TESTER_AGENT,
      "flows/lib.md": LIBRARY_SHIP_FLOW.replace("id: ship", "id: lib"),
    },
  );

  const result = await listFlows(dirs);

  expect(result.errors).toEqual([]);
  expect(result.flows.map(({ id, source }) => ({ id, source }))).toEqual([
    { id: "ship", source: "project" },
    { id: "lib", source: "library" },
  ]);
  const tester = result.agents.find(({ id }) => id === "tester");
  expect(tester?.usedBy).toEqual([
    { file: "flows/ship.md", source: "project", title: "Ship it" },
  ]);
  const coder = result.agents.find(({ id }) => id === "coder");
  expect(coder?.usedBy).toEqual([
    { file: "flows/lib.md", source: "library", title: "Library ship" },
  ]);
});

it("a_library_agent_shadowed_by_the_project_is_not_listed_and_not_used_for_usage", async () => {
  const dirs = await roots(
    { "agents/coder.md": CODER_AGENT },
    {
      "agents/coder.md": LIBRARY_CODER_AGENT,
      "agents/tester.md": `${TESTER_AGENT}---
id: coder
role: Hidden twin
provider: codex
permissionProfile: ask
---

Hidden
`,
    },
  );

  const result = await listFlows(dirs);

  expect(result.agents.map(({ id, source }) => ({ id, source }))).toEqual([
    { id: "coder", source: "project" },
    { id: "tester", source: "library" },
  ]);
});

it("a_flow_in_the_library_using_an_agent_nobody_defines_is_an_error", async () => {
  const dirs = await roots({}, { "flows/ship.md": LIBRARY_SHIP_FLOW });

  const result = await listFlows(dirs);

  expect(result.flows).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "flows/ship.md",
      source: "library",
      messages: ['Node "build" uses unknown agent "coder"'],
    },
  ]);
});

it("duplicate_flow_ids_inside_the_library_keep_the_duplicate_error", async () => {
  const dirs = await roots(
    {},
    {
      "agents/coder.md": CODER_AGENT,
      "flows/a.md": LIBRARY_SHIP_FLOW,
      "flows/b.md": LIBRARY_SHIP_FLOW,
    },
  );

  const result = await listFlows(dirs);

  expect(result.flows.map(({ file }) => file)).toEqual(["flows/a.md"]);
  expect(result.errors).toEqual([
    {
      file: "flows/b.md",
      source: "library",
      messages: ['Duplicate flow id "ship" (already defined in flows/a.md)'],
    },
  ]);
});

it("a_library_flow_is_validated_on_save_against_project_agents_too", async () => {
  const dirs = await roots(
    { "agents/coder.md": CODER_AGENT },
    { "flows/ship.md": LIBRARY_SHIP_FLOW },
  );
  const { flows } = await listFlows(dirs);
  const revision = flows[0]?.revision ?? "";
  const base: FlowDefinition = {
    id: "ship",
    title: "Edited",
    nodes: [{ id: "build", agent: "coder" }],
    edges: [],
  };

  await rejectedWith(
    saveFlow(dirs, {
      source: "library",
      file: "flows/ship.md",
      revision,
      flow: { ...base, nodes: [{ id: "build", agent: "ghost" }] },
    }),
    "VALIDATION",
    "ghost",
  );
  const saved = await saveFlow(dirs, {
    source: "library",
    file: "flows/ship.md",
    revision,
    flow: base,
  });

  expect(saved.flows[0]?.title).toBe("Edited");
});

it("library_file_with_dot_dot_segment_is_rejected", async () => {
  const dirs = await roots({}, { "agents/coder.md": CODER_AGENT });
  await writeFile(join(dirs.library, "outside.md"), CODER_AGENT);
  const revision = await agentRevision(dirs, "coder", "library");

  await rejectedWith(
    saveAgent(dirs, {
      source: "library",
      file: "agents/../outside.md",
      revision,
      id: "coder",
      agent: { ...CODER, role: "Hacked" },
      body: "Prompt",
    }),
    "VALIDATION",
  );
  await rejectedWith(
    saveFlow(dirs, {
      source: "library",
      file: "flows/../outside.md",
      revision,
      flow: {
        id: "x",
        title: "X",
        nodes: [{ id: "a", agent: "coder" }],
        edges: [],
      },
    }),
    "VALIDATION",
  );
  expect(await text(dirs.library, "outside.md")).toBe(CODER_AGENT);
});

it.skipIf(process.platform === "win32")(
  "symlinked_library_agent_file_escaping_agents_dir_is_rejected",
  async () => {
    const dirs = await roots({}, { "agents/coder.md": CODER_AGENT });
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.md"), CODER_AGENT);
    await symlink(
      join(outside, "secret.md"),
      join(dirs.library, "agents", "link.md"),
    );
    const revision = await agentRevision(dirs, "coder", "library");

    await rejectedWith(
      saveAgent(dirs, {
        source: "library",
        file: "agents/link.md",
        revision,
        id: "coder",
        agent: { ...CODER, role: "Hacked" },
        body: "Prompt",
      }),
      "VALIDATION",
    );
    await rejectedWith(
      deleteAgent(dirs, {
        source: "library",
        file: "agents/link.md",
        revision,
        id: "coder",
      }),
      "VALIDATION",
    );

    expect(await text(outside, "secret.md")).toBe(CODER_AGENT);
  },
);

it.skipIf(process.platform === "win32")(
  "symlinked_library_flow_file_escaping_flows_dir_is_rejected",
  async () => {
    const dirs = await roots(
      { "agents/coder.md": CODER_AGENT },
      { "flows/ship.md": LIBRARY_SHIP_FLOW },
    );
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.md"), LIBRARY_SHIP_FLOW);
    await symlink(
      join(outside, "secret.md"),
      join(dirs.library, "flows", "link.md"),
    );

    await rejectedWith(
      saveFlow(dirs, {
        source: "library",
        file: "flows/link.md",
        revision: "any",
        flow: {
          id: "ship",
          title: "X",
          nodes: [{ id: "build", agent: "coder" }],
          edges: [],
        },
      }),
      "VALIDATION",
    );

    expect(await text(outside, "secret.md")).toBe(LIBRARY_SHIP_FLOW);
  },
);

it.skipIf(process.platform === "win32")(
  "library_agents_dir_symlinked_outside_the_library_root_is_rejected_on_create",
  async () => {
    const dirs = await roots({}, {});
    const outside = await makeTempDir();
    await symlink(outside, join(dirs.library, "agents"));

    await rejectedWith(
      createAgent(dirs, { source: "library", agent: CODER, body: "Prompt" }),
      "VALIDATION",
    );

    expect(await readdir(outside)).toEqual([]);
  },
);

it("creating_a_library_agent_writes_only_into_the_library", async () => {
  const dirs = await roots({ "agents/tester.md": TESTER_AGENT }, {});

  const result = await createAgent(dirs, {
    source: "library",
    agent: CODER,
    body: "Prompt",
  });

  expect(await readdir(join(dirs.library, "agents"))).toEqual(["coder.md"]);
  expect(await readdir(join(dirs.project, "agents"))).toEqual(["tester.md"]);
  expect(result.agents.map(({ id, source }) => ({ id, source }))).toEqual([
    { id: "tester", source: "project" },
    { id: "coder", source: "library" },
  ]);
});

it("creating_an_agent_without_a_source_writes_into_the_project", async () => {
  const dirs = await roots({}, {});

  await createAgent(dirs, { agent: CODER, body: "Prompt" });

  expect(await readdir(join(dirs.project, "agents"))).toEqual(["coder.md"]);
});

it("deleting_a_library_agent_removes_only_the_library_file", async () => {
  const dirs = await roots(
    { "agents/tester.md": TESTER_AGENT },
    { "agents/coder.md": CODER_AGENT },
  );

  const result = await deleteAgent(dirs, {
    source: "library",
    file: "agents/coder.md",
    revision: await agentRevision(dirs, "coder", "library"),
    id: "coder",
  });

  expect(result.agents.map(({ id }) => id)).toEqual(["tester"]);
  expect(await readdir(join(dirs.library, "agents"))).toEqual([]);
  expect(await readdir(join(dirs.project, "agents"))).toEqual(["tester.md"]);
});

it("a_project_agent_may_reuse_a_library_agent_id_and_overrides_it", async () => {
  const dirs = await roots({}, { "agents/coder.md": LIBRARY_CODER_AGENT });

  const result = await createAgent(dirs, {
    source: "project",
    agent: CODER,
    body: "Prompt",
  });

  expect(result.agents.map(({ role, source }) => ({ role, source }))).toEqual([
    { role: "Writes code", source: "project" },
  ]);
  expect(await text(dirs.library, "agents/coder.md")).toBe(LIBRARY_CODER_AGENT);
});

it("a_library_agent_cannot_take_an_id_defined_in_the_project", async () => {
  const dirs = await roots(
    { "agents/coder.md": CODER_AGENT },
    { "agents/tester.md": TESTER_AGENT },
  );
  const message =
    'Agent "coder" is already defined in the project, which overrides the library';

  await rejectedWith(
    createAgent(dirs, { source: "library", agent: CODER, body: "Prompt" }),
    "VALIDATION",
    message,
  );
  await rejectedWith(
    saveAgent(dirs, {
      source: "library",
      file: "agents/tester.md",
      revision: await agentRevision(dirs, "tester", "library"),
      id: "tester",
      agent: { ...CODER, id: "coder" },
      body: "Prompt",
    }),
    "VALIDATION",
    message,
  );

  expect(await readdir(join(dirs.library, "agents"))).toEqual(["tester.md"]);
  expect(await text(dirs.library, "agents/tester.md")).toBe(TESTER_AGENT);
});

it("a_library_agent_rename_collides_with_a_shadowed_library_agent_id", async () => {
  const dirs = await roots(
    { "agents/coder.md": CODER_AGENT },
    {
      "agents/coder.md": LIBRARY_CODER_AGENT,
      "agents/tester.md": TESTER_AGENT,
    },
  );

  await rejectedWith(
    saveAgent(dirs, {
      source: "library",
      file: "agents/tester.md",
      revision: await agentRevision(dirs, "tester", "library"),
      id: "tester",
      agent: { ...CODER, id: "coder" },
      body: "Prompt",
    }),
    "VALIDATION",
  );

  expect(await text(dirs.library, "agents/tester.md")).toBe(TESTER_AGENT);
});

it("a_library_agent_can_be_renamed_to_a_free_id", async () => {
  const dirs = await roots({}, { "agents/coder.md": CODER_AGENT });

  const result = await saveAgent(dirs, {
    source: "library",
    file: "agents/coder.md",
    revision: await agentRevision(dirs, "coder", "library"),
    id: "coder",
    agent: { ...CODER, id: "builder" },
    body: "Prompt",
  });

  expect(result.agents.map(({ id, source }) => ({ id, source }))).toEqual([
    { id: "builder", source: "library" },
  ]);
  expect(await readdir(join(dirs.library, "agents"))).toEqual(["builder.md"]);
});

it("deleting_a_library_agent_used_by_a_project_flow_is_refused", async () => {
  const dirs = await roots(
    { "flows/ship.md": SHIP_FLOW },
    { "agents/coder.md": CODER_AGENT },
  );

  await rejectedWith(
    deleteAgent(dirs, {
      source: "library",
      file: "agents/coder.md",
      revision: await agentRevision(dirs, "coder", "library"),
      id: "coder",
    }),
    "VALIDATION",
    "Ship it",
  );

  expect(await text(dirs.library, "agents/coder.md")).toBe(CODER_AGENT);
});

it("library_agent_used_by_a_shadowed_library_flow_cannot_be_deleted", async () => {
  const dirs = await roots(
    {
      "flows/ship.md": SHIP_FLOW.replace("coder", "tester"),
      "agents/tester.md": TESTER_AGENT,
    },
    { "flows/ship.md": LIBRARY_SHIP_FLOW, "agents/coder.md": CODER_AGENT },
  );

  const { agents } = await listFlows(dirs);
  const coder = agents.find(({ id }) => id === "coder");
  expect(coder?.usedBy).toEqual([
    { file: "flows/ship.md", source: "library", title: "Library ship" },
  ]);
  await rejectedWith(
    deleteAgent(dirs, {
      source: "library",
      file: "agents/coder.md",
      revision: await agentRevision(dirs, "coder", "library"),
      id: "coder",
    }),
    "VALIDATION",
    "Library ship",
  );

  expect(await text(dirs.library, "agents/coder.md")).toBe(CODER_AGENT);
});

it("invalid_project_flow_still_overrides_library_flow", async () => {
  const dirs = await roots(
    { "flows/ship.md": SHIP_FLOW.replace("coder", "ghost") },
    { "flows/ship.md": LIBRARY_SHIP_FLOW, "agents/coder.md": CODER_AGENT },
  );

  const result = await listFlows(dirs);

  expect(result.flows).toEqual([]);
  expect(result.errors.map(({ file, source }) => ({ file, source }))).toEqual([
    { file: "flows/ship.md", source: "project" },
  ]);
});
