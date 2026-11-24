import { mkdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  newAgentFile,
  removeAgentBlock,
  serializeAgentBlock,
  validateAgent,
} from "../domain/agentFile";
import {
  parseAgentDocuments,
  type AgentDocument,
  type ParseResult,
} from "../domain/flows";
import { DefinitionSource } from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type { AgentView, FlowsList } from "../shared/views";

import { createFileExclusively, replaceFileAtomically } from "./atomicFile";
import type { DefinitionRoots } from "./definitionLibrary";
import {
  AGENTS_DIR,
  contentRevision,
  isInside,
  listFlows,
  loadAgentIdentities,
  MARKDOWN_EXTENSION,
  requireDefinitionRoot,
  resolveDefinitionFile,
  withWorkspaceLock,
  type AgentIdentity,
} from "./flows";

const STALE_MESSAGE = "The agent file changed on disk";

type CreateParams = Omit<ParamsMap["agents/create"], "cwd">;
type SaveParams = Omit<ParamsMap["agents/save"], "cwd">;
type DeleteParams = Omit<ParamsMap["agents/delete"], "cwd">;
type AgentIds = Record<DefinitionSource, AgentIdentity[]>;

interface CurrentFile {
  readonly target: string;
  readonly text: string;
  readonly documents: AgentDocument[];
  readonly ids: AgentIds;
  readonly agent: AgentView;
}

function validation(message: string): IpcError {
  return new IpcError(IpcErrorCode.VALIDATION, message);
}

function unwrap<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw validation(result.errors.join("; "));
  }
  return result.value;
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function usedByMessage(id: string, usedBy: AgentView["usedBy"]): string {
  const names = usedBy.map(({ title, file }) => `${title} (${file})`);
  return `Agent "${id}" is used by ${names.join(", ")}; remove it from those flows first`;
}

function assertUnused(id: string, usedBy: AgentView["usedBy"]): void {
  if (usedBy.length > 0) {
    throw validation(usedByMessage(id, usedBy));
  }
}

function assertValid(messages: readonly string[]): void {
  if (messages.length > 0) {
    throw validation(messages.join("; "));
  }
}

function assertNotOverridden(
  source: DefinitionSource,
  id: string,
  projectIds: readonly AgentIdentity[],
): void {
  if (
    source === DefinitionSource.library &&
    projectIds.some((other) => other.id === id)
  ) {
    throw validation(
      `Agent "${id}" is already defined in the project, which overrides the library`,
    );
  }
}

async function ensureAgentsDir(
  root: string,
  source: DefinitionSource,
): Promise<string> {
  await mkdir(join(root, AGENTS_DIR), { recursive: true });
  const [realRoot, agentsDir] = await Promise.all([
    realpath(root),
    realpath(join(root, AGENTS_DIR)),
  ]);
  if (!isInside(realRoot, agentsDir)) {
    throw validation(`${AGENTS_DIR}/ must stay inside the ${source} folder`);
  }
  return agentsDir;
}

async function createExclusively(
  agentsDir: string,
  id: string,
  text: string,
): Promise<string> {
  const name = `${id}${MARKDOWN_EXTENSION}`;
  const target = join(agentsDir, name);
  try {
    await createFileExclusively(target, text);
    return target;
  } catch (error) {
    if (isExisting(error)) {
      throw validation(`An agent file named ${name} already exists`);
    }
    throw error;
  }
}

function notFound(file: string, id: string): IpcError {
  return new IpcError(
    IpcErrorCode.NOT_FOUND,
    `Agent "${id}" not found in ${file}`,
  );
}

export function listedAgent(
  list: FlowsList,
  file: string,
  source: DefinitionSource,
  id: string,
): AgentView {
  const found = list.agents.find(
    (agent) =>
      agent.file === file && agent.source === source && agent.id === id,
  );
  if (found === undefined) {
    throw notFound(file, id);
  }
  return found;
}

async function loadCurrent(
  roots: DefinitionRoots,
  {
    source,
    file,
    id,
    revision,
  }: Pick<SaveParams, "source" | "file" | "id" | "revision">,
): Promise<CurrentFile> {
  const target = await resolveDefinitionFile(
    requireDefinitionRoot(roots, source),
    AGENTS_DIR,
    file,
  );
  const text = await readFile(target, "utf8");
  if (contentRevision(text) !== revision) {
    throw new IpcError(IpcErrorCode.CONFLICT, STALE_MESSAGE);
  }
  const documents = unwrap(parseAgentDocuments(text));
  const [list, ids] = await Promise.all([
    listFlows(roots),
    loadAgentIdentities(roots),
  ]);
  return {
    target,
    text,
    documents,
    ids,
    agent: listedAgent(list, file, source, id),
  };
}

