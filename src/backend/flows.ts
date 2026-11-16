import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
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
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type {
  AgentView,
  FlowFileError,
  FlowsList,
  FlowView,
} from "../shared/views";

import { replaceFileAtomically } from "./atomicFile";
import { KeyedMutex } from "./keyedMutex";

const FLOWS_DIR = "flows";
const AGENTS_DIR = "agents";
const MARKDOWN_EXTENSION = ".md";

const FLOW_PREFIX = `${FLOWS_DIR}/`;
const FORBIDDEN_NAME_CHARS = ["/", "\\", "\0"] as const;

function isMarkdownName(name: string): boolean {
  return name.endsWith(MARKDOWN_EXTENSION);
}

function isFlowFile(file: string): boolean {
  const name = file.slice(FLOW_PREFIX.length);
  return (
    file.startsWith(FLOW_PREFIX) &&
    isMarkdownName(name) &&
    FORBIDDEN_NAME_CHARS.every((char) => !name.includes(char))
  );
}
const PARENT_SEGMENT = "..";

interface LoadedFlow {
  readonly definition: FlowDefinition;
  readonly revision: string;
}

interface SaveFlowParams {
  readonly file: string;
  readonly revision: string;
  readonly flow: FlowDefinition;
}

type LoadedFile<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FlowFileError };

interface ParsedFile<T> {
  readonly file: string;
  readonly value: T;
}

interface LoadedDir<T> {
  readonly files: ParsedFile<T>[];
  readonly errors: FlowFileError[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(file: string, error: unknown): FlowFileError {
  return { file, messages: [errorText(error)] };
}

async function markdownNames(
  cwd: string,
  dir: string,
): Promise<LoadedFile<string[]>> {
  try {
    const entries = await readdir(join(cwd, dir), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && isMarkdownName(entry.name))
      .map((entry) => entry.name)
      .toSorted();
    return { ok: true, value: names };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, value: [] };
    }
    return { ok: false, error: failure(dir, error) };
  }
}

async function loadDir<T>(
  cwd: string,
  dir: string,
  parse: (markdown: string) => ParseResult<T>,
): Promise<LoadedDir<T>> {
  const names = await markdownNames(cwd, dir);
  if (!names.ok) {
    return { files: [], errors: [names.error] };
  }
  const loaded = await Promise.all(
    names.value.map(async (name): Promise<LoadedFile<ParsedFile<T>>> => {
      const file = `${dir}/${name}`;
      try {
        const parsed = parse(await readFile(join(cwd, file), "utf8"));
        return parsed.ok
          ? { ok: true, value: { file, value: parsed.value } }
          : { ok: false, error: { file, messages: parsed.errors } };
      } catch (error) {
        return { ok: false, error: failure(file, error) };
      }
    }),
  );
  return {
    files: loaded.flatMap((item) => (item.ok ? [item.value] : [])),
    errors: loaded.flatMap((item) => (item.ok ? [] : [item.error])),
  };
}

function agentView({
  definition: { id, role, provider, permissionProfile },
  body,
}: AgentDocument): AgentView {
  return { id, role, provider, permissionProfile, body };
}

export function flowRevision(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function parseLoadedFlow(markdown: string): ParseResult<LoadedFlow> {
  const parsed = parseFlowFile(markdown);
  return parsed.ok
    ? {
        ok: true,
        value: {
          definition: parsed.value,
          revision: flowRevision(markdown),
        },
      }
    : parsed;
}

function flowView(
  file: string,
  { definition, revision }: LoadedFlow,
): FlowView {
  return {
    id: definition.id,
    file,
    revision,
    title: definition.title,
    maxRounds: definition.maxRounds ?? DEFAULT_FLOW_ROUNDS,
    nodes: definition.nodes.map(({ id, agent, provider }) => ({
      id,
      agent,
      provider: provider ?? null,
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
  file: string,
  id: string,
  firstFile: string,
): FlowFileError {
  return {
    file,
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
  for (const { file, value } of valid) {
    const { id } = value.definition;
    const firstFile = firstFiles.get(id);
    if (firstFile === undefined) {
      firstFiles.set(id, file);
      flows.push(flowView(file, value));
    } else {
      errors.push(duplicateIdError(file, id, firstFile));
    }
  }
  return { flows, errors };
}

export async function listFlows(cwd: string): Promise<FlowsList> {
  const [flowFiles, agentFiles] = await Promise.all([
    loadDir(cwd, FLOWS_DIR, parseLoadedFlow),
    loadDir(cwd, AGENTS_DIR, parseAgentDocuments),
  ]);
  const documents = agentFiles.files.flatMap(({ value }) => value);
  const agents = documents.map(({ definition }) => definition);
  const validated = flowFiles.files.map(({ file, value }) => ({
    file,
    loaded: value,
    messages: validateFlow(value.definition, agents),
  }));
  const unique = deduplicate(
    validated
      .filter(({ messages }) => messages.length === 0)
      .map(({ file, loaded }) => ({ file, value: loaded })),
  );
  return {
    flows: unique.flows,
    agents: documents.map(agentView),
    errors: [
      ...flowFiles.errors,
      ...validated
        .filter(({ messages }) => messages.length > 0)
        .map(({ file, messages }) => ({ file, messages })),
      ...unique.errors,
      ...agentFiles.errors,
    ],
  };
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  const escapesParent =
    path === PARENT_SEGMENT ||
    path.startsWith(`${PARENT_SEGMENT}${sep}`) ||
    path.startsWith(`${PARENT_SEGMENT}/`);
  return path !== "" && !escapesParent && !isAbsolute(path);
}

async function resolveFlowFile(cwd: string, file: string): Promise<string> {
  if (!isFlowFile(file)) {
    throw new IpcError(
      IpcErrorCode.VALIDATION,
      `Flow file must be a .md file directly in ${FLOWS_DIR}/`,
    );
  }
  try {
    const [flowsDir, target] = await Promise.all([
      realpath(join(cwd, FLOWS_DIR)),
      realpath(join(cwd, file)),
    ]);
    if (!isInside(flowsDir, target)) {
      throw new IpcError(
        IpcErrorCode.VALIDATION,
        `Flow file must stay inside ${FLOWS_DIR}/`,
      );
    }
    return target;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Flow file ${file} not found`);
    }
    throw error;
  }
}

const saveLocks = new KeyedMutex();

async function applyFlowSave(
  cwd: string,
  target: string,
  { revision, flow }: SaveFlowParams,
): Promise<void> {
  const current = await readFile(target, "utf8");
  if (flowRevision(current) !== revision) {
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
  const agentFiles = await loadDir(cwd, AGENTS_DIR, parseAgentDocuments);
  const agents = agentFiles.files.flatMap(({ value }) =>
    value.map(({ definition }) => definition),
  );
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
  cwd: string,
  params: SaveFlowParams,
): Promise<FlowsList> {
  const target = await resolveFlowFile(cwd, params.file);
  await saveLocks.run(target, () => applyFlowSave(cwd, target, params));
  return listFlows(cwd);
}
