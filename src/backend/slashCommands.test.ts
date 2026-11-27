import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { SLASH_COMMAND_MAX_BYTES } from "./constants";
import type { DefinitionRoots } from "./definitionLibrary";
import {
  createSlashCommandLibrary,
  type SlashCommandLibrary,
} from "./slashCommands";

const OVERSIZE_MARKER = "SECRET_OVERSIZE_BODY";
const ESCAPE_MARKER = "SECRET_ESCAPE_BODY";
const PROTECTED_MARKER = "SECRET_PROTECTED_BODY";

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const file = join(root, relative);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    }),
  );
}

function libraryFor(
  roots: DefinitionRoots,
  protectedList: readonly string[] = [],
): SlashCommandLibrary {
  return createSlashCommandLibrary({
    definitionRoots: () => Promise.resolve(roots),
    protectedPaths: () => Promise.resolve(protectedList),
  });
}

it("frontmatter_name_must_match_the_file_name", async () => {
  const project = await makeTempDir();
  await writeFiles(project, {
    "prompts/review.md": "---\nname: other\n---\n\nBody\n",
  });

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result).toEqual({
    commands: [],
    errors: [
      {
        file: "prompts/review.md",
        source: "project",
        messages: ['Frontmatter name "other" does not match "review"'],
      },
    ],
  });
});

it("builtin_names_are_rejected", async () => {
  const project = await makeTempDir();
  const builtins = ["clear", "compact", "model", "resume", "rewind"];
  await writeFiles(
    project,
    Object.fromEntries(
      builtins.map((name) => [`prompts/${name}.md`, "Body\n"]),
    ),
  );

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual(
    builtins.map((name) => ({
      file: `prompts/${name}.md`,
      source: "project",
      messages: [`"${name}" is a built-in command`],
    })),
  );
});

it("uppercase_or_spaced_names_are_rejected", async () => {
  const project = await makeTempDir();
  await writeFiles(project, {
    "prompts/Review.md": "Body\n",
    "prompts/my review.md": "Body\n",
  });

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors.map((error) => error.file)).toEqual([
    "prompts/Review.md",
    "prompts/my review.md",
  ]);
  expect(result.errors[0]?.messages).toEqual(['Invalid command name "Review"']);
});

it("body_over_64_kib_is_rejected_without_reading", async () => {
  const project = await makeTempDir();
  await writeFiles(project, {
    "prompts/large.md": `${OVERSIZE_MARKER}${"x".repeat(SLASH_COMMAND_MAX_BYTES)}`,
  });

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual([
    { file: "prompts/large.md", source: "project", messages: ["too large"] },
  ]);
  expect(JSON.stringify(result)).not.toContain(OVERSIZE_MARKER);
});

it("symlink_escaping_the_prompts_dir_is_rejected", async (context) => {
  const project = await makeTempDir();
  const outside = await makeTempDir();
  await writeFiles(outside, { "escape.md": ESCAPE_MARKER });
  await mkdir(join(project, "prompts"), { recursive: true });
  try {
    await symlink(
      join(outside, "escape.md"),
      join(project, "prompts", "escape.md"),
    );
  } catch (error) {
    console.warn("symlink creation is not supported here", error);
    context.skip();
    return;
  }

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "prompts/escape.md",
      source: "project",
      messages: ["outside the folder"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(ESCAPE_MARKER);
});

it("protected_target_is_rejected", async () => {
  const project = await makeTempDir();
  await writeFiles(project, {
    "prompts/secret.md": `${PROTECTED_MARKER}\n`,
  });

  const result = await libraryFor({ project, library: await makeTempDir() }, [
    join(project, "prompts", "secret.md"),
  ]).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "prompts/secret.md",
      source: "project",
      messages: ["protected path"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(PROTECTED_MARKER);
});

it("prompt_and_skill_with_one_name_keep_the_prompt", async () => {
  const project = await makeTempDir();
  await writeFiles(project, {
    "prompts/deploy.md": "Deploy prompt\n",
    "skills/deploy/SKILL.md": "Deploy skill\n",
  });

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([
    {
      name: "deploy",
      description: "",
      kind: "prompt",
      source: "project",
      file: "prompts/deploy.md",
      body: "Deploy prompt",
    },
  ]);
  expect(result.errors).toEqual([
    {
      file: "skills/deploy/SKILL.md",
      source: "project",
      messages: [
        'Duplicate command "deploy" (already defined in prompts/deploy.md)',
      ],
    },
  ]);
});

it("skills_dir_without_skill_md_is_ignored", async () => {
  const project = await makeTempDir();
  await writeFiles(project, {
    "skills/empty/README.md": "No skill file\n",
  });

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result).toEqual({ commands: [], errors: [] });
});

it("project_shadows_library_by_name", async () => {
  const project = await makeTempDir();
  const library = await makeTempDir();
  await writeFiles(project, {
    "prompts/review.md": "---\ndescription: Project\n---\n\nProject body\n",
  });
  await writeFiles(library, {
    "prompts/review.md": "---\ndescription: Library\n---\n\nLibrary body\n",
    "prompts/other.md": "---\ndescription: Other\n---\n\nOther body\n",
  });

  const result = await libraryFor({ project, library }).list(project);

  expect(
    result.commands.map(({ name, source, body }) => ({ name, source, body })),
  ).toEqual([
    { name: "other", source: "library", body: "Other body" },
    { name: "review", source: "project", body: "Project body" },
  ]);
  expect(result.errors).toEqual([]);
});

it("same_project_and_library_dir_is_read_once", async () => {
  const root = await makeTempDir();
  await writeFiles(root, {
    "prompts/review.md": "Review body\n",
    "prompts/Bad.md": "Bad name\n",
  });

  const result = await libraryFor({ project: root, library: root }).list(root);

  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]?.source).toBe("project");
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.file).toBe("prompts/Bad.md");
});

