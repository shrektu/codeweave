import { tmpdir } from "node:os";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createHandlers } from "../../src/backend/handlers";
import { createJsonStore } from "../../src/backend/storage";
import type { FlowDefinition } from "../../src/domain/flows";
import type { FlowsList } from "../../src/shared/views";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionHistory,
  fakeSessionPool,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const FLOW_FILE = "flows/ship.md";
const FLOW_BODY = "\n# Ship\n\nSome prose\n---\nnot front matter\n";

const FLOW_TEXT = `---
id: ship
# keep this comment
title: Ship it
owner: team-a
nodes:
  - id: build
    agent: coder
edges: []
---
${FLOW_BODY}`;

const CODER_AGENT = `---
id: coder
role: Writes code
provider: claude
permissionProfile: plan
---

Prompt
`;

const REVIEWER_AGENT = `---
id: reviewer
role: Reviews code
provider: codex
permissionProfile: plan
---

Prompt
`;

const EDITED_FLOW: FlowDefinition = {
  id: "ship",
  title: "Ship it twice",
  maxRounds: 3,
  nodes: [
    { id: "build", agent: "coder", provider: "codex" },
    { id: "check", agent: "reviewer" },
  ],
  edges: [
    { from: "build", to: "check", kind: "hands_off_to" },
    { from: "check", to: "build", kind: "reviews", gate: true },
  ],
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

async function standardProject(): Promise<string> {
  return project({
    [FLOW_FILE]: FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
    "agents/reviewer.md": REVIEWER_AGENT,
  });
}

function handlersFor(cwd: string): ReturnType<typeof createHandlers> {
  return createHandlers({
    store: createJsonStore(cwd),
    ...fakeSecrets(cwd),
    userData: cwd,
    homeDir: tmpdir(),
    broadcast: vi.fn(),
    sessions: fakeSessionPool(),
    history: fakeSessionHistory(),
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
}

async function listed(cwd: string): Promise<FlowsList> {
  return handlersFor(cwd)["flows/list"]({ cwd });
}

async function currentRevision(cwd: string): Promise<string> {
  const list = await listed(cwd);
  const flow = list.flows.find((candidate) => candidate.id === "ship");
  return flow?.revision ?? "missing";
}

it("flows_save_rewrites_front_matter_and_keeps_body", async () => {
  const cwd = await standardProject();
  const revision = await currentRevision(cwd);

  const result = await handlersFor(cwd)["flows/save"]({
    cwd,
    source: "project",
    file: FLOW_FILE,
    revision,
    flow: EDITED_FLOW,
  });

  const text = await readFile(join(cwd, FLOW_FILE), "utf8");
  expect(text.endsWith(`---\n${FLOW_BODY}`)).toBe(true);
  expect(text).toContain("# keep this comment");
  expect(text).toContain("owner: team-a");
  expect(text).toContain("title: Ship it twice");
  expect(result.errors).toEqual([]);
  expect(result.flows).toHaveLength(1);
  expect(result.flows[0]).toMatchObject({
    id: "ship",
    file: FLOW_FILE,
    title: "Ship it twice",
    maxRounds: 3,
    nodes: [
      { id: "build", agent: "coder", provider: "codex" },
      { id: "check", agent: "reviewer", provider: null },
    ],
    edges: [
      { from: "build", to: "check", kind: "hands_off_to", gate: false },
      { from: "check", to: "build", kind: "reviews", gate: true },
    ],
  });
  expect(result.flows[0]?.revision).not.toBe(revision);
  expect(await readdir(join(cwd, "flows"))).toEqual(["ship.md"]);
});

it.each(["flows/my flow.md", "flows/café.md", "flows/日本語 flow.md"])(
  "flows_save_accepts_spaces_and_unicode_names_%s",
  async (file) => {
    const cwd = await project({
      [file]: FLOW_TEXT,
      "agents/coder.md": CODER_AGENT,
      "agents/reviewer.md": REVIEWER_AGENT,
    });
    const revision = await currentRevision(cwd);

    const result = await handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file,
      revision,
      flow: EDITED_FLOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.flows[0]).toMatchObject({ file, title: "Ship it twice" });
    expect(await readFile(join(cwd, file), "utf8")).toContain(
      "title: Ship it twice",
    );
  },
);

it.each(["flows/..draft.md", "flows/..md"])(
  "flows_save_accepts_names_starting_with_dots_%s",
  async (file) => {
    const cwd = await project({
      [file]: FLOW_TEXT,
      "agents/coder.md": CODER_AGENT,
      "agents/reviewer.md": REVIEWER_AGENT,
    });
    const revision = await currentRevision(cwd);

    const result = await handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file,
      revision,
      flow: EDITED_FLOW,
    });

    expect(result.errors).toEqual([]);
    expect(await readFile(join(cwd, file), "utf8")).toContain(
      "title: Ship it twice",
    );
  },
);

