import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { listFlows } from "../../src/backend/flows";
import { createHandlers } from "../../src/backend/handlers";
import { createJsonStore } from "../../src/backend/storage";
import { fakeProbes, fakeSessions } from "../fakes/fakeSessions";
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

const FLOWS_DIR = "flows";
const CHMOD_DENIES = process.platform !== "win32" && process.getuid?.() !== 0;

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

  const result = await listFlows(cwd);

  expect(result).toEqual({
    flows: [
      {
        id: "ship",
        title: "Ship it",
        nodes: [{ id: "build", agent: "coder" }],
        edges: [],
      },
    ],
    agents: [
      {
        id: "coder",
        role: "Writes code",
        provider: "claude",
        permissionProfile: "plan",
      },
    ],
    errors: [
      {
        file: "flows/b-broken.md",
        messages: [
          'Edge "build" -> "nowhere" references unknown node "nowhere"',
        ],
      },
    ],
  });
});

it("flows_list_without_dirs_returns_empty", async () => {
  const cwd = await makeTempDir();

  expect(await listFlows(cwd)).toEqual({ flows: [], agents: [], errors: [] });
});

it("flows_list_without_flows_dir_returns_agents_only", async () => {
  const cwd = await project({ "agents/coder.md": CODER_AGENT });

  const result = await listFlows(cwd);

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

  const result = await listFlows(cwd);

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

  const result = await listFlows(cwd);

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

  const result = await listFlows(cwd);

  expect(result.agents.map((agent) => agent.id)).toEqual(["coder", "tester"]);
  expect(result.errors).toEqual([
    { file: "agents/c.md", messages: ["Missing YAML frontmatter"] },
  ]);
});

it("flows_list_rejects_flow_using_unknown_agent", async () => {
  const cwd = await project({ "flows/ship.md": VALID_FLOW });

  const result = await listFlows(cwd);

  expect(result.flows).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "flows/ship.md",
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
    const result = await listFlows(cwd);

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
    const result = await listFlows(cwd);

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
    userData: cwd,
    broadcast: vi.fn(),
    sessions: fakeSessions(),
    probes: fakeProbes(),
    containerStatus: { available: true, message: null },
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

  const result = await listFlows(cwd);

  expect(result.flows.map((flow) => flow.title)).toEqual(["Ship it"]);
  expect(result.errors).toEqual([
    {
      file: "flows/b.md",
      messages: ['Duplicate flow id "ship" (already defined in flows/a.md)'],
    },
  ]);
});
