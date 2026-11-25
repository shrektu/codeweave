import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { listFlows } from "../../src/backend/flows";
import { createFlowRunService } from "../../src/backend/flowRuns";
import { createHandlers } from "../../src/backend/handlers";
import { createJsonStore } from "../../src/backend/storage";
import type { AgentDefinition, FlowDefinition } from "../../src/domain/flows";
import { IpcErrorCode, type ParamsMap } from "../../src/shared/protocol";
import type { AgentView, FlowsList, SessionView } from "../../src/shared/views";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionPool,
  fakeSessions,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { projectRoots } from "../fakes/definitionRoots";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const CODER_FILE = "agents/coder.md";
const TEAM_FILE = "agents/team.md";
const FLOW_FILE = "flows/ship.md";
const SHA256_HEX = /^[0-9a-f]{64}$/;

const CODER_TEXT = `---
id: coder
role: Writes code
provider: claude
permissionProfile: plan
---

Prompt
`;

const REVIEWER_TEXT = `---
id: reviewer
role: Reviews code
provider: codex
permissionProfile: plan
---

Review prompt
`;

const PLANNER_BLOCK = `---
id: planner
role: Plans work
provider: claude
permissionProfile: plan
---

Plan carefully.

`;

const BUILDER_BLOCK = `---
id: builder
# keep this comment
role: Builds things
provider: claude
model: old-model
permissionProfile: plan
owner: team-a
---

Build it.

`;

const CHECKER_BLOCK = `---
id: checker
role: Checks things
provider: codex
permissionProfile: ask
---

Check it.
`;

const TEAM_TEXT = `${PLANNER_BLOCK}${BUILDER_BLOCK}${CHECKER_BLOCK}`;

const SHIP_FLOW = `---
id: ship
title: Ship it
nodes:
  - id: build
    agent: coder
edges: []
---

# Ship
`;

const BROKEN_FLOW = `---
id: broken
title: Broken flow
nodes:
  - id: build
    agent: coder
  - id: ghost
    agent: nobody
edges: []
---
`;

const CODER: AgentDefinition = {
  id: "coder",
  role: "Writes code",
  provider: "claude",
  permissionProfile: "plan",
};

const SHIP_WITH_REVIEWER: FlowDefinition = {
  id: "ship",
  title: "Ship it",
  nodes: [
    { id: "build", agent: "coder" },
    { id: "check", agent: "reviewer" },
  ],
  edges: [{ from: "build", to: "check", kind: "hands_off_to" }],
};

