import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { DEFAULT_FLOW_ROUNDS } from "../domain/constants";
import { serializeFlowFile } from "../domain/flowFile";
import {
  parseAgentDocuments,
  parseFlowFile,
  validateFlow,
  type AgentDocument,
  type FlowDefinition,
  type ParseResult,
} from "../domain/flows";
import { DefinitionSource } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type {
  AgentView,
  FlowFileError,
  FlowsList,
  FlowView,
} from "../shared/views";

import { replaceFileAtomically } from "./atomicFile";
import type { DefinitionRoots } from "./definitionLibrary";
import { KeyedMutex } from "./keyedMutex";

export const FLOWS_DIR = "flows";
export const AGENTS_DIR = "agents";
export const MARKDOWN_EXTENSION = ".md";

const DEFINITION_LABELS = {
  [FLOWS_DIR]: "Flow",
  [AGENTS_DIR]: "Agent",
} as const;
const FORBIDDEN_NAME_CHARS = ["/", "\\", "\0"] as const;

type DefinitionDir = keyof typeof DEFINITION_LABELS;

function isMarkdownName(name: string): boolean {
  return name.endsWith(MARKDOWN_EXTENSION);
}

function isDefinitionFile(dir: DefinitionDir, file: string): boolean {
  const prefix = `${dir}/`;
  const name = file.slice(prefix.length);
  return (
    file.startsWith(prefix) &&
    isMarkdownName(name) &&
    FORBIDDEN_NAME_CHARS.every((char) => !name.includes(char))
  );
}
const PARENT_SEGMENT = "..";

interface LoadedFlow {
  readonly definition: FlowDefinition;
  readonly revision: string;
}

interface LoadedAgentFile {
  readonly documents: AgentDocument[];
  readonly revision: string;
}

interface SaveFlowParams {
  readonly source: DefinitionSource;
  readonly file: string;
  readonly revision: string;
  readonly flow: FlowDefinition;
}

type LoadedFile<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FlowFileError };

interface ParsedFile<T> {
  readonly file: string;
  readonly source: DefinitionSource;
  readonly value: T;
}

interface LoadedDir<T> {
  readonly files: ParsedFile<T>[];
  readonly errors: FlowFileError[];
}

interface SourceFiles {
  readonly flows: LoadedDir<LoadedFlow>;
  readonly agents: LoadedDir<LoadedAgentFile>;
}

type Sources = Record<DefinitionSource, SourceFiles>;

export interface AgentIdentity {
  readonly file: string;
  readonly id: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function failure(
  file: string,
  source: DefinitionSource,
  error: unknown,
): FlowFileError {
  return { file, source, messages: [errorText(error)] };
}

async function unreadableRoot(root: string): Promise<unknown> {
  try {
    return (await stat(root)).isDirectory()
      ? null
      : new Error(`${root} is not a folder`);
  } catch (error) {
    return isMissing(error) ? null : error;
  }
}

async function markdownNames(
  root: string,
  source: DefinitionSource,
  dir: string,
): Promise<LoadedFile<string[]>> {
  try {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && isMarkdownName(entry.name))
      .map((entry) => entry.name)
      .toSorted();
    return { ok: true, value: names };
  } catch (error) {
    const cause = isMissing(error) ? await unreadableRoot(root) : error;
    return cause === null
      ? { ok: true, value: [] }
      : { ok: false, error: failure(dir, source, cause) };
  }
}

async function loadDir<T>(
  root: string,
  source: DefinitionSource,
  dir: string,
  parse: (markdown: string) => ParseResult<T>,
): Promise<LoadedDir<T>> {
  const names = await markdownNames(root, source, dir);
  if (!names.ok) {
    return { files: [], errors: [names.error] };
  }
  const loaded = await Promise.all(
    names.value.map(async (name): Promise<LoadedFile<ParsedFile<T>>> => {
      const file = `${dir}/${name}`;
      try {
        const parsed = parse(await readFile(join(root, file), "utf8"));
        return parsed.ok
          ? { ok: true, value: { file, source, value: parsed.value } }
          : { ok: false, error: { file, source, messages: parsed.errors } };
      } catch (error) {
        return { ok: false, error: failure(file, source, error) };
      }
    }),
  );
  return {
    files: loaded.flatMap((item) => (item.ok ? [item.value] : [])),
    errors: loaded.flatMap((item) => (item.ok ? [] : [item.error])),
  };
}