it("flows_save_rejects_stale_revision", async () => {
  const cwd = await standardProject();
  const revision = await currentRevision(cwd);
  const edited = FLOW_TEXT.replace("Ship it", "Changed elsewhere");
  await writeFile(join(cwd, FLOW_FILE), edited);

  await expect(
    handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: EDITED_FLOW,
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    message: "The flow file changed on disk",
  });

  expect(await readFile(join(cwd, FLOW_FILE), "utf8")).toBe(edited);
  expect(await readdir(join(cwd, "flows"))).toEqual(["ship.md"]);
});

it("flows_save_rejects_path_outside_flows_dir", async () => {
  const cwd = await standardProject();
  const outside = await makeTempDir();
  await writeFile(join(outside, "secret.md"), FLOW_TEXT);
  await symlink(join(outside, "secret.md"), join(cwd, "flows", "link.md"));
  const revision = await currentRevision(cwd);
  const cases = [
    "../x.md",
    "flows/../agents/coder.md",
    join(cwd, FLOW_FILE),
    "flows/ship.txt",
    "flows/link.md",
    "flows/sub dir/x.md",
    "flows/..\\x.md",
    "flows/.md/..",
    "flows/ship.md\0",
    "flows/a\0b.md",
    "flows/",
    "flows/..",
  ];

  for (const file of cases) {
    await expect(
      handlersFor(cwd)["flows/save"]({
        cwd,
        source: "project",
        file,
        revision,
        flow: EDITED_FLOW,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  }

  expect(await readFile(join(cwd, FLOW_FILE), "utf8")).toBe(FLOW_TEXT);
  expect(await readFile(join(cwd, "agents/coder.md"), "utf8")).toBe(
    CODER_AGENT,
  );
  expect(await readFile(join(outside, "secret.md"), "utf8")).toBe(FLOW_TEXT);
});

it("flows_save_reports_missing_file_as_not_found", async () => {
  const cwd = await standardProject();

  await expect(
    handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: "flows/gone.md",
      revision: "abc",
      flow: EDITED_FLOW,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  expect(await readdir(join(cwd, "flows"))).toEqual(["ship.md"]);
});

it("flows_save_rejects_invalid_flow_and_id_change", async () => {
  const cwd = await standardProject();
  const revision = await currentRevision(cwd);
  const unknownAgent: FlowDefinition = {
    ...EDITED_FLOW,
    nodes: [{ id: "build", agent: "ghost" }],
    edges: [],
  };
  const renamed: FlowDefinition = { ...EDITED_FLOW, id: "other" };

  await expect(
    handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: unknownAgent,
    }),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    message: 'Node "build" uses unknown agent "ghost"',
  });
  await expect(
    handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: renamed,
    }),
  ).rejects.toMatchObject({ code: "VALIDATION" });

  expect(await readFile(join(cwd, FLOW_FILE), "utf8")).toBe(FLOW_TEXT);
  expect(await readdir(join(cwd, "flows"))).toEqual(["ship.md"]);
});