async function project(files: Record<string, string>): Promise<string> {
  const cwd = await makeTempDir();
  for (const [relative, content] of Object.entries(files)) {
    const file = join(cwd, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  return cwd;
}

function handlersFor(cwd: string): ReturnType<typeof createHandlers> {
  return createHandlers({
    store: createJsonStore(cwd),
    ...fakeSecrets(cwd),
    userData: cwd,
    homeDir: tmpdir(),
    broadcast: vi.fn(),
    sessions: fakeSessionPool(),
    flowRuns: fakeFlowRuns(),
    orchestrator: fakeOrchestrator(),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals: fakeTerminals(),
    postUpdaterConfig: () => undefined,
  });
}

async function createAgent(
  cwd: string,
  params: Omit<ParamsMap["agents/create"], "cwd">,
): Promise<FlowsList> {
  const handlers = handlersFor(cwd);
  expect(handlers).toHaveProperty("agents/create");
  return handlers["agents/create"]({ cwd, ...params });
}

async function saveAgent(
  cwd: string,
  params: Omit<ParamsMap["agents/save"], "cwd" | "source">,
): Promise<FlowsList> {
  const handlers = handlersFor(cwd);
  expect(handlers).toHaveProperty("agents/save");
  return handlers["agents/save"]({ cwd, source: "project", ...params });
}

async function deleteAgent(
  cwd: string,
  params: Omit<ParamsMap["agents/delete"], "cwd" | "source">,
): Promise<FlowsList> {
  const handlers = handlersFor(cwd);
  expect(handlers).toHaveProperty("agents/delete");
  return handlers["agents/delete"]({ cwd, source: "project", ...params });
}

async function listed(cwd: string): Promise<FlowsList> {
  return handlersFor(cwd)["flows/list"]({ cwd });
}

async function agentOf(cwd: string, id: string): Promise<AgentView> {
  const found = (await listed(cwd)).agents.find((agent) => agent.id === id);
  if (found === undefined) {
    throw new Error(`agent ${id} is not listed`);
  }
  return found;
}

async function text(cwd: string, file: string): Promise<string> {
  return readFile(join(cwd, file), "utf8");
}

async function agentFiles(cwd: string): Promise<string[]> {
  return (await readdir(join(cwd, "agents"))).toSorted();
}

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

it("create_writes_agent_file_and_lists_it", async () => {
  const cwd = await project({ [CODER_FILE]: CODER_TEXT });

  const result = await createAgent(cwd, {
    agent: {
      id: "reviewer",
      role: "Reviews code",
      provider: "codex",
      model: "gpt-5",
      permissionProfile: "plan",
      taskClass: "light",
    },
    body: "\n  Review it.\n\n",
  });

  expect(await text(cwd, "agents/reviewer.md")).toBe(`---
id: reviewer
role: Reviews code
provider: codex
model: gpt-5
permissionProfile: plan
taskClass: light
---

Review it.
`);
  expect(await agentFiles(cwd)).toEqual(["coder.md", "reviewer.md"]);
  expect(result.errors).toEqual([]);
  expect(result.agents.find((agent) => agent.id === "reviewer")).toMatchObject({
    role: "Reviews code",
    provider: "codex",
    permissionProfile: "plan",
    model: "gpt-5",
    taskClass: "light",
    body: "Review it.",
    file: "agents/reviewer.md",
    usedBy: [],
  });
});

it("list_reports_file_revision_model_taskclass_and_used_by", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    "agents/reviewer.md": REVIEWER_TEXT,
    [FLOW_FILE]: SHIP_FLOW,
    "flows/broken.md": BROKEN_FLOW,
  });

  const list = await listed(cwd);

  expect(list.errors.map(({ file }) => file)).toEqual(["flows/broken.md"]);
  expect(list.agents).toHaveLength(2);
  expect(list.agents[0]).toMatchObject({
    id: "coder",
    file: CODER_FILE,
    revision: createHash("sha256").update(CODER_TEXT).digest("hex"),
    model: null,
    taskClass: null,
    usedBy: [
      { file: "flows/broken.md", title: "Broken flow" },
      { file: FLOW_FILE, title: "Ship it" },
    ],
  });
  expect(list.agents[1]).toMatchObject({
    id: "reviewer",
    file: "agents/reviewer.md",
    usedBy: [],
  });
  expect(list.agents[1]?.revision).toMatch(SHA256_HEX);
});

it("create_rejects_duplicate_id_case_insensitive", async () => {
  const cwd = await project({ [CODER_FILE]: CODER_TEXT });

  await rejectedWith(
    createAgent(cwd, { agent: { ...CODER, id: "Coder" }, body: "Other" }),
    IpcErrorCode.VALIDATION,
    "Coder",
  );

  expect(await agentFiles(cwd)).toEqual(["coder.md"]);
});

it("create_rejects_existing_file_name", async () => {
  const cwd = await project({
    "agents/builder.md": CODER_TEXT,
  });

  await rejectedWith(
    createAgent(cwd, { agent: { ...CODER, id: "builder" }, body: "Other" }),
    IpcErrorCode.VALIDATION,
    "An agent file named builder.md already exists",
  );

  expect(await text(cwd, "agents/builder.md")).toBe(CODER_TEXT);
  expect(await agentFiles(cwd)).toEqual(["builder.md"]);
});

it("create_makes_missing_agents_dir", async () => {
  const cwd = await project({ "README.md": "hello" });

  const result = await createAgent(cwd, { agent: CODER, body: "Prompt" });

  expect(await text(cwd, CODER_FILE)).toBe(`---
id: coder
role: Writes code
provider: claude
permissionProfile: plan
---

Prompt
`);
  expect(result.agents.map((agent) => agent.id)).toEqual(["coder"]);
});