export function contentRevision(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function usedBy(
  id: string,
  flows: readonly ParsedFile<LoadedFlow>[],
): AgentView["usedBy"] {
  return flows
    .filter(({ value }) => value.definition.nodes.some((n) => n.agent === id))
    .map(({ file, source, value }) => ({
      file,
      source,
      title: value.definition.title,
    }));
}

function agentViews(
  { file, source, value: { documents, revision } }: ParsedFile<LoadedAgentFile>,
  flows: readonly ParsedFile<LoadedFlow>[],
  hiddenIds: ReadonlySet<string>,
): AgentView[] {
  return documents
    .filter(({ definition }) => !hiddenIds.has(definition.id))
    .map(({ definition, body }) => ({
      id: definition.id,
      file,
      source,
      revision,
      role: definition.role,
      provider: definition.provider,
      model: definition.model ?? null,
      permissionProfile: definition.permissionProfile,
      taskClass: definition.taskClass ?? null,
      body,
      usedBy: usedBy(definition.id, flows),
    }));
}

function parseLoadedAgents(markdown: string): ParseResult<LoadedAgentFile> {
  const parsed = parseAgentDocuments(markdown);
  return parsed.ok
    ? {
        ok: true,
        value: { documents: parsed.value, revision: contentRevision(markdown) },
      }
    : parsed;
}

function parseLoadedFlow(markdown: string): ParseResult<LoadedFlow> {
  const parsed = parseFlowFile(markdown);
  return parsed.ok
    ? {
        ok: true,
        value: {
          definition: parsed.value,
          revision: contentRevision(markdown),
        },
      }
    : parsed;
}

function flowView({
  file,
  source,
  value: { definition, revision },
}: ParsedFile<LoadedFlow>): FlowView {
  return {
    id: definition.id,
    file,
    source,
    revision,
    title: definition.title,
    maxRounds: definition.maxRounds ?? DEFAULT_FLOW_ROUNDS,
    nodes: definition.nodes.map(({ id, agent, provider, taskClass }) => ({
      id,
      agent,
      provider: provider ?? null,
      taskClass: taskClass ?? null,
    })),
    edges: definition.edges.map(({ from, to, kind, gate }) => ({
      from,
      to,
      kind,
      gate: gate ?? false,
    })),
  };
}

function duplicateIdError(
  { file, source }: ParsedFile<LoadedFlow>,
  id: string,
  firstFile: string,
): FlowFileError {
  return {
    file,
    source,
    messages: [`Duplicate flow id "${id}" (already defined in ${firstFile})`],
  };
}

interface Deduplicated {
  readonly flows: FlowView[];
  readonly errors: FlowFileError[];
}

function deduplicate(valid: readonly ParsedFile<LoadedFlow>[]): Deduplicated {
  const firstFiles = new Map<string, string>();
  const flows: FlowView[] = [];
  const errors: FlowFileError[] = [];
  for (const parsed of valid) {
    const { id } = parsed.value.definition;
    const firstFile = firstFiles.get(id);
    if (firstFile === undefined) {
      firstFiles.set(id, parsed.file);
      flows.push(flowView(parsed));
    } else {
      errors.push(duplicateIdError(parsed, id, firstFile));
    }
  }
  return { flows, errors };
}

function emptyDir<T>(): LoadedDir<T> {
  return { files: [], errors: [] };
}

async function loadSource(
  root: string,
  source: DefinitionSource,
): Promise<SourceFiles> {
  const [flows, agents] = await Promise.all([
    loadDir(root, source, FLOWS_DIR, parseLoadedFlow),
    loadDir(root, source, AGENTS_DIR, parseLoadedAgents),
  ]);
  return { flows, agents };
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) {
      console.warn(`The definition folder ${path} cannot be resolved`, error);
    }
    return null;
  }
}

async function sameDirectory(first: string, second: string): Promise<boolean> {
  const [firstPath, secondPath] = await Promise.all([
    realpathOrNull(first),
    realpathOrNull(second),
  ]);
  return firstPath !== null && firstPath === secondPath;
}

async function loadSources(roots: DefinitionRoots): Promise<Sources> {
  const shared = await sameDirectory(roots.project, roots.library);
  const [project, library] = await Promise.all([
    loadSource(roots.project, DefinitionSource.project),
    shared
      ? { flows: emptyDir<LoadedFlow>(), agents: emptyDir<LoadedAgentFile>() }
      : loadSource(roots.library, DefinitionSource.library),
  ]);
  return { project, library };
}

function agentIds(dir: LoadedDir<LoadedAgentFile>): string[] {
  return dir.files.flatMap(({ value }) =>
    value.documents.map(({ definition }) => definition.id),
  );
}

function effectiveAgentIds({ project, library }: Sources): string[] {
  const projectIds = agentIds(project.agents);
  const shadowed = new Set(projectIds);
  return [
    ...projectIds,
    ...agentIds(library.agents).filter((id) => !shadowed.has(id)),
  ];
}

function identities(dir: LoadedDir<LoadedAgentFile>): AgentIdentity[] {
  return dir.files.flatMap(({ file, value }) =>
    value.documents.map(({ definition }) => ({ file, id: definition.id })),
  );
}

export async function loadAgentIdentities(
  roots: DefinitionRoots,
): Promise<Record<DefinitionSource, AgentIdentity[]>> {
  const { project, library } = await loadSources(roots);
  return {
    project: identities(project.agents),
    library: identities(library.agents),
  };
}

interface CheckedFlows {
  readonly valid: ParsedFile<LoadedFlow>[];
  readonly invalid: FlowFileError[];
}

