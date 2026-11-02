import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

import {
  AGENTS_DIR_NAME,
  AGENTS_DIR_TEAMWORK_SUBDIR,
  WORKSPACE_CONFIG_CHANGED_MESSAGE,
  WORKSPACE_WALK_LIMIT_MESSAGE,
  WORKSPACE_WALK_MAX_BYTES,
  WORKSPACE_WALK_MAX_DEPTH,
  WORKSPACE_WALK_MAX_ENTRIES,
} from "./constants";

const MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ELOOP"]);
const HASH_ALGORITHM = "sha256";
const HASH_ENCODING = "hex";
const FIELD_SEPARATOR = "\0";
const LINE_SEPARATOR = "\n";
const ROOT_RELATIVE_PATH = "";
const KIND_DIRECTORY = "dir";
const KIND_FILE = "file";
const KIND_LINK = "link";
const KIND_REFERENCE = "ref";
const KIND_GONE = "gone";
const KIND_OTHER = "other";

export interface GuardLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
}

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  maxEntries: WORKSPACE_WALK_MAX_ENTRIES,
  maxBytes: WORKSPACE_WALK_MAX_BYTES,
  maxDepth: WORKSPACE_WALK_MAX_DEPTH,
};

interface WalkState {
  readonly limits: GuardLimits;
  readonly visited: Set<string>;
  entries: number;
  bytes: number;
}

export class WorkspaceConfigChangedError extends Error {
  constructor() {
    super(WORKSPACE_CONFIG_CHANGED_MESSAGE);
    this.name = "WorkspaceConfigChangedError";
  }
}

export class WorkspaceWalkLimitError extends Error {
  constructor() {
    super(WORKSPACE_WALK_LIMIT_MESSAGE);
    this.name = "WorkspaceWalkLimitError";
  }
}

function sha256(data: string | Buffer): string {
  return createHash(HASH_ALGORITHM).update(data).digest(HASH_ENCODING);
}

function isMissing(error: unknown): boolean {
  const code: unknown =
    error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && MISSING_CODES.has(code);
}

function line(...fields: string[]): string {
  return fields.join(FIELD_SEPARATOR);
}

function countEntries(state: WalkState, count: number): void {
  state.entries += count;
  if (state.entries > state.limits.maxEntries) {
    throw new WorkspaceWalkLimitError();
  }
}

function countBytes(state: WalkState, size: number): void {
  state.bytes += size;
  if (state.bytes > state.limits.maxBytes) {
    throw new WorkspaceWalkLimitError();
  }
}

async function describeDirectory(
  location: string,
  relativePath: string,
  state: WalkState,
  depth: number,
): Promise<string[]> {
  if (depth > state.limits.maxDepth) {
    throw new WorkspaceWalkLimitError();
  }
  const atRoot = relativePath === ROOT_RELATIVE_PATH;
  const names = (await readdir(location))
    .filter((name) => !atRoot || name !== AGENTS_DIR_TEAMWORK_SUBDIR)
    .toSorted();
  countEntries(state, names.length);
  const lines = atRoot ? [] : [line(relativePath, KIND_DIRECTORY)];
  await names.reduce(
    (previous, name) =>
      previous.then(async () => {
        const described = await describePath(
          join(location, name),
          join(relativePath, name),
          state,
          depth + 1,
        );
        lines.push(...described);
      }),
    Promise.resolve(),
  );
  return lines;
}

async function describeResolved(
  location: string,
  relativePath: string,
  info: Stats,
  state: WalkState,
  depth: number,
): Promise<string[]> {
  if (state.visited.has(location)) {
    return [line(relativePath, KIND_REFERENCE, location)];
  }
  state.visited.add(location);
  if (info.isDirectory()) {
    return describeDirectory(location, relativePath, state, depth);
  }
  if (info.isFile()) {
    countBytes(state, info.size);
    return [line(relativePath, KIND_FILE, sha256(await readFile(location)))];
  }
  return [line(relativePath, KIND_OTHER)];
}

async function describeLink(
  location: string,
  relativePath: string,
  state: WalkState,
  depth: number,
): Promise<string[]> {
  const head = line(relativePath, KIND_LINK, await readlink(location));
  try {
    const target = await realpath(location);
    return [
      head,
      ...(await describeResolved(
        target,
        relativePath,
        await stat(target),
        state,
        depth,
      )),
    ];
  } catch (error) {
    if (isMissing(error)) {
      return [head];
    }
    throw error;
  }
}

async function describePath(
  location: string,
  relativePath: string,
  state: WalkState,
  depth: number,
): Promise<string[]> {
  try {
    const info = await lstat(location);
    return info.isSymbolicLink()
      ? await describeLink(location, relativePath, state, depth)
      : await describeResolved(location, relativePath, info, state, depth);
  } catch (error) {
    if (isMissing(error)) {
      return [line(relativePath, KIND_GONE)];
    }
    throw error;
  }
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) {
      return path;
    }
    throw error;
  }
}

export async function fingerprintAgentsDir(
  worktreeRoot: string,
  limits: GuardLimits = DEFAULT_GUARD_LIMITS,
): Promise<string> {
  const state: WalkState = { limits, visited: new Set(), entries: 0, bytes: 0 };
  countEntries(state, 1);
  const lines = await describePath(
    join(await realOrSelf(worktreeRoot), AGENTS_DIR_NAME),
    ROOT_RELATIVE_PATH,
    state,
    0,
  );
  const missingRoot =
    lines.length === 1 && lines[0] === line(ROOT_RELATIVE_PATH, KIND_GONE);
  return sha256(missingRoot ? "" : lines.join(LINE_SEPARATOR));
}