it("save_updates_fields_and_body_preserving_unknown_keys_comments_and_other_blocks", async () => {
  const cwd = await project({ [TEAM_FILE]: TEAM_TEXT });
  const { revision } = await agentOf(cwd, "builder");

  const result = await saveAgent(cwd, {
    file: TEAM_FILE,
    revision,
    id: "builder",
    agent: {
      id: "builder",
      role: "Builds and tests",
      provider: "codex",
      permissionProfile: "accept-edits",
      taskClass: "standard",
    },
    body: "\nBuild and test it.\nTwice.\n\n",
  });

  expect(await text(cwd, TEAM_FILE)).toBe(`${PLANNER_BLOCK}---
id: builder
# keep this comment
role: Builds and tests
provider: codex
permissionProfile: accept-edits
owner: team-a
taskClass: standard
---

Build and test it.
Twice.

${CHECKER_BLOCK}`);
  expect(result.errors).toEqual([]);
  expect(result.agents.find((agent) => agent.id === "builder")).toMatchObject({
    role: "Builds and tests",
    model: null,
    taskClass: "standard",
    body: "Build and test it.\nTwice.",
  });
});

it("save_keeps_crlf", async () => {
  const crlf = CODER_TEXT.replace(
    "role: Writes code",
    "# note\nrole: Writes code",
  ).replaceAll("\n", "\r\n");
  const cwd = await project({ [CODER_FILE]: crlf });
  const { revision } = await agentOf(cwd, "coder");

  await saveAgent(cwd, {
    file: CODER_FILE,
    revision,
    id: "coder",
    agent: { ...CODER, role: "Writes better code" },
    body: "First line.\nSecond line.\n",
  });

  const saved = await text(cwd, CODER_FILE);
  expect(saved.replaceAll("\r\n", "")).not.toContain("\n");
  expect(saved).toBe(
    `---
id: coder
# note
role: Writes better code
provider: claude
permissionProfile: plan
---

First line.
Second line.
`.replaceAll("\n", "\r\n"),
  );
});

it("save_with_stale_revision_conflicts_and_leaves_file_untouched", async () => {
  const cwd = await project({ [CODER_FILE]: CODER_TEXT });
  const { revision } = await agentOf(cwd, "coder");
  const edited = CODER_TEXT.replace("Prompt", "Edited elsewhere");
  await writeFile(join(cwd, CODER_FILE), edited);

  await rejectedWith(
    saveAgent(cwd, {
      file: CODER_FILE,
      revision,
      id: "coder",
      agent: { ...CODER, role: "Mine" },
      body: "Mine",
    }),
    IpcErrorCode.CONFLICT,
    "The agent file changed on disk",
  );

  expect(await text(cwd, CODER_FILE)).toBe(edited);
});

it("rename_sole_agent_renames_file", async () => {
  const cwd = await project({ [CODER_FILE]: CODER_TEXT });
  const { revision } = await agentOf(cwd, "coder");

  const result = await saveAgent(cwd, {
    file: CODER_FILE,
    revision,
    id: "coder",
    agent: { ...CODER, id: "builder" },
    body: "Prompt",
  });

  expect(await agentFiles(cwd)).toEqual(["builder.md"]);
  expect(await text(cwd, "agents/builder.md")).toBe(
    CODER_TEXT.replace("id: coder", "id: builder"),
  );
  expect(result.agents).toHaveLength(1);
  expect(result.agents[0]).toMatchObject({
    id: "builder",
    file: "agents/builder.md",
  });
});

it("rename_in_multi_agent_file_keeps_file", async () => {
  const cwd = await project({ [TEAM_FILE]: TEAM_TEXT });
  const { revision } = await agentOf(cwd, "checker");

  await saveAgent(cwd, {
    file: TEAM_FILE,
    revision,
    id: "checker",
    agent: {
      id: "verifier",
      role: "Checks things",
      provider: "codex",
      permissionProfile: "ask",
    },
    body: "Check it.",
  });

  expect(await agentFiles(cwd)).toEqual(["team.md"]);
  expect(await text(cwd, TEAM_FILE)).toBe(
    TEAM_TEXT.replace("id: checker", "id: verifier"),
  );
});

