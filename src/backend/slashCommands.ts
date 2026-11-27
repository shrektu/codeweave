import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { isProtectedPath } from "../domain/pathScope";
import {
  BUILTIN_SLASH_COMMANDS,
  parseSlashCommandFile,
  SLASH_COMMAND_NAME_PATTERN,
  type SlashCommandFile,
} from "../domain/slashCommandFile";
import { DefinitionSource, SlashCommandKind } from "../domain/types";
import type {
  FlowFileError,
  SlashCommandsList,
  SlashCommandView,
} from "../shared/views";

import {
  PROMPTS_DIR,
  SKILLS_DIR,
  SKILL_FILE_NAME,
  SLASH_COMMAND_MAX_BYTES,
} from "./constants";
import type {
  DefinitionRoots,
  ResolveDefinitionRoots,
} from "./definitionLibrary";
import {
  failure,
  isInside,
  isMarkdownName,
  isMissing,
  MARKDOWN_EXTENSION,
  sameDirectory,
  unreadableRoot,
} from "./flows";

const OUTSIDE_FOLDER_MESSAGE = "outside the folder";
const PROTECTED_PATH_MESSAGE = "protected path";
const TOO_LARGE_MESSAGE = "too large";

export interface SlashCommandLibrary {
  list(cwd?: string): Promise<SlashCommandsList>;
}

export interface SlashCommandLibraryDeps {
  readonly definitionRoots: ResolveDefinitionRoots;
  readonly protectedPaths: () => Promise<readonly string[]>;
}

interface CommandContext {
  readonly root: string;
  readonly source: DefinitionSource;
  readonly protectedPaths: readonly string[];
}

interface LoadedCommand {
  readonly name: string;
  readonly file: string;
  readonly view: SlashCommandView;
}

interface SourceLoad {
  readonly commands: LoadedCommand[];
  readonly errors: FlowFileError[];
}

interface DirectoryEntries {
  readonly entries: readonly Dirent[];
  readonly error: FlowFileError | null;
}

type CommandLoad =
  | { readonly ok: true; readonly value: LoadedCommand }
  | { readonly ok: false; readonly error: FlowFileError };

function emptySource(): SourceLoad {
  return { commands: [], errors: [] };
}

function commandError(
  file: string,
  source: DefinitionSource,
  messages: readonly string[],
): CommandLoad {
  return { ok: false, error: { file, source, messages: [...messages] } };
}

function nameError(name: string): string | null {
  if (!SLASH_COMMAND_NAME_PATTERN.test(name)) {
    return `Invalid command name "${name}"`;
  }
  if (BUILTIN_SLASH_COMMANDS.some((builtin) => builtin === name)) {
    return `"${name}" is a built-in command`;
  }
  return null;
}

function frontmatterNameError(
  parsed: SlashCommandFile,
  name: string,
): string | null {
  if (parsed.name === null || parsed.name === name) {
    return null;
  }
  return `Frontmatter name "${parsed.name}" does not match "${name}"`;
}

async function readEntries(
  root: string,
  dir: string,
  source: DefinitionSource,
): Promise<DirectoryEntries> {
  try {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    return { entries, error: null };
  } catch (error) {
    const cause = isMissing(error) ? await unreadableRoot(root) : error;
    return cause === null
      ? { entries: [], error: null }
      : { entries: [], error: failure(dir, source, cause) };
  }
}

async function isFileAfterLinks(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    console.warn(`the command file ${target} cannot be inspected`, error);
    return false;
  }
}

function commandDirectory(kind: SlashCommandKind): string {
  return kind === SlashCommandKind.prompt ? PROMPTS_DIR : SKILLS_DIR;
}

