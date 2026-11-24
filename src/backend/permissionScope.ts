import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveTarget, type PermissionContext } from "../domain/pathScope";
import type { PermissionQuery } from "../domain/permissionPolicy";

import { MISSING_PATH_ERRNO_CODES, NOT_A_LINK_ERRNO_CODE } from "./constants";

const MAX_LINK_DEPTH = 40;

export interface PermissionScopeInput {
  readonly worktreeRoot: string;
  readonly homeDir: string;
  readonly protectedPaths: readonly string[];
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    MISSING_PATH_ERRNO_CODES.includes(error.code)
  );
}

async function linkTarget(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch (error) {
    if (isMissingPath(error) || isNotLink(error)) {
      return null;
    }
    throw error;
  }
}

function isNotLink(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === NOT_A_LINK_ERRNO_CODE
  );
}

export async function realLocation(path: string, depth = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
  const target = depth < MAX_LINK_DEPTH ? await linkTarget(path) : null;
  if (target !== null) {
    return realLocation(resolve(dirname(path), target), depth + 1);
  }
  const parent = dirname(path);
  return parent === path
    ? path
    : join(await realLocation(parent, depth), basename(path));
}

export async function realPermissionContext(
  input: PermissionScopeInput,
): Promise<PermissionContext> {
  const [realRoot, homeDir, real] = await Promise.all([
    realLocation(input.worktreeRoot),
    realLocation(input.homeDir),
    Promise.all(input.protectedPaths.map((path) => realLocation(path))),
  ]);
  return {
    worktreeRoots:
      realRoot === input.worktreeRoot
        ? [input.worktreeRoot]
        : [input.worktreeRoot, realRoot],
    homeDir,
    protectedPaths: [...new Set([...input.protectedPaths, ...real])],
  };
}

async function spellingsOf(
  path: string,
  ctx: PermissionContext,
): Promise<string[]> {
  const absolute = resolveTarget(path, ctx, ctx.worktreeRoots[0]);
  return absolute === null ? [path] : [absolute, await realLocation(absolute)];
}

export async function realEditPaths(
  paths: readonly string[],
  ctx: PermissionContext,
): Promise<string[]> {
  const spellings = await Promise.all(
    paths.map((path) => spellingsOf(path, ctx)),
  );
  return [...new Set(spellings.flat())];
}

export async function withRealPaths(
  query: PermissionQuery,
  ctx: PermissionContext,
): Promise<PermissionQuery> {
  if (query.kind === "edit" && query.paths !== undefined) {
    return { ...query, paths: await realEditPaths(query.paths, ctx) };
  }
  if (query.kind === "execute" && query.cwd !== undefined) {
    return { ...query, cwd: await realLocation(query.cwd) };
  }
  return query;
}
