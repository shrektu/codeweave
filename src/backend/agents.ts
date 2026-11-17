import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type { AgentView, FlowsList } from "../shared/views";

import { replaceFileAtomically } from "./atomicFile";
import {
  AGENTS_DIR,
  contentRevision,
  isInside,
  listFlows,
  MARKDOWN_EXTENSION,
  resolveDefinitionFile,
  withWorkspaceLock,
} from "./flows";

const TEMP_SUFFIX = ".tmp";
const STALE_MESSAGE = "The agent file changed on disk";
const ESCAPING_DIR_MESSAGE = `${AGENTS_DIR}/ must stay inside the project`;

type CreateParams = Omit<ParamsMap["agents/create"], "cwd">;
type SaveParams = Omit<ParamsMap["agents/save"], "cwd">;
type DeleteParams = Omit<ParamsMap["agents/delete"], "cwd">;

interface CurrentFile {
  readonly target: string;
  readonly text: string;
  readonly documents: AgentDocument[];
  readonly list: FlowsList;
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

async function ensureAgentsDir(cwd: string): Promise<string> {
  await mkdir(join(cwd, AGENTS_DIR), { recursive: true });
  const [root, agentsDir] = await Promise.all([
    realpath(cwd),
    realpath(join(cwd, AGENTS_DIR)),
  ]);
  if (!isInside(root, agentsDir)) {
    throw validation(ESCAPING_DIR_MESSAGE);
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
  const temp = `${target}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    await writeFile(temp, text);
    await link(temp, target);
    return target;
  } catch (error) {
    if (isExisting(error)) {
      throw validation(`An agent file named ${name} already exists`);
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
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
  id: string,
): AgentView {
  const found = list.agents.find(
    (agent) => agent.file === file && agent.id === id,
  );
  if (found === undefined) {
    throw notFound(file, id);
  }
  return found;
}

async function loadCurrent(
  cwd: string,
  { file, id, revision }: Pick<SaveParams, "file" | "id" | "revision">,
): Promise<CurrentFile> {
  const target = await resolveDefinitionFile(cwd, AGENTS_DIR, file);
  const text = await readFile(target, "utf8");
  if (contentRevision(text) !== revision) {
    throw new IpcError(IpcErrorCode.CONFLICT, STALE_MESSAGE);
  }
  const documents = unwrap(parseAgentDocuments(text));
  const list = await listFlows(cwd);
  return { target, text, documents, list, agent: listedAgent(list, file, id) };
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
  { documents, list }: CurrentFile,
  file: string,
  id: string,
): string[] {
  return [
    ...list.agents.filter((agent) => agent.file !== file).map(({ id }) => id),
    ...documents
      .map(({ definition }) => definition.id)
      .filter((other) => other !== id),
  ];
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

async function applySave(cwd: string, params: SaveParams): Promise<void> {
  const { file, id, agent, body } = params;
  const current = await loadCurrent(cwd, params);
  findDocument(current, file, id);
  assertValid(validateAgent(agent, body, otherIds(current, file, id)));
  if (agent.id !== id) {
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

async function applyDelete(cwd: string, params: DeleteParams): Promise<void> {
  const { file, id } = params;
  const current = await loadCurrent(cwd, params);
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
  cwd: string,
  { agent, body }: CreateParams,
): Promise<FlowsList> {
  await withWorkspaceLock(cwd, async () => {
    const { agents } = await listFlows(cwd);
    assertValid(
      validateAgent(
        agent,
        body,
        agents.map(({ id }) => id),
      ),
    );
    const agentsDir = await ensureAgentsDir(cwd);
    await createExclusively(agentsDir, agent.id, newAgentFile(agent, body));
  });
  return listFlows(cwd);
}

export async function saveAgent(
  cwd: string,
  params: SaveParams,
): Promise<FlowsList> {
  await withWorkspaceLock(cwd, () => applySave(cwd, params));
  return listFlows(cwd);
}

export async function deleteAgent(
  cwd: string,
  params: DeleteParams,
): Promise<FlowsList> {
  await withWorkspaceLock(cwd, () => applyDelete(cwd, params));
  return listFlows(cwd);
}