async function libraryProtectedPaths(
  root: string,
  protectedPaths: readonly string[],
): Promise<readonly string[]> {
  try {
    const rootReal = await realpath(root);
    return protectedPaths.filter(
      (pattern) => !isProtectedPath(rootReal, [pattern]),
    );
  } catch (error) {
    if (!isMissing(error)) {
      console.warn(`the command root ${root} cannot be resolved`, error);
    }
    return protectedPaths;
  }
}

function commandFile(kind: SlashCommandKind, name: string): string {
  return kind === SlashCommandKind.prompt
    ? `${PROMPTS_DIR}/${name}${MARKDOWN_EXTENSION}`
    : `${SKILLS_DIR}/${name}/${SKILL_FILE_NAME}`;
}

async function realFileInside(
  root: string,
  name: string,
  kind: SlashCommandKind,
): Promise<string | null> {
  const dir = commandDirectory(kind);
  const file = commandFile(kind, name);
  const [rootReal, dirReal, fileReal] = await Promise.all([
    realpath(root),
    realpath(join(root, dir)),
    realpath(join(root, file)),
  ]);
  if (!isInside(rootReal, dirReal) || !isInside(dirReal, fileReal)) {
    return null;
  }
  if (kind === SlashCommandKind.skill) {
    const folderReal = await realpath(join(root, dir, name));
    return isInside(dirReal, folderReal) ? fileReal : null;
  }
  return fileReal;
}

async function loadCommandFile(
  context: CommandContext,
  name: string,
  kind: SlashCommandKind,
): Promise<CommandLoad> {
  const file = commandFile(kind, name);
  const invalidName = nameError(name);
  if (invalidName !== null) {
    return commandError(file, context.source, [invalidName]);
  }
  try {
    const fileReal = await realFileInside(context.root, name, kind);
    if (fileReal === null) {
      return commandError(file, context.source, [OUTSIDE_FOLDER_MESSAGE]);
    }
    if (isProtectedPath(fileReal, context.protectedPaths)) {
      return commandError(file, context.source, [PROTECTED_PATH_MESSAGE]);
    }
    if ((await stat(fileReal)).size > SLASH_COMMAND_MAX_BYTES) {
      return commandError(file, context.source, [TOO_LARGE_MESSAGE]);
    }
    const parsed = parseSlashCommandFile(await readFile(fileReal, "utf8"));
    if (!parsed.ok) {
      return commandError(file, context.source, parsed.errors);
    }
    const mismatch = frontmatterNameError(parsed.value, name);
    if (mismatch !== null) {
      return commandError(file, context.source, [mismatch]);
    }
    return {
      ok: true,
      value: {
        name,
        file,
        view: {
          name,
          description: parsed.value.description,
          kind,
          source: context.source,
          file,
          body: parsed.value.body,
        },
      },
    };
  } catch (error) {
    return { ok: false, error: failure(file, context.source, error) };
  }
}

function collectResults(results: readonly CommandLoad[]): SourceLoad {
  return {
    commands: results.flatMap((result) => (result.ok ? [result.value] : [])),
    errors: results.flatMap((result) => (result.ok ? [] : [result.error])),
  };
}

async function loadPrompts(context: CommandContext): Promise<SourceLoad> {
  const { entries, error } = await readEntries(
    context.root,
    PROMPTS_DIR,
    context.source,
  );
  if (error !== null) {
    return { commands: [], errors: [error] };
  }
  const candidates = entries
    .map((entry) => entry.name)
    .filter(isMarkdownName)
    .toSorted();
  const checked = await Promise.all(
    candidates.map(async (fileName) => ({
      fileName,
      isFile: await isFileAfterLinks(join(context.root, PROMPTS_DIR, fileName)),
    })),
  );
  const results = await Promise.all(
    checked
      .filter((entry) => entry.isFile)
      .map(async (entry): Promise<CommandLoad> =>
        loadCommandFile(
          context,
          entry.fileName.slice(
            0,
            entry.fileName.length - MARKDOWN_EXTENSION.length,
          ),
          SlashCommandKind.prompt,
        ),
      ),
  );
  return collectResults(results);
}

