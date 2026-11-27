import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isProtectedPath } from "../domain/pathScope";
import {
  FILE_COMPLETION_LIMIT,
  FILE_INDEX_CACHE_MAX_ENTRIES,
  FILE_INDEX_GIT_TIMEOUT_MS,
  FILE_INDEX_TTL_MS,
} from "../shared/constants";
import type { FileCompletionItem, FileKind } from "../shared/views";

const DIR_KIND: FileKind = "dir";
const FILE_KIND: FileKind = "file";
const PATH_SEPARATOR = "/";
const NUL_SEPARATOR = "\0";
const EMPTY_QUERY = "";
const HIDDEN_PREFIX = ".";
const PARENT_DIR = "..";
const GIT_TOP_LEVEL_ARGS = ["rev-parse", "--show-toplevel"] as const;
const GIT_LIST_ARGS = [
  "ls-files",
  "-z",
  "-s",
  "--cached",
  "--others",
  "--exclude-standard",
] as const;
const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";
const CACHED_ENTRY_PATTERN =
  /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) (\d+)\t([\s\S]+)$/;
const LISTING_UNAVAILABLE_CODES: readonly string[] = [
  "ENOENT",
  "ENOTDIR",
  "EACCES",
];
const DEFAULT_FS: FileCompletionFs = { lstat, realpath };

export interface FileCompletionFs {
  readonly lstat: (target: string) => Promise<Stats>;
  readonly realpath: (target: string) => Promise<string>;
}

export interface FileCompletionDeps {
  readonly git: (
    cwd: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string>;
  readonly homeDir: string;
  readonly protectedPaths: () => Promise<readonly string[]>;
  readonly now: () => number;
  readonly fs?: FileCompletionFs;
}

export interface FileCompletion {
  complete(
    cwd: string | undefined,
    query: string,
  ): Promise<FileCompletionItem[]>;
}

interface QueryParts {
  readonly dirPart: string;
  readonly namePart: string;
}

interface CompletionRoots {
  readonly base: string;
  readonly realBase: string;
}

interface CachedIndex {
  readonly items: readonly GitIndexEntry[] | null;
  readonly builtAt: number;
}

interface GitIndexEntry {
  readonly item: FileCompletionItem;
  readonly checkLink: boolean;
}

interface RankedItem {
  readonly entry: GitIndexEntry;
  readonly rank: number;
}

function isListingUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    LISTING_UNAVAILABLE_CODES.includes(error.code)
  );
}

function isWithin(base: string, target: string): boolean {
  const relation = path.relative(base, target);
  return (
    relation === "" ||
    (relation !== PARENT_DIR &&
      !relation.startsWith(`${PARENT_DIR}${path.sep}`) &&
      !path.isAbsolute(relation))
  );
}

function splitQuery(query: string): QueryParts {
  const index = query.lastIndexOf(PATH_SEPARATOR);
  return index === -1
    ? { dirPart: "", namePart: query }
    : { dirPart: query.slice(0, index + 1), namePart: query.slice(index + 1) };
}

function ancestorDirs(file: string): string[] {
  const parts = file.split(PATH_SEPARATOR);
  const dirs: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    dirs.push(parts.slice(0, index).join(PATH_SEPARATOR));
  }
  return dirs;
}

function parseGitEntry(entry: string): GitIndexEntry | null {
  const cached = CACHED_ENTRY_PATTERN.exec(entry);
  if (cached !== null) {
    const mode = cached[1];
    const itemPath = cached[4] ?? "";
    if (itemPath === "") {
      return null;
    }
    return {
      item: {
        path: itemPath,
        kind: mode === GITLINK_MODE ? DIR_KIND : FILE_KIND,
      },
      checkLink: mode === SYMLINK_MODE,
    };
  }
  const isDir = entry.endsWith(PATH_SEPARATOR);
  const itemPath = isDir ? entry.slice(0, -1) : entry;
  if (itemPath === "") {
    return null;
  }
  return {
    item: { path: itemPath, kind: isDir ? DIR_KIND : FILE_KIND },
    checkLink: !isDir,
  };
}

async function readGitIndex(
  git: FileCompletionDeps["git"],
  base: string,
): Promise<readonly GitIndexEntry[]> {
  await git(base, GIT_TOP_LEVEL_ARGS, FILE_INDEX_GIT_TIMEOUT_MS);
  const listing = await git(base, GIT_LIST_ARGS, FILE_INDEX_GIT_TIMEOUT_MS);
  const items = new Map<string, GitIndexEntry>();
  for (const entry of listing.split(NUL_SEPARATOR)) {
    const parsed = parseGitEntry(entry);
    if (parsed === null) {
      continue;
    }
    items.set(parsed.item.path, parsed);
    for (const dir of ancestorDirs(parsed.item.path)) {
      items.set(dir, { item: { path: dir, kind: DIR_KIND }, checkLink: false });
    }
  }
  return [...items.values()];
}