const ENTRY_FLOW_TEXT = `---
id: ship
title: Ship it
nodes:
  # builder node
  - id: build
    agent: coder
    label: Builder
  - id: check
    agent: reviewer
edges:
  - from: check
    to: build
    kind: reviews
    # note on the edge
    note: keep
---
Body
`;

it("flows_save_keeps_entry_comments_and_unknown_keys", async () => {
  const cwd = await project({
    [FLOW_FILE]: ENTRY_FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
    "agents/reviewer.md": REVIEWER_AGENT,
  });
  const revision = await currentRevision(cwd);

  await handlersFor(cwd)["flows/save"]({
    cwd,
    source: "project",
    file: FLOW_FILE,
    revision,
    flow: {
      id: "ship",
      title: "Ship it",
      nodes: [
        { id: "build", agent: "reviewer", provider: "codex" },
        { id: "check", agent: "reviewer" },
      ],
      edges: [{ from: "check", to: "build", kind: "reviews", gate: true }],
    },
  });

  const text = await readFile(join(cwd, FLOW_FILE), "utf8");
  expect(text).toContain("# builder node");
  expect(text).toContain("label: Builder");
  expect(text).toContain("# note on the edge");
  expect(text).toContain("note: keep");
  expect(text).toContain("agent: reviewer");
  expect(text).toContain("provider: codex");
  expect(text).toContain("gate: true");
  expect(text.endsWith("---\nBody\n")).toBe(true);
});

it("flows_save_concurrent_same_revision_one_conflicts", async () => {
  const cwd = await standardProject();
  const revision = await currentRevision(cwd);
  const handlers = handlersFor(cwd);
  const first: FlowDefinition = { ...EDITED_FLOW, title: "First writer" };
  const second: FlowDefinition = { ...EDITED_FLOW, title: "Second writer" };

  const outcomes = await Promise.allSettled([
    handlers["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: first,
    }),
    handlers["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: second,
    }),
  ]);

  const fulfilled = outcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: "CONFLICT" });
  const text = await readFile(join(cwd, FLOW_FILE), "utf8");
  const winner = fulfilled[0]?.value.flows[0]?.title;
  expect(["First writer", "Second writer"]).toContain(winner);
  expect(text).toContain(`title: ${winner ?? ""}`);
  expect(await readdir(join(cwd, "flows"))).toEqual(["ship.md"]);
});

const ANCHORED_FLOW_TEXT = `---
id: ship
title: Ship it
nodes:
  - id: build
    agent: coder
    meta: &m { color: red }
  - id: check
    agent: reviewer
    meta: *m
edges:
  - from: build
    to: check
    kind: hands_off_to
---
Body
`;

it("flows_save_removes_anchored_node_entry", async () => {
  const cwd = await project({
    [FLOW_FILE]: ANCHORED_FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
    "agents/reviewer.md": REVIEWER_AGENT,
  });
  const revision = await currentRevision(cwd);

  const result = await handlersFor(cwd)["flows/save"]({
    cwd,
    source: "project",
    file: FLOW_FILE,
    revision,
    flow: {
      id: "ship",
      title: "Ship it",
      nodes: [{ id: "check", agent: "reviewer" }],
      edges: [],
    },
  });

  const text = await readFile(join(cwd, FLOW_FILE), "utf8");
  expect(result.errors).toEqual([]);
  expect(result.flows[0]?.nodes).toEqual([
    { id: "check", agent: "reviewer", provider: null, taskClass: null },
  ]);
  expect(text).toContain("color: red");
  expect(text).not.toContain("*m");
  expect(text.endsWith("---\nBody\n")).toBe(true);
});

const RECURSIVE_FLOW_TEXT = `---
id: ship
title: Ship it
nodes:
  - id: build
    agent: coder
    meta: &m { self: *m }
  - id: check
    agent: reviewer
edges: []
---
Body
`;

