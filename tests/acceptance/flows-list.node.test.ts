import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { listFlows } from "../../src/backend/flows";
import { projectRoots } from "../fakes/definitionRoots";
import { createHandlers } from "../../src/backend/handlers";
import { createJsonStore } from "../../src/backend/storage";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionHistory,
  fakeSessionPool,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeAttachmentStore } from "../fakes/fakeAttachmentStore";
import { fakeCheckpointStore } from "../fakes/fakeCheckpointStore";
import { fakeFileCompletion } from "../fakes/fakeFileCompletion";
import { fakeSlashCommands } from "../fakes/fakeSlashCommands";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const VALID_FLOW = `---
id: ship
title: Ship it
nodes:
  - id: build
    agent: coder
edges: []
---

Body
`;

const BROKEN_FLOW = `---
id: broken
title: Broken
nodes:
  - id: build
    agent: coder
edges:
  - from: build
    to: nowhere
    kind: reviews
---
`;

const NO_FRONTMATTER_FLOW = "just text\n";

const CODER_AGENT = `---
id: coder
role: Writes code
provider: claude
permissionProfile: plan
---

Prompt
`;

const CONFIGURED_FLOW = `---
id: tuned
title: Tuned
maxRounds: 5
nodes:
  - id: build
    agent: coder
    provider: codex
  - id: check
    agent: coder
edges:
  - from: build
    to: check
    kind: hands_off_to
  - from: check
    to: build
    kind: reviews
    gate: true
---
`;

const FLOWS_DIR = "flows";
const CHMOD_DENIES = process.platform !== "win32" && process.getuid?.() !== 0;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function project(files: Record<string, string>): Promise<string> {
  const cwd = await makeTempDir();
  for (const [relative, content] of Object.entries(files)) {
    const file = join(cwd, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  return cwd;
}

it("flows_list_reports_broken_file_beside_valid_flow", async () => {
  const cwd = await project({
    "flows/a-ship.md": VALID_FLOW,
    "flows/b-broken.md": BROKEN_FLOW,
    "agents/coder.md": CODER_AGENT,
  });

  const result = await listFlows(projectRoots(cwd));

  expect(result).toEqual({
    flows: [
      {
        id: "ship",
        file: "flows/a-ship.md",
        source: "project",
        revision: sha256(VALID_FLOW),
        title: "Ship it",
        maxRounds: 2,
        nodes: [
          { id: "build", agent: "coder", provider: null, taskClass: null },
        ],
        edges: [],
      },
    ],
    agents: [
      {
        id: "coder",
        file: "agents/coder.md",
        source: "project",
        revision: sha256(CODER_AGENT),
        role: "Writes code",
        provider: "claude",
        model: null,
        permissionProfile: "plan",
        taskClass: null,
        body: "Prompt",
        usedBy: [
          { file: "flows/a-ship.md", source: "project", title: "Ship it" },
          { file: "flows/b-broken.md", source: "project", title: "Broken" },
        ],
      },
    ],
    errors: [
      {
        file: "flows/b-broken.md",
        source: "project",
        messages: [
          'Edge "build" -> "nowhere" references unknown node "nowhere"',
        ],
      },
    ],
    locations: projectRoots(cwd),
  });
});

it("flows_list_reports_file_revision_and_agent_body", async () => {
  const cwd = await project({
    "flows/ship.md": VALID_FLOW,
    "agents/coder.md": `${CODER_AGENT}---
id: tester
role: Tests code
provider: codex
permissionProfile: ask
---

Tester prose
with two lines
`,
  });

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows[0]?.file).toBe("flows/ship.md");
  expect(result.flows[0]?.revision).toBe(sha256(VALID_FLOW));
  expect(result.agents.map((agent) => agent.body)).toEqual([
    "Prompt",
    "Tester prose\nwith two lines",
  ]);
});

it("flows_list_defaults_provider_gate_and_rounds", async () => {
  const cwd = await project({
    "flows/tuned.md": CONFIGURED_FLOW,
    "flows/ship.md": VALID_FLOW,
    "agents/coder.md": CODER_AGENT,
  });

  const result = await listFlows(projectRoots(cwd));

  const defaults = result.flows.find((flow) => flow.id === "ship");
  const tuned = result.flows.find((flow) => flow.id === "tuned");
  expect(defaults?.maxRounds).toBe(2);
  expect(defaults?.nodes[0]?.provider).toBeNull();
  expect(tuned?.maxRounds).toBe(5);
  expect(tuned?.nodes.map((node) => node.provider)).toEqual(["codex", null]);
  expect(tuned?.edges.map((edge) => edge.gate)).toEqual([false, true]);
});

it("flow view exposes node task class", async () => {
  const cwd = await project({
    "flows/tuned.md": CONFIGURED_FLOW.replace(
      "    provider: codex\n",
      "    provider: codex\n    taskClass: heavy\n",
    ),
    "agents/coder.md": CODER_AGENT,
  });

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows[0]?.nodes.map((node) => node.taskClass)).toEqual([
    "heavy",
    null,
  ]);
});

it("flows_list_without_dirs_returns_empty", async () => {
  const cwd = await makeTempDir();

  expect(await listFlows(projectRoots(cwd))).toEqual({
    flows: [],
    agents: [],
    errors: [],
    locations: projectRoots(cwd),
  });
});