function includesCodePoints(haystack: string, needle: string): boolean {
  const target = Array.from(needle);
  const source = Array.from(haystack);
  for (let index = 0; index + target.length <= source.length; index += 1) {
    if (target.every((char, offset) => source[index + offset] === char)) {
      return true;
    }
  }
  return false;
}

function isSubsequence(needle: string, haystack: string): boolean {
  const wanted = Array.from(needle);
  let position = 0;
  for (const char of haystack) {
    if (position === wanted.length) {
      break;
    }
    if (char === wanted[position]) {
      position += 1;
    }
  }
  return position === wanted.length;
}

function basenameOf(itemPath: string): string {
  return itemPath.slice(itemPath.lastIndexOf(PATH_SEPARATOR) + 1);
}

function rankOf(itemPath: string, needle: string): number {
  if (includesCodePoints(basenameOf(itemPath).toLowerCase(), needle)) {
    return 0;
  }
  return includesCodePoints(itemPath.toLowerCase(), needle) ? 1 : 2;
}

function byLengthThenPath(
  left: FileCompletionItem,
  right: FileCompletionItem,
): number {
  return (
    left.path.length - right.path.length || left.path.localeCompare(right.path)
  );
}

function byKindThenPath(
  left: FileCompletionItem,
  right: FileCompletionItem,
): number {
  if (left.kind !== right.kind) {
    return left.kind === DIR_KIND ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function topLevel(entries: readonly GitIndexEntry[]): GitIndexEntry[] {
  return entries
    .filter(({ item }) => !item.path.includes(PATH_SEPARATOR))
    .toSorted((left, right) => byKindThenPath(left.item, right.item));
}

function matchIndex(
  entries: readonly GitIndexEntry[],
  query: string,
): GitIndexEntry[] {
  if (query === EMPTY_QUERY) {
    return topLevel(entries);
  }
  const needle = query.toLowerCase();
  return entries
    .filter(({ item }) => isSubsequence(needle, item.path.toLowerCase()))
    .map((entry): RankedItem => ({
      entry,
      rank: rankOf(entry.item.path, needle),
    }))
    .toSorted(
      (left, right) =>
        left.rank - right.rank ||
        byLengthThenPath(left.entry.item, right.entry.item),
    )
    .map(({ entry }) => entry);
}

async function kindOf(
  entry: Dirent,
  fullPath: string,
): Promise<FileKind | null> {
  if (!entry.isSymbolicLink()) {
    return entry.isDirectory() ? DIR_KIND : FILE_KIND;
  }
  const target = await stat(fullPath).catch((error: unknown) => {
    console.warn(`skipping an unreadable symlink entry: ${fullPath}`, error);
    return null;
  });
  if (target === null) {
    return null;
  }
  return target.isDirectory() ? DIR_KIND : FILE_KIND;
}

async function linkTargetIsProtected(
  linkPath: string,
  patterns: readonly string[],
): Promise<boolean> {
  const target = await realpath(linkPath).catch((error: unknown) => {
    if (!isListingUnavailable(error)) {
      console.warn(`skipping an unreadable symlink entry: ${linkPath}`, error);
    }
    return null;
  });
  return target === null || isProtectedPath(target, patterns);
}

async function listDirectory(
  base: string,
  parts: QueryParts,
  patterns: readonly string[],
): Promise<FileCompletionItem[]> {
  const dir = path.join(base, parts.dirPart);
  const realDir = await realpath(dir).catch((error: unknown) => {
    if (!isListingUnavailable(error)) {
      console.warn("file completion could not resolve a directory", error);
    }
    return null;
  });
  if (realDir === null || isProtectedPath(realDir, patterns)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isListingUnavailable(error)) {
        return [];
      }
      throw error;
    },
  );
  const namePart = parts.namePart.toLowerCase();
  const showHidden = namePart.startsWith(HIDDEN_PREFIX);
  const candidates = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(namePart) &&
      (showHidden || !entry.name.startsWith(HIDDEN_PREFIX)),
  );
  const items = await Promise.all(
    candidates.map(async (entry): Promise<FileCompletionItem | null> => {
      const lexical = path.join(dir, entry.name);
      const resolved = path.join(realDir, entry.name);
      if (
        isProtectedPath(lexical, patterns) ||
        isProtectedPath(resolved, patterns)
      ) {
        return null;
      }
      if (
        entry.isSymbolicLink() &&
        (await linkTargetIsProtected(lexical, patterns))
      ) {
        return null;
      }
      const kind = await kindOf(entry, lexical);
      return kind === null
        ? null
        : { path: `${parts.dirPart}${entry.name}`, kind };
    }),
  );
  return items.filter((item) => item !== null).toSorted(byKindThenPath);
}

