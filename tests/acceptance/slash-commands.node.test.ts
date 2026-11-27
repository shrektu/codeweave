import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createHandlers } from "../../src/backend/handlers";
import { protectedPaths } from "../../src/backend/protectedPaths";
import { createSlashCommandLibrary } from "../../src/backend/slashCommands";
import { createJsonStore } from "../../src/backend/storage";
import { fakeAttachmentStore } from "../fakes/fakeAttachmentStore";
import { fakeCheckpointStore } from "../fakes/fakeCheckpointStore";
import { fakeFileCompletion } from "../fakes/fakeFileCompletion";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionHistory,
  fakeSessionPool,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const REVIEW_PROMPT = `---
description: Review the diff
---

Review $ARGUMENTS
`;

const DEPLOY_SKILL = `---
name: deploy
description: Deploy it
---

Ship it
`;

const OVERSIZE_BYTES = 70 * 1024;
const PROTECTED_MARKER = "SECRET_PROTECTED_CONTENT";
const ESCAPE_MARKER = "SECRET_ESCAPE_CONTENT";
const OVERSIZE_MARKER = "SECRET_OVERSIZE_CONTENT";

async function writeTree(
  root: string,
  files: Record<string, string>,
): Promise<string> {
  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const file = join(root, relative);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    }),
  );
  return root;
}