it("flows_save_rejects_recursive_alias_with_validation_error", async () => {
  const cwd = await project({
    [FLOW_FILE]: RECURSIVE_FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
    "agents/reviewer.md": REVIEWER_AGENT,
  });
  const revision = await currentRevision(cwd);

  await expect(
    handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: {
        id: "ship",
        title: "Ship it",
        nodes: [
          { id: "build", agent: "coder" },
          { id: "check", agent: "coder" },
        ],
        edges: [],
      },
    }),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    message:
      "Recursive YAML aliases in the flow front matter are not supported",
  });

  expect(await readFile(join(cwd, FLOW_FILE), "utf8")).toBe(
    RECURSIVE_FLOW_TEXT,
  );
});

const ROUNDS_FLOW_TEXT = `---
id: ship
title: Ship it
maxRounds: &r 3
x-rounds: *r
nodes:
  - id: build
    agent: coder
edges: []
---
Body
`;

it("flows_save_keeps_alias_to_removed_max_rounds", async () => {
  const cwd = await project({
    [FLOW_FILE]: ROUNDS_FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
  });
  const revision = await currentRevision(cwd);

  const result = await handlersFor(cwd)["flows/save"]({
    cwd,
    source: "project",
    file: FLOW_FILE,
    revision,
    flow: {
      id: "ship",
      title: "Ship it",
      nodes: [{ id: "build", agent: "coder" }],
      edges: [],
    },
  });

  const text = await readFile(join(cwd, FLOW_FILE), "utf8");
  expect(result.errors).toEqual([]);
  expect(text).toContain("x-rounds: 3");
  expect(text).not.toContain("maxRounds");
  expect(text).not.toContain("*r");
});

const REUSED_FLOW_TEXT = `---
id: ship
title: Ship it
v: &z 1
nodes:
  - id: build
    agent: coder
    meta: &m { v: *z }
w: &z 2
y: *m
edges: []
---
Body
`;

it("flows_save_rejects_reused_anchor_names", async () => {
  const cwd = await project({
    [FLOW_FILE]: REUSED_FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
  });
  const revision = await currentRevision(cwd);

  await expect(
    handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: {
        id: "ship",
        title: "Ship it",
        nodes: [{ id: "build", agent: "coder" }],
        edges: [],
      },
    }),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    message:
      "Reused YAML anchor names in the flow front matter are not supported",
  });

  expect(await readFile(join(cwd, FLOW_FILE), "utf8")).toBe(REUSED_FLOW_TEXT);
});

const ANCHORED_KEY_FLOW_TEXT = `---
id: ship
title: Ship it
&k maxRounds: 3
x: *k
nodes:
  - id: build
    agent: coder
edges: []
---
Body
`;

it("flows_save_keeps_alias_to_anchored_max_rounds_key", async () => {
  const cwd = await project({
    [FLOW_FILE]: ANCHORED_KEY_FLOW_TEXT,
    "agents/coder.md": CODER_AGENT,
  });
  const revision = await currentRevision(cwd);

  const result = await handlersFor(cwd)["flows/save"]({
    cwd,
    source: "project",
    file: FLOW_FILE,
    revision,
    flow: {
      id: "ship",
      title: "Ship it",
      nodes: [{ id: "build", agent: "coder" }],
      edges: [],
    },
  });

  const text = await readFile(join(cwd, FLOW_FILE), "utf8");
  expect(result.errors).toEqual([]);
  expect(text).toContain("x: maxRounds");
  expect(text).not.toContain("*k");
  expect(text).not.toContain("&k");
});

it.skipIf(process.platform === "win32")(
  "flows_save_preserves_file_mode",
  async () => {
    const cwd = await standardProject();
    const target = join(cwd, FLOW_FILE);
    await chmod(target, 0o600);
    const revision = await currentRevision(cwd);

    await handlersFor(cwd)["flows/save"]({
      cwd,
      source: "project",
      file: FLOW_FILE,
      revision,
      flow: EDITED_FLOW,
    });

    expect((await stat(target)).mode & 0o777).toBe(0o600);
  },
);