it("rename_case_only_keeps_file", async () => {
  const cwd = await project({ [CODER_FILE]: CODER_TEXT });
  const { revision } = await agentOf(cwd, "coder");

  const result = await saveAgent(cwd, {
    file: CODER_FILE,
    revision,
    id: "coder",
    agent: { ...CODER, id: "Coder" },
    body: "Prompt",
  });

  expect(await agentFiles(cwd)).toEqual(["coder.md"]);
  expect(await text(cwd, CODER_FILE)).toBe(
    CODER_TEXT.replace("id: coder", "id: Coder"),
  );
  expect(result.agents[0]).toMatchObject({ id: "Coder", file: CODER_FILE });
});

it("rename_referenced_agent_is_blocked", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    [FLOW_FILE]: SHIP_FLOW,
  });
  const { revision } = await agentOf(cwd, "coder");

  await rejectedWith(
    saveAgent(cwd, {
      file: CODER_FILE,
      revision,
      id: "coder",
      agent: { ...CODER, id: "builder" },
      body: "Prompt",
    }),
    IpcErrorCode.VALIDATION,
    'Agent "coder" is used by Ship it (flows/ship.md); remove it from those flows first',
  );

  expect(await text(cwd, CODER_FILE)).toBe(CODER_TEXT);

  const result = await saveAgent(cwd, {
    file: CODER_FILE,
    revision,
    id: "coder",
    agent: { ...CODER, role: "Still allowed" },
    body: "Prompt",
  });
  expect(result.agents[0]).toMatchObject({ role: "Still allowed" });
});

it("delete_last_block_removes_file", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    "agents/reviewer.md": REVIEWER_TEXT,
  });
  const { revision } = await agentOf(cwd, "coder");

  const result = await deleteAgent(cwd, {
    file: CODER_FILE,
    revision,
    id: "coder",
  });

  expect(await agentFiles(cwd)).toEqual(["reviewer.md"]);
  expect(result.agents.map((agent) => agent.id)).toEqual(["reviewer"]);
});

it("delete_one_of_many_keeps_others", async () => {
  const cwd = await project({ [TEAM_FILE]: TEAM_TEXT });
  const { revision } = await agentOf(cwd, "builder");

  const result = await deleteAgent(cwd, {
    file: TEAM_FILE,
    revision,
    id: "builder",
  });

  expect(await text(cwd, TEAM_FILE)).toBe(`${PLANNER_BLOCK}${CHECKER_BLOCK}`);
  expect(result.agents.map((agent) => agent.id)).toEqual([
    "planner",
    "checker",
  ]);
});

it("delete_referenced_agent_is_blocked_with_flow_names", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    [FLOW_FILE]: SHIP_FLOW,
    "flows/broken.md": BROKEN_FLOW,
  });
  const { revision } = await agentOf(cwd, "coder");

  await rejectedWith(
    deleteAgent(cwd, { file: CODER_FILE, revision, id: "coder" }),
    IpcErrorCode.VALIDATION,
    'Agent "coder" is used by Broken flow (flows/broken.md), Ship it (flows/ship.md); remove it from those flows first',
  );

  expect(await text(cwd, CODER_FILE)).toBe(CODER_TEXT);
});

it("rejects_paths_outside_agents_dir", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    "x.md": CODER_TEXT,
  });
  const { revision } = await agentOf(cwd, "coder");
  const cases = [
    "../x.md",
    "agents/../x.md",
    join(cwd, CODER_FILE),
    "agents/sub/x.md",
    "agents/coder.txt",
    "agents/..\\x.md",
    "flows/ship.md",
  ];

  for (const file of cases) {
    await rejectedWith(
      saveAgent(cwd, {
        file,
        revision,
        id: "coder",
        agent: { ...CODER, role: "Hacked" },
        body: "Prompt",
      }),
      IpcErrorCode.VALIDATION,
    );
    await rejectedWith(
      deleteAgent(cwd, { file, revision, id: "coder" }),
      IpcErrorCode.VALIDATION,
    );
  }

  expect(await text(cwd, CODER_FILE)).toBe(CODER_TEXT);
  expect(await text(cwd, "x.md")).toBe(CODER_TEXT);
});