it("missing_root_or_dirs_yield_no_errors", async () => {
  const project = await makeTempDir();

  const result = await libraryFor({
    project,
    library: join(await makeTempDir(), "absent"),
  }).list(project);

  expect(result).toEqual({ commands: [], errors: [] });
});

it("default_library_under_user_data_is_not_protected", async (context) => {
  const userData = await makeTempDir();
  const library = join(userData, "library");
  const accountDir = await makeTempDir();
  await writeFiles(library, {
    "prompts/review.md": "---\ndescription: Review\n---\n\nReview body\n",
    "prompts/secret.md": PROTECTED_MARKER,
  });
  await writeFiles(accountDir, { "auth.json": ESCAPE_MARKER });
  try {
    await symlink(
      join(accountDir, "auth.json"),
      join(library, "prompts", "leak.md"),
    );
  } catch (error) {
    console.warn("symlink creation is not supported here", error);
    context.skip();
    return;
  }
  const protectedList = [
    userData,
    accountDir,
    join(library, "prompts", "secret.md"),
  ];

  const result = await libraryFor(
    { project: null, library },
    protectedList,
  ).list();

  expect(result.commands).toEqual([
    {
      name: "review",
      description: "Review",
      kind: "prompt",
      source: "library",
      file: "prompts/review.md",
      body: "Review body",
    },
  ]);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      {
        file: "prompts/leak.md",
        source: "library",
        messages: ["outside the folder"],
      },
      {
        file: "prompts/secret.md",
        source: "library",
        messages: ["protected path"],
      },
    ]),
  );
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(ESCAPE_MARKER);
  expect(serialized).not.toContain(PROTECTED_MARKER);
});

it("symlinked_prompts_dir_escaping_the_root_is_rejected", async (context) => {
  const project = await makeTempDir();
  const outside = await makeTempDir();
  await writeFiles(outside, { "review.md": ESCAPE_MARKER });
  try {
    await symlink(outside, join(project, "prompts"), "dir");
  } catch (error) {
    console.warn("symlink creation is not supported here", error);
    context.skip();
    return;
  }

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

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

it("symlinked_skills_dir_escaping_the_root_is_rejected", async (context) => {
  const project = await makeTempDir();
  const outside = await makeTempDir();
  await writeFiles(outside, { "deploy/SKILL.md": ESCAPE_MARKER });
  try {
    await symlink(outside, join(project, "skills"), "dir");
  } catch (error) {
    console.warn("symlink creation is not supported here", error);
    context.skip();
    return;
  }

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "skills/deploy/SKILL.md",
      source: "project",
      messages: ["outside the folder"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(ESCAPE_MARKER);
});

it("symlinked_skill_folder_escaping_the_skills_dir_is_rejected", async (context) => {
  const project = await makeTempDir();
  const outside = await makeTempDir();
  await writeFiles(outside, { "SKILL.md": ESCAPE_MARKER });
  await mkdir(join(project, "skills"), { recursive: true });
  try {
    await symlink(outside, join(project, "skills", "deploy"), "dir");
  } catch (error) {
    console.warn("symlink creation is not supported here", error);
    context.skip();
    return;
  }

  const result = await libraryFor({
    project,
    library: await makeTempDir(),
  }).list(project);

  expect(result.commands).toEqual([]);
  expect(result.errors).toEqual([
    {
      file: "skills/deploy/SKILL.md",
      source: "project",
      messages: ["outside the folder"],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(ESCAPE_MARKER);
});
