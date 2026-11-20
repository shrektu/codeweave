import { realpath } from "node:fs/promises";

import { GIT_BINARY } from "./constants";
import { execText } from "./exec";

export class WorktreeBusyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Worktree is already in use: ${key}`);
    this.key = key;
    this.name = "WorktreeBusyError";
  }
}

export const LeaseMode = {
  exclusive: "exclusive",
  observer: "observer",
} as const;
export type LeaseMode = (typeof LeaseMode)[keyof typeof LeaseMode];

export interface Lease {
  readonly key: string;
  release(): void;
}

export type LockKeyResolver = (cwd: string) => Promise<string>;

export async function resolveLockKey(cwd: string): Promise<string> {
  try {
    const top = await execText(GIT_BINARY, [
      "-C",
      cwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    return await realpath(top.trim());
  } catch (error) {
    console.warn(`not a git worktree, locking on path: ${cwd}`, error);
    return realpath(cwd);
  }
}

export class WorktreeLocks {
  private readonly held = new Map<string, symbol>();

  acquire(key: string, mode: LeaseMode = LeaseMode.exclusive): Lease {
    if (mode === LeaseMode.observer) {
      return { key, release: () => undefined };
    }
    if (this.held.has(key)) {
      throw new WorktreeBusyError(key);
    }
    const token = Symbol(key);
    this.held.set(key, token);
    return {
      key,
      release: () => {
        if (this.held.get(key) === token) {
          this.held.delete(key);
        }
      },
    };
  }
}