function visibleItems(
  base: string,
  realBase: string,
  items: readonly FileCompletionItem[],
  patterns: readonly string[],
): FileCompletionItem[] {
  return items
    .filter(
      (item) =>
        !isProtectedPath(path.join(base, item.path), patterns) &&
        !isProtectedPath(path.join(realBase, item.path), patterns),
    )
    .slice(0, FILE_COMPLETION_LIMIT);
}

async function linkEntryIsProtected(
  fs: FileCompletionFs,
  fullPath: string,
  patterns: readonly string[],
): Promise<boolean> {
  const stats = await fs.lstat(fullPath).catch((error: unknown) => {
    if (!isListingUnavailable(error)) {
      console.warn(`file completion could not inspect ${fullPath}`, error);
    }
    return null;
  });
  if (stats?.isSymbolicLink() !== true) {
    return false;
  }
  const target = await fs.realpath(fullPath).catch((error: unknown) => {
    if (!isListingUnavailable(error)) {
      console.warn(`file completion could not resolve ${fullPath}`, error);
    }
    return null;
  });
  return target === null || isProtectedPath(target, patterns);
}

async function visibleGitItems(
  deps: FileCompletionDeps,
  roots: CompletionRoots,
  entries: readonly GitIndexEntry[],
  patterns: readonly string[],
): Promise<FileCompletionItem[]> {
  const fs = deps.fs ?? DEFAULT_FS;
  const accepted: FileCompletionItem[] = [];
  for (const { item, checkLink } of entries) {
    const relativePath = path.join(roots.realBase, item.path);
    if (
      isProtectedPath(path.join(roots.base, item.path), patterns) ||
      isProtectedPath(relativePath, patterns)
    ) {
      continue;
    }
    if (checkLink && (await linkEntryIsProtected(fs, relativePath, patterns))) {
      continue;
    }
    accepted.push(item);
    if (accepted.length >= FILE_COMPLETION_LIMIT) {
      break;
    }
  }
  return accepted;
}

interface IndexCache {
  indexFor(base: string): Promise<readonly GitIndexEntry[] | null>;
}

function createIndexCache(deps: FileCompletionDeps): IndexCache {
  const cached = new Map<string, CachedIndex>();
  const building = new Map<string, Promise<readonly GitIndexEntry[] | null>>();

  function trimCache(): void {
    const now = deps.now();
    for (const [key, entry] of cached) {
      if (now - entry.builtAt >= FILE_INDEX_TTL_MS) {
        cached.delete(key);
      }
    }
    while (cached.size > FILE_INDEX_CACHE_MAX_ENTRIES) {
      const oldest = cached.keys().next();
      if (oldest.done === true) {
        break;
      }
      cached.delete(oldest.value);
    }
  }

  function freshIndex(base: string): CachedIndex | null {
    const entry = cached.get(base);
    if (entry === undefined) {
      return null;
    }
    return deps.now() - entry.builtAt < FILE_INDEX_TTL_MS ? entry : null;
  }

  function indexFor(base: string): Promise<readonly GitIndexEntry[] | null> {
    trimCache();
    const fresh = freshIndex(base);
    if (fresh !== null) {
      return Promise.resolve(fresh.items);
    }
    const pending = building.get(base);
    if (pending !== undefined) {
      return pending;
    }
    const build = readGitIndex(deps.git, base)
      .catch((error: unknown) => {
        console.warn("file completion fell back to directory listing", error);
        return null;
      })
      .then((items) => {
        cached.set(base, { items, builtAt: deps.now() });
        trimCache();
        return items;
      });
    const tracked = build.finally(() => {
      building.delete(base);
    });
    building.set(base, tracked);
    return tracked;
  }

  return { indexFor };
}

async function completeWith(
  deps: FileCompletionDeps,
  index: IndexCache,
  cwd: string | undefined,
  query: string,
): Promise<FileCompletionItem[]> {
  const base = path.resolve(cwd ?? deps.homeDir);
  if (path.isAbsolute(query)) {
    return [];
  }
  const parts = splitQuery(query);
  if (!isWithin(base, path.resolve(base, parts.dirPart))) {
    return [];
  }
  const patterns = await deps.protectedPaths();
  const realBase = await realpath(base).catch((error: unknown) => {
    if (!isListingUnavailable(error)) {
      console.warn("file completion could not resolve the base", error);
    }
    return null;
  });
  if (realBase === null || isProtectedPath(realBase, patterns)) {
    return [];
  }
  const gitIndex = await index.indexFor(realBase);
  if (gitIndex === null) {
    const dirMatches = await listDirectory(base, parts, patterns);
    return visibleItems(base, realBase, dirMatches, patterns);
  }
  return visibleGitItems(
    deps,
    { base, realBase },
    matchIndex(gitIndex, query),
    patterns,
  );
}

export function createFileCompletion(deps: FileCompletionDeps): FileCompletion {
  const index = createIndexCache(deps);
  return {
    complete: (cwd, query) => completeWith(deps, index, cwd, query),
  };
}