it.skipIf(process.platform === "win32")(
  "rejects_symlinked_agent_file_escaping_agents_dir",
  async () => {
    const cwd = await project({ [CODER_FILE]: CODER_TEXT });
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.md"), CODER_TEXT);
    await symlink(join(outside, "secret.md"), join(cwd, "agents", "link.md"));
    const { revision } = await agentOf(cwd, "coder");

    await rejectedWith(
      saveAgent(cwd, {
        file: "agents/link.md",
        revision,
        id: "coder",
        agent: { ...CODER, role: "Hacked" },
        body: "Prompt",
      }),
      IpcErrorCode.VALIDATION,
    );
    await rejectedWith(
      deleteAgent(cwd, { file: "agents/link.md", revision, id: "coder" }),
      IpcErrorCode.VALIDATION,
    );

    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe(CODER_TEXT);
    expect((await stat(join(cwd, "agents", "link.md"))).isFile()).toBe(true);
  },
);

async function aliasedCoderProject(): Promise<string> {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    [FLOW_FILE]: SHIP_FLOW,
  });
  await symlink("coder.md", join(cwd, "agents", "alias.md"));
  return cwd;
}

async function expectCoderIntact(cwd: string): Promise<void> {
  expect(await text(cwd, CODER_FILE)).toBe(CODER_TEXT);
  const list = await listed(cwd);
  expect(list.errors).toEqual([]);
  expect(list.flows.map(({ id }) => id)).toEqual(["ship"]);
}

it.skipIf(process.platform === "win32")(
  "delete_via_symlink_alias_of_referenced_agent_is_refused",
  async () => {
    const cwd = await aliasedCoderProject();
    const { revision } = await agentOf(cwd, "coder");

    await rejectedWith(
      deleteAgent(cwd, { file: "agents/alias.md", revision, id: "coder" }),
      IpcErrorCode.NOT_FOUND,
      'Agent "coder" not found in agents/alias.md',
    );

    await expectCoderIntact(cwd);
  },
);

it.skipIf(process.platform === "win32")(
  "rename_via_symlink_alias_of_referenced_agent_is_refused",
  async () => {
    const cwd = await aliasedCoderProject();
    const { revision } = await agentOf(cwd, "coder");

    await rejectedWith(
      saveAgent(cwd, {
        file: "agents/alias.md",
        revision,
        id: "coder",
        agent: { ...CODER, id: "writer" },
        body: "Prompt",
      }),
      IpcErrorCode.NOT_FOUND,
      'Agent "coder" not found in agents/alias.md',
    );

    await expectCoderIntact(cwd);
    expect(await agentFiles(cwd)).toEqual(["alias.md", "coder.md"]);
  },
);

it("save_with_unlisted_file_name_is_refused", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    [FLOW_FILE]: SHIP_FLOW,
  });
  const { revision } = await agentOf(cwd, "coder");

  await rejectedWith(
    saveAgent(cwd, {
      file: "agents/Coder.md",
      revision,
      id: "coder",
      agent: { ...CODER, id: "writer" },
      body: "Prompt",
    }),
    IpcErrorCode.NOT_FOUND,
    "agents/Coder.md",
  );

  await expectCoderIntact(cwd);
  expect(await agentFiles(cwd)).toEqual(["coder.md"]);
});

it("body_with_fence_line_is_rejected", async () => {
  const cwd = await project({ [CODER_FILE]: CODER_TEXT });
  const { revision } = await agentOf(cwd, "coder");
  const body = "Intro\n---\nrole: sneaky\n";

  await rejectedWith(
    createAgent(cwd, { agent: { ...CODER, id: "other" }, body }),
    IpcErrorCode.VALIDATION,
  );
  await rejectedWith(
    saveAgent(cwd, {
      file: CODER_FILE,
      revision,
      id: "coder",
      agent: CODER,
      body,
    }),
    IpcErrorCode.VALIDATION,
  );

  expect(await agentFiles(cwd)).toEqual(["coder.md"]);
  expect(await text(cwd, CODER_FILE)).toBe(CODER_TEXT);
});