it("flows_list_without_flows_dir_returns_agents_only", async () => {
  const cwd = await project({ "agents/coder.md": CODER_AGENT });

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.agents.map((agent) => agent.id)).toEqual(["coder"]);
});

it("flows_list_sorts_files_by_name", async () => {
  const cwd = await project({
    "flows/z.md": VALID_FLOW.replace("id: ship", "id: zed"),
    "flows/a.md": VALID_FLOW,
    "flows/m.md": NO_FRONTMATTER_FLOW,
    "flows/k.md": NO_FRONTMATTER_FLOW,
    "agents/coder.md": CODER_AGENT,
  });

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows.map((flow) => flow.id)).toEqual(["ship", "zed"]);
  expect(result.errors.map((error) => error.file)).toEqual([
    "flows/k.md",
    "flows/m.md",
  ]);
  expect(result.errors[0]?.messages).toEqual(["Missing YAML frontmatter"]);
});

it("flows_list_ignores_non_markdown_entries", async () => {
  const cwd = await project({
    "flows/notes.txt": "x",
    "flows/ship.md": VALID_FLOW,
    "agents/coder.md": CODER_AGENT,
  });
  await mkdir(join(cwd, FLOWS_DIR, "nested.md"));

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows.map((flow) => flow.id)).toEqual(["ship"]);
  expect(result.errors).toEqual([]);
});

it("flows_list_merges_agents_from_all_files", async () => {
  const cwd = await project({
    "agents/a.md": CODER_AGENT,
    "agents/b.md": CODER_AGENT.replace("id: coder", "id: tester"),
    "agents/c.md": "no frontmatter",
    "flows/ship.md": VALID_FLOW,
  });

  const result = await listFlows(projectRoots(cwd));

  expect(result.agents.map((agent) => agent.id)).toEqual(["coder", "tester"]);
  expect(result.errors).toEqual([
    {
      file: "agents/c.md",
      source: "project",
      messages: ["Missing YAML frontmatter"],
    },
  ]);
});

it("flows_list_rejects_flow_using_unknown_agent", async () => {
  const cwd = await project({ "flows/ship.md": VALID_FLOW });

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "flows/ship.md",
      source: "project",
      messages: ['Node "build" uses unknown agent "coder"'],
    },
  ]);
});

it.runIf(CHMOD_DENIES)("flows_list_unreadable_dir_reports_error", async () => {
  const cwd = await project({
    "flows/ship.md": VALID_FLOW,
    "agents/coder.md": CODER_AGENT,
  });
  await chmod(join(cwd, FLOWS_DIR), 0o000);

  try {
    const result = await listFlows(projectRoots(cwd));

    expect(result.flows).toEqual([]);
    expect(result.agents.map((agent) => agent.id)).toEqual(["coder"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe(FLOWS_DIR);
    expect(result.errors[0]?.messages[0]).toContain("EACCES");
  } finally {
    await chmod(join(cwd, FLOWS_DIR), 0o755);
  }
});

it.runIf(CHMOD_DENIES)("flows_list_unreadable_file_reports_error", async () => {
  const cwd = await project({
    "flows/ship.md": VALID_FLOW,
    "flows/locked.md": VALID_FLOW,
    "agents/coder.md": CODER_AGENT,
  });
  const locked = join(cwd, FLOWS_DIR, "locked.md");
  await chmod(locked, 0o000);

  try {
    const result = await listFlows(projectRoots(cwd));

    expect(result.flows.map((flow) => flow.id)).toEqual(["ship"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe("flows/locked.md");
    expect(result.errors[0]?.messages[0]).toContain("EACCES");
  } finally {
    await chmod(locked, 0o644);
  }
});

it("flows_list_handler_delegates_to_listFlows", async () => {
  const cwd = await project({
    "flows/ship.md": VALID_FLOW,
    "agents/coder.md": CODER_AGENT,
  });
  const handlers = createHandlers({
    store: createJsonStore(cwd),
    ...fakeSecrets(cwd),
    userData: cwd,
    homeDir: tmpdir(),
    broadcast: vi.fn(),
    sessions: fakeSessionPool(),
    history: fakeSessionHistory(),
    checkpoints: fakeCheckpointStore(),
    attachments: fakeAttachmentStore(),
    files: fakeFileCompletion(),
    commands: fakeSlashCommands(),
    inspectWorktree: (cwd) => Promise.resolve({ isRepo: false, cwd }),
    flowRuns: fakeFlowRuns(),
    orchestrator: fakeOrchestrator(),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals: fakeTerminals(),
    postUpdaterConfig: () => undefined,
    editedFiles: {
      observeMain: () => undefined,
      observeRun: () => undefined,
      forget: () => undefined,
      views: () => [],
    },
  });

  const result = await handlers["flows/list"]({ cwd });

  expect(result.flows.map((flow) => flow.id)).toEqual(["ship"]);
});

it("flows_list_reports_duplicate_flow_id", async () => {
  const cwd = await project({
    "flows/a.md": VALID_FLOW,
    "flows/b.md": VALID_FLOW.replace("Ship it", "Ship it again"),
    "agents/coder.md": CODER_AGENT,
  });

  const result = await listFlows(projectRoots(cwd));

  expect(result.flows.map((flow) => flow.title)).toEqual(["Ship it"]);
  expect(result.errors).toEqual([
    {
      file: "flows/b.md",
      source: "project",
      messages: ['Duplicate flow id "ship" (already defined in flows/a.md)'],
    },
  ]);
});