async function rig(
  project: string | null,
  library: string,
  protectedList: readonly string[] = [],
): Promise<ReturnType<typeof createHandlers>> {
  const userData = await makeTempDir();
  return createHandlers({
    store: createJsonStore(userData),
    ...fakeSecrets(userData),
    userData,
    homeDir: tmpdir(),
    broadcast: vi.fn(),
    sessions: fakeSessionPool(),
    history: fakeSessionHistory(),
    checkpoints: fakeCheckpointStore(),
    attachments: fakeAttachmentStore(),
    files: fakeFileCompletion(),
    commands: createSlashCommandLibrary({
      definitionRoots: () => Promise.resolve({ project, library }),
      protectedPaths: () => Promise.resolve(protectedList),
    }),
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

it("commands_list_returns_the_project_prompt", async () => {
  const project = await writeTree(await makeTempDir(), {
    "prompts/review.md": REVIEW_PROMPT,
  });
  const handlers = await rig(project, await makeTempDir());

  const result = await handlers["commands/list"]({ cwd: project });

  expect(result).toEqual({
    commands: [
      {
        name: "review",
        description: "Review the diff",
        kind: "prompt",
        source: "project",
        file: "prompts/review.md",
        body: "Review $ARGUMENTS",
      },
    ],
    errors: [],
  });
});

it("commands_list_lists_a_library_skill", async () => {
  const library = await writeTree(await makeTempDir(), {
    "skills/deploy/SKILL.md": DEPLOY_SKILL,
  });
  const project = await makeTempDir();
  const handlers = await rig(project, library);

  const result = await handlers["commands/list"]({ cwd: project });

  expect(result.commands).toEqual([
    {
      name: "deploy",
      description: "Deploy it",
      kind: "skill",
      source: "library",
      file: "skills/deploy/SKILL.md",
      body: "Ship it",
    },
  ]);
  expect(result.errors).toEqual([]);
});

it("commands_list_project_prompt_shadows_the_library_one", async () => {
  const project = await writeTree(await makeTempDir(), {
    "prompts/review.md": REVIEW_PROMPT,
  });
  const library = await writeTree(await makeTempDir(), {
    "prompts/review.md": `---\ndescription: Library review\n---\n\nLibrary body\n`,
  });
  const handlers = await rig(project, library);

  const result = await handlers["commands/list"]({ cwd: project });

  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]?.source).toBe("project");
  expect(result.commands[0]?.description).toBe("Review the diff");
  expect(result.errors).toEqual([]);
});

it("commands_list_prompt_without_frontmatter_has_no_description", async () => {
  const project = await writeTree(await makeTempDir(), {
    "prompts/plain.md": "Just a prompt\n",
  });
  const handlers = await rig(project, await makeTempDir());

  const result = await handlers["commands/list"]({ cwd: project });

  expect(result.commands[0]?.description).toBe("");
  expect(result.commands[0]?.body).toBe("Just a prompt");
});

it("commands_list_rejects_unusable_files_without_returning_content", async () => {
  const outside = await makeTempDir();
  await writeFile(join(outside, "escape.md"), ESCAPE_MARKER);
  const project = await writeTree(await makeTempDir(), {
    "prompts/clear.md": "Built in name\n",
    "prompts/Review.md": "Bad name\n",
    "prompts/empty.md": "---\ndescription: Empty\n---\n   \n",
    "prompts/secret.md": PROTECTED_MARKER,
    "prompts/oversize.md": `${OVERSIZE_MARKER}${"x".repeat(OVERSIZE_BYTES)}`,
    "prompts/deploy.md": "Deploy prompt\n",
    "skills/deploy/SKILL.md": DEPLOY_SKILL,
  });
  await symlink(
    join(outside, "escape.md"),
    join(project, "prompts", "escape.md"),
  );
  const handlers = await rig(project, await makeTempDir(), [
    join(project, "prompts", "secret.md"),
  ]);

  const result = await handlers["commands/list"]({ cwd: project });

  const errorFiles = result.errors.map((error) => error.file);
  expect(errorFiles).toEqual(
    expect.arrayContaining([
      "prompts/Review.md",
      "prompts/clear.md",
      "prompts/empty.md",
      "prompts/escape.md",
      "prompts/oversize.md",
      "prompts/secret.md",
      "skills/deploy/SKILL.md",
    ]),
  );
  expect(result.errors).toContainEqual({
    file: "prompts/clear.md",
    source: "project",
    messages: ['"clear" is a built-in command'],
  });
  expect(result.errors).toContainEqual({
    file: "prompts/oversize.md",
    source: "project",
    messages: ["too large"],
  });
  expect(result.errors).toContainEqual({
    file: "prompts/escape.md",
    source: "project",
    messages: ["outside the folder"],
  });
  expect(result.errors).toContainEqual({
    file: "prompts/secret.md",
    source: "project",
    messages: ["protected path"],
  });
  expect(result.commands.map((command) => command.name)).toEqual(["deploy"]);
  expect(result.commands[0]?.kind).toBe("prompt");
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(PROTECTED_MARKER);
  expect(serialized).not.toContain(ESCAPE_MARKER);
  expect(serialized).not.toContain(OVERSIZE_MARKER);
});

it("commands_list_without_cwd_reads_only_the_library", async () => {
  const library = await writeTree(await makeTempDir(), {
    "prompts/review.md": REVIEW_PROMPT,
  });
  const handlers = await rig(null, library);

  const result = await handlers["commands/list"]({});

  expect(result.commands.map((command) => command.source)).toEqual(["library"]);
  expect(result.errors).toEqual([]);
});

it("commands_list_missing_dirs_yield_empty_lists", async () => {
  const project = await makeTempDir();
  const handlers = await rig(project, join(await makeTempDir(), "absent"));

  const result = await handlers["commands/list"]({ cwd: project });

  expect(result).toEqual({ commands: [], errors: [] });
});

it("commands_list_default_library_under_user_data_is_listed", async () => {
  const userData = await makeTempDir();
  const homeDir = await makeTempDir();
  const library = await writeTree(join(userData, "library"), {
    "prompts/review.md": REVIEW_PROMPT,
  });
  const handlers = await rig(
    null,
    library,
    protectedPaths({ homeDir, userData, accountDirs: [] }),
  );

  const result = await handlers["commands/list"]({});

  expect(result.commands).toEqual([
    {
      name: "review",
      description: "Review the diff",
      kind: "prompt",
      source: "library",
      file: "prompts/review.md",
      body: "Review $ARGUMENTS",
    },
  ]);
  expect(result.errors).toEqual([]);
});

it("commands_list_symlinked_project_prompts_dir_is_rejected", async (context) => {
  const project = await makeTempDir();
  const outside = await makeTempDir();
  await writeFile(join(outside, "review.md"), ESCAPE_MARKER);
  try {
    await symlink(outside, join(project, "prompts"), "dir");
  } catch (error) {
    console.warn("symlink creation is not supported here", error);
    context.skip();
    return;
  }
  const userData = await makeTempDir();
  const handlers = await rig(
    project,
    await makeTempDir(),
    protectedPaths({ homeDir: await makeTempDir(), userData, accountDirs: [] }),
  );

  const result = await handlers["commands/list"]({ cwd: project });

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "prompts/review.md",
      source: "project",
      messages: ["outside the folder"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(ESCAPE_MARKER);
});