it("concurrent_saves_to_one_file_second_conflicts", async () => {
  const cwd = await project({ [TEAM_FILE]: TEAM_TEXT });
  const { revision } = await agentOf(cwd, "builder");
  const attempt = (role: string): Promise<FlowsList> =>
    saveAgent(cwd, {
      file: TEAM_FILE,
      revision,
      id: "builder",
      agent: {
        id: "builder",
        role,
        provider: "claude",
        permissionProfile: "plan",
      },
      body: "Build it.",
    });

  const outcomes = await Promise.allSettled([
    attempt("First role"),
    attempt("Second role"),
  ]);

  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: IpcErrorCode.CONFLICT });
  const saved = await text(cwd, TEAM_FILE);
  const winner = outcomes[0].status === "fulfilled" ? "First" : "Second";
  expect(saved).toContain(`role: ${winner} role`);
  expect(saved).not.toContain(
    `role: ${winner === "First" ? "Second" : "First"} role`,
  );
});

it("delete_waits_for_flow_save_lock", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT,
    "agents/reviewer.md": REVIEWER_TEXT,
    [FLOW_FILE]: SHIP_FLOW,
  });
  const flowRevision = (await listed(cwd)).flows[0]?.revision ?? "missing";
  const { revision } = await agentOf(cwd, "reviewer");
  const handlers = handlersFor(cwd);

  const outcomes = await Promise.allSettled([
    handlers["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision: flowRevision,
      flow: SHIP_WITH_REVIEWER,
    }),
    deleteAgent(cwd, { file: "agents/reviewer.md", revision, id: "reviewer" }),
  ]);

  expect(
    outcomes.filter((outcome) => outcome.status === "rejected"),
  ).toHaveLength(1);
  const after = await listed(cwd);
  expect(after.errors).toEqual([]);
  expect(after.flows).toHaveLength(1);
});

const RUNNING_VIEW: SessionView = {
  id: "session-1",
  cwd: "/work",
  explicitFolder: true,
  provider: "claude",
  profile: "unattended",
  phase: { phase: "running", accountId: "acc-a" },
  activeAccountId: "acc-a",
  activeProvider: "claude",
  messages: [],
  toolCalls: [],
  permissions: [],
  limits: [],
  lastTurn: null,
  turnInFlight: true,
  flowRef: { flowId: "solo", nodeId: "build" },
  currentModel: null,
  contextUsage: null,
  turns: [],
  orchestrate: false,
};

function flowRunRig(): {
  runs: ReturnType<typeof createFlowRunService>;
  prompt: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
} {
  const listeners = new Set<(view: SessionView | null) => void>();
  const prompt = vi.fn<(text: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const sessions = fakeSessions({
    start: () => Promise.resolve(RUNNING_VIEW),
    prompt,
    view: () => RUNNING_VIEW,
    stop: () => {
      listeners.forEach((listener) => {
        listener({ ...RUNNING_VIEW, phase: { phase: "stopped" } });
      });
      return Promise.resolve();
    },
    onViewChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const runs = createFlowRunService({
    sessions: () => sessions,
    releaseSessions: () => Promise.resolve(),
    mainSessionLive: () => false,
    listFlows: (cwd = "") => listFlows(projectRoots(cwd)),
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    broadcast: () => undefined,
    newRunId: () => "run-1",
  });
  return { runs, prompt };
}

it("flow_start_after_agent_save_uses_new_body", async () => {
  const cwd = await project({
    [CODER_FILE]: CODER_TEXT.replace("Prompt", "Old instructions."),
    "flows/solo.md": `---
id: solo
title: Solo
nodes:
  - id: build
    agent: coder
edges: []
---
`,
  });
  const { runs, prompt } = flowRunRig();
  const startParams = { cwd, flowId: "solo", task: "Do it" };

  await runs.start(startParams);
  await vi.waitFor(() => {
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  await runs.stopAll();
  const { revision } = await agentOf(cwd, "coder");
  await saveAgent(cwd, {
    file: CODER_FILE,
    revision,
    id: "coder",
    agent: CODER,
    body: "New instructions.",
  });
  await runs.start(startParams);
  await vi.waitFor(() => {
    expect(prompt).toHaveBeenCalledTimes(2);
  });
  await runs.stopAll();

  expect(prompt.mock.calls[0]?.[0]).toContain("Old instructions.");
  expect(prompt.mock.calls[1]?.[0]).toContain("New instructions.");
  expect(prompt.mock.calls[1]?.[0]).not.toContain("Old instructions.");
});
