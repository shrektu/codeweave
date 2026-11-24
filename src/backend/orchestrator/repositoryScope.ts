import { posix, win32, type PlatformPath } from "node:path";

import {
  isProtectedPath,
  isWithinRoot,
  resolveTarget,
  type PermissionContext,
} from "../../domain/pathScope";
import {
  CASE_FOLDED_PLATFORMS,
  WIN32_PLATFORM,
} from "../../domain/permissionRules";
import type { WorktreeState } from "../../domain/types";
import { IpcError, IpcErrorCode } from "../../shared/protocol";
import { realLocation, realPermissionContext } from "../permissionScope";

import {
  NUL_CHARACTER,
  REPOSITORY_INVALID_MESSAGE,
  REPOSITORY_OUTSIDE_MESSAGE,
  REPOSITORY_PROTECTED_MESSAGE,
  REPOSITORY_UNREADABLE_MESSAGE,
} from "./constants";

export interface RepositoryScopeDeps {
  readonly sessionCwd: () => string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
  readonly protectedPaths: () => Promise<readonly string[]>;
  readonly resolveProjectRoot: (cwd: string) => Promise<string>;
}

export interface RepositoryScope {
  resolveRepository(repository: string): Promise<string>;
  sessionExclusivityKey(): Promise<string>;
}

function validation(message: string): IpcError {
  return new IpcError(IpcErrorCode.VALIDATION, message);
}

function pathFlavor(platform: NodeJS.Platform): PlatformPath {
  return platform === WIN32_PLATFORM ? win32 : posix;
}

export function repositoryKey(
  resolvedPath: string,
  platform: NodeJS.Platform,
): string {
  const normalized = pathFlavor(platform).resolve(resolvedPath);
  return CASE_FOLDED_PLATFORMS.includes(platform)
    ? normalized.toLowerCase()
    : normalized;
}

export function resolveLexicalRepository(
  raw: string,
  ctx: PermissionContext,
  cwd: string,
  platform: NodeJS.Platform,
): string {
  if (raw.trim() === "" || raw.includes(NUL_CHARACTER)) {
    throw validation(REPOSITORY_INVALID_MESSAGE);
  }
  const resolved = resolveTarget(raw, ctx, cwd, platform);
  if (resolved === null) {
    throw validation(REPOSITORY_INVALID_MESSAGE);
  }
  return resolved;
}

export function assertAllowedRepositoryPath(
  resolved: string,
  ctx: PermissionContext,
  platform: NodeJS.Platform,
): void {
  if (isProtectedPath(resolved, ctx.protectedPaths, platform)) {
    throw validation(REPOSITORY_PROTECTED_MESSAGE);
  }
  if (!isWithinRoot(resolved, ctx, null, platform)) {
    throw validation(REPOSITORY_OUTSIDE_MESSAGE);
  }
}

class SessionRepositoryScope implements RepositoryScope {
  private readonly deps: RepositoryScopeDeps;
  private permissionRoot: Promise<string> | null = null;

  constructor(deps: RepositoryScopeDeps) {
    this.deps = deps;
  }

  async resolveRepository(repository: string): Promise<string> {
    const { platform } = this.deps;
    const cwd = this.deps.sessionCwd();
    const ctx = await this.context();
    const lexical = resolveLexicalRepository(
      repository,
      ctx,
      await realLocation(cwd),
      platform,
    );
    assertAllowedRepositoryPath(lexical, ctx, platform);
    const real = await this.realPath(lexical);
    assertAllowedRepositoryPath(real, ctx, platform);
    const toplevel = await this.realPath(
      await this.deps.resolveProjectRoot(real),
    );
    assertAllowedRepositoryPath(toplevel, ctx, platform);
    return toplevel;
  }

  async sessionExclusivityKey(): Promise<string> {
    return repositoryKey(
      await realLocation(await this.rootOfSession()),
      this.deps.platform,
    );
  }

  private async realPath(path: string): Promise<string> {
    try {
      return await realLocation(path);
    } catch (error) {
      console.warn(`cannot resolve repository path: ${path}`, error);
      throw validation(REPOSITORY_UNREADABLE_MESSAGE);
    }
  }

  private async context(): Promise<PermissionContext> {
    const root = await this.rootOfSession();
    return realPermissionContext({
      worktreeRoot: root,
      homeDir: this.deps.homeDir,
      protectedPaths: await this.deps.protectedPaths(),
    });
  }

  private async rootOfSession(): Promise<string> {
    this.permissionRoot ??= this.deps
      .inspectWorktree(this.deps.sessionCwd())
      .then((worktree) => (worktree.isRepo ? worktree.root : worktree.cwd));
    try {
      return await this.permissionRoot;
    } catch (error) {
      this.permissionRoot = null;
      throw error;
    }
  }
}

export function createRepositoryScope(
  deps: RepositoryScopeDeps,
): RepositoryScope {
  return new SessionRepositoryScope(deps);
}