function checkFlows(
  files: readonly ParsedFile<LoadedFlow>[],
  agentIdList: readonly string[],
): CheckedFlows {
  const agents = agentIdList.map((id) => ({ id }));
  const checked = files.map((parsed) => ({
    parsed,
    messages: validateFlow(parsed.value.definition, agents),
  }));
  return {
    valid: checked.flatMap(({ parsed, messages }) =>
      messages.length === 0 ? [parsed] : [],
    ),
    invalid: checked.flatMap(({ parsed, messages }) =>
      messages.length > 0
        ? [{ file: parsed.file, source: parsed.source, messages }]
        : [],
    ),
  };
}

function flowIds(files: readonly ParsedFile<LoadedFlow>[]): Set<string> {
  return new Set(files.map(({ value }) => value.definition.id));
}

export async function listFlows(roots: DefinitionRoots): Promise<FlowsList> {
  const sources = await loadSources(roots);
  const { project, library } = sources;
  const agentIdList = effectiveAgentIds(sources);
  const projectChecked = checkFlows(project.flows.files, agentIdList);
  const shadowedFlows = flowIds(project.flows.files);
  const libraryFlows = library.flows.files.filter(
    ({ value }) => !shadowedFlows.has(value.definition.id),
  );
  const libraryChecked = checkFlows(libraryFlows, agentIdList);
  const projectUnique = deduplicate(projectChecked.valid);
  const libraryUnique = deduplicate(libraryChecked.valid);
  const parsedFlows = [...project.flows.files, ...library.flows.files];
  const shadowedAgents = new Set(agentIds(project.agents));
  return {
    flows: [...projectUnique.flows, ...libraryUnique.flows],
    agents: [
      ...project.agents.files.flatMap((file) =>
        agentViews(file, parsedFlows, new Set()),
      ),
      ...library.agents.files.flatMap((file) =>
        agentViews(file, parsedFlows, shadowedAgents),
      ),
    ],
    errors: [
      ...project.flows.errors,
      ...projectChecked.invalid,
      ...projectUnique.errors,
      ...project.agents.errors,
      ...library.flows.errors,
      ...libraryChecked.invalid,
      ...libraryUnique.errors,
      ...library.agents.errors,
    ],
    locations: { project: roots.project, library: roots.library },
  };
}

export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const escapesParent =
    path === PARENT_SEGMENT ||
    path.startsWith(`${PARENT_SEGMENT}${sep}`) ||
    path.startsWith(`${PARENT_SEGMENT}/`);
  return path !== "" && !escapesParent && !isAbsolute(path);
}

export async function resolveDefinitionFile(
  root: string,
  dir: DefinitionDir,
  file: string,
): Promise<string> {
  const label = DEFINITION_LABELS[dir];
  if (!isDefinitionFile(dir, file)) {
    throw new IpcError(
      IpcErrorCode.VALIDATION,
      `${label} file must be a .md file directly in ${dir}/`,
    );
  }
  try {
    const [definitionsDir, target] = await Promise.all([
      realpath(join(root, dir)),
      realpath(join(root, file)),
    ]);
    if (!isInside(definitionsDir, target)) {
      throw new IpcError(
        IpcErrorCode.VALIDATION,
        `${label} file must stay inside ${dir}/`,
      );
    }
    return target;
  } catch (error) {
    if (isMissing(error)) {
      throw new IpcError(
        IpcErrorCode.NOT_FOUND,
        `${label} file ${file} not found`,
      );
    }
    throw error;
  }
}

const workspaceLocks = new KeyedMutex();

async function workspaceKey(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (error) {
    if (isMissing(error)) {
      return root;
    }
    throw error;
  }
}

export async function withWorkspaceLock<T>(
  root: string,
  task: () => Promise<T>,
): Promise<T> {
  return workspaceLocks.run(await workspaceKey(root), task);
}

async function applyFlowSave(
  roots: DefinitionRoots,
  target: string,
  { revision, flow }: SaveFlowParams,
): Promise<void> {
  const current = await readFile(target, "utf8");
  if (contentRevision(current) !== revision) {
    throw new IpcError(IpcErrorCode.CONFLICT, "The flow file changed on disk");
  }
  const existing = parseFlowFile(current);
  if (!existing.ok) {
    throw new IpcError(IpcErrorCode.VALIDATION, existing.errors.join("; "));
  }
  if (existing.value.id !== flow.id) {
    throw new IpcError(
      IpcErrorCode.VALIDATION,
      "Changing the flow id is not supported",
    );
  }
  const agents = effectiveAgentIds(await loadSources(roots)).map((id) => ({
    id,
  }));
  const messages = validateFlow(flow, agents);
  if (messages.length > 0) {
    throw new IpcError(IpcErrorCode.VALIDATION, messages.join("; "));
  }
  const serialized = serializeFlowFile(current, flow);
  if (!serialized.ok) {
    throw new IpcError(IpcErrorCode.VALIDATION, serialized.errors.join("; "));
  }
  await replaceFileAtomically(target, serialized.value);
}

export async function saveFlow(
  roots: DefinitionRoots,
  params: SaveFlowParams,
): Promise<FlowsList> {
  const root = roots[params.source];
  await withWorkspaceLock(root, async () => {
    const target = await resolveDefinitionFile(root, FLOWS_DIR, params.file);
    await applyFlowSave(roots, target, params);
  });
  return listFlows(roots);
}