async function loadSkills(context: CommandContext): Promise<SourceLoad> {
  const { entries, error } = await readEntries(
    context.root,
    SKILLS_DIR,
    context.source,
  );
  if (error !== null) {
    return { commands: [], errors: [error] };
  }
  const directories = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .toSorted();
  const checked = await Promise.all(
    directories.map(async (name) => ({
      name,
      isSkill: await isFileAfterLinks(
        join(context.root, SKILLS_DIR, name, SKILL_FILE_NAME),
      ),
    })),
  );
  const results = await Promise.all(
    checked
      .filter((entry) => entry.isSkill)
      .map(async (entry): Promise<CommandLoad> =>
        loadCommandFile(context, entry.name, SlashCommandKind.skill),
      ),
  );
  return collectResults(results);
}

function mergeSource(
  prompts: SourceLoad,
  skills: SourceLoad,
  source: DefinitionSource,
): SourceLoad {
  const promptFiles = new Map(
    prompts.commands.map((command) => [command.name, command.file]),
  );
  const keptSkills: LoadedCommand[] = [];
  const duplicateErrors: FlowFileError[] = [];
  for (const skill of skills.commands) {
    const promptFile = promptFiles.get(skill.name);
    if (promptFile === undefined) {
      keptSkills.push(skill);
    } else {
      duplicateErrors.push({
        file: skill.file,
        source,
        messages: [
          `Duplicate command "${skill.name}" (already defined in ${promptFile})`,
        ],
      });
    }
  }
  return {
    commands: [...prompts.commands, ...keptSkills],
    errors: [...prompts.errors, ...skills.errors, ...duplicateErrors],
  };
}

async function loadSource(context: CommandContext): Promise<SourceLoad> {
  const [prompts, skills] = await Promise.all([
    loadPrompts(context),
    loadSkills(context),
  ]);
  return mergeSource(prompts, skills, context.source);
}

interface LoadedRoots {
  readonly project: SourceLoad | null;
  readonly library: SourceLoad;
}

async function loadRoots(
  roots: DefinitionRoots,
  protectedPaths: readonly string[],
): Promise<LoadedRoots> {
  const libraryContext: CommandContext = {
    root: roots.library,
    source: DefinitionSource.library,
    protectedPaths: await libraryProtectedPaths(roots.library, protectedPaths),
  };
  if (roots.project === null) {
    return { project: null, library: await loadSource(libraryContext) };
  }
  const projectContext: CommandContext = {
    root: roots.project,
    source: DefinitionSource.project,
    protectedPaths,
  };
  const shared = await sameDirectory(roots.project, roots.library);
  const [project, library] = await Promise.all([
    loadSource(projectContext),
    shared ? Promise.resolve(emptySource()) : loadSource(libraryContext),
  ]);
  return { project, library };
}

function visibleLibrary(
  project: SourceLoad | null,
  library: SourceLoad,
): SourceLoad {
  if (project === null) {
    return library;
  }
  const projectNames = new Set(project.commands.map((command) => command.name));
  return {
    commands: library.commands.filter(
      (command) => !projectNames.has(command.name),
    ),
    errors: library.errors,
  };
}

export function createSlashCommandLibrary(
  deps: SlashCommandLibraryDeps,
): SlashCommandLibrary {
  return {
    list: async (cwd) => {
      const roots = await deps.definitionRoots(cwd);
      const protectedPaths = await deps.protectedPaths();
      const { project, library } = await loadRoots(roots, protectedPaths);
      const visible = visibleLibrary(project, library);
      const projectCommands = project?.commands ?? [];
      return {
        commands: [...projectCommands, ...visible.commands]
          .map((command) => command.view)
          .toSorted((first, second) => first.name.localeCompare(second.name)),
        errors: [...(project?.errors ?? []), ...visible.errors],
      };
    },
  };
}
