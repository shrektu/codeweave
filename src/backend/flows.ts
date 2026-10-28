import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseAgentDocuments,
  parseFlowFile,
  validateFlow,
  type AgentDefinition,
  type FlowDefinition,
  type ParseResult,
} from "../domain/flows";
import type {
  AgentView,
  FlowFileError,
  FlowsList,
  FlowView,
} from "../shared/views";

const FLOWS_DIR = "flows";
const AGENTS_DIR = "agents";
const MARKDOWN_EXTENSION = ".md";

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
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION),
      )
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
  id,
  role,
  provider,
  permissionProfile,
}: AgentDefinition): AgentView {
  return { id, role, provider, permissionProfile };
}

function flowView({ id, title, nodes, edges }: FlowDefinition): FlowView {
  return { id, title, nodes, edges };
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

function deduplicate(
  valid: readonly ParsedFile<FlowDefinition>[],
): Deduplicated {
  const firstFiles = new Map<string, string>();
  const flows: FlowView[] = [];
  const errors: FlowFileError[] = [];
  for (const { file, value } of valid) {
    const firstFile = firstFiles.get(value.id);
    if (firstFile === undefined) {
      firstFiles.set(value.id, file);
      flows.push(flowView(value));
    } else {
      errors.push(duplicateIdError(file, value.id, firstFile));
    }
  }
  return { flows, errors };
}

export async function listFlows(cwd: string): Promise<FlowsList> {
  const [flowFiles, agentFiles] = await Promise.all([
    loadDir(cwd, FLOWS_DIR, parseFlowFile),
    loadDir(cwd, AGENTS_DIR, parseAgentDocuments),
  ]);
  const agents = agentFiles.files.flatMap(({ value }) => value);
  const validated = flowFiles.files.map(({ file, value }) => ({
    file,
    flow: value,
    messages: validateFlow(value, agents),
  }));
  const unique = deduplicate(
    validated
      .filter(({ messages }) => messages.length === 0)
      .map(({ file, flow }) => ({ file, value: flow })),
  );
  return {
    flows: unique.flows,
    agents: agents.map(agentView),
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