function findDocument(
  { documents }: CurrentFile,
  file: string,
  id: string,
): AgentDocument {
  const found = documents.find(({ definition }) => definition.id === id);
  if (found === undefined) {
    throw notFound(file, id);
  }
  return found;
}

function otherIds(
  { ids }: CurrentFile,
  source: DefinitionSource,
  file: string,
  id: string,
): string[] {
  return ids[source]
    .filter((other) => other.file !== file || other.id !== id)
    .map((other) => other.id);
}

function normalizedBody(body: string): string {
  return body.trim().replaceAll("\r\n", "\n");
}

function assertRoundTrip(
  updated: string,
  expected: AgentDocument["definition"],
  body: string,
  count: number,
): void {
  const reparsed = parseAgentDocuments(updated);
  const documents = reparsed.ok ? reparsed.value : [];
  const document = documents.find(
    ({ definition }) => definition.id === expected.id,
  );
  const intact =
    documents.length === count &&
    document?.definition.role === expected.role &&
    normalizedBody(document.body) === normalizedBody(body);
  if (!intact) {
    throw validation(
      "The agent could not be written without corrupting the file",
    );
  }
}

async function renameFile(
  current: CurrentFile,
  newId: string,
  updated: string,
): Promise<void> {
  const created = await createExclusively(
    dirname(current.target),
    newId,
    updated,
  );
  try {
    await unlink(current.target);
  } catch (error) {
    await rm(created, { force: true });
    throw error;
  }
}

function movesFile(
  { documents }: CurrentFile,
  { file, id, agent }: SaveParams,
): boolean {
  return (
    documents.length === 1 &&
    file === `${AGENTS_DIR}/${id}${MARKDOWN_EXTENSION}` &&
    agent.id.toLowerCase() !== id.toLowerCase()
  );
}

async function applySave(
  roots: DefinitionRoots,
  params: SaveParams,
): Promise<void> {
  const { source, file, id, agent, body } = params;
  const current = await loadCurrent(roots, params);
  findDocument(current, file, id);
  assertValid(validateAgent(agent, body, otherIds(current, source, file, id)));
  if (agent.id !== id) {
    assertNotOverridden(source, agent.id, current.ids.project);
    assertUnused(id, current.agent.usedBy);
  }
  const updated = unwrap(serializeAgentBlock(current.text, id, agent, body));
  assertRoundTrip(updated, agent, body, current.documents.length);
  if (movesFile(current, params)) {
    await renameFile(current, agent.id, updated);
  } else {
    await replaceFileAtomically(current.target, updated);
  }
}

async function applyDelete(
  roots: DefinitionRoots,
  params: DeleteParams,
): Promise<void> {
  const { file, id } = params;
  const current = await loadCurrent(roots, params);
  findDocument(current, file, id);
  assertUnused(id, current.agent.usedBy);
  const remaining = unwrap(removeAgentBlock(current.text, id));
  if (remaining === null) {
    await unlink(current.target);
  } else {
    await replaceFileAtomically(current.target, remaining);
  }
}

export async function createAgent(
  roots: DefinitionRoots,
  { source, agent, body }: CreateParams,
): Promise<FlowsList> {
  const resolvedSource =
    source ??
    (roots.project === null
      ? DefinitionSource.library
      : DefinitionSource.project);
  const root = requireDefinitionRoot(roots, resolvedSource);
  await withWorkspaceLock(root, async () => {
    const ids = await loadAgentIdentities(roots);
    assertValid(
      validateAgent(
        agent,
        body,
        ids[resolvedSource].map(({ id }) => id),
      ),
    );
    assertNotOverridden(resolvedSource, agent.id, ids.project);
    const agentsDir = await ensureAgentsDir(root, resolvedSource);
    await createExclusively(agentsDir, agent.id, newAgentFile(agent, body));
  });
  return listFlows(roots);
}

export async function saveAgent(
  roots: DefinitionRoots,
  params: SaveParams,
): Promise<FlowsList> {
  const root = requireDefinitionRoot(roots, params.source);
  await withWorkspaceLock(root, () => applySave(roots, params));
  return listFlows(roots);
}

export async function deleteAgent(
  roots: DefinitionRoots,
  params: DeleteParams,
): Promise<FlowsList> {
  const root = requireDefinitionRoot(roots, params.source);
  await withWorkspaceLock(root, () => applyDelete(roots, params));
  return listFlows(roots);
}
