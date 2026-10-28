import path, { type PlatformPath } from "node:path";

import type { WorktreeState } from "../domain/types";

import { GIT_BINARY } from "./constants";
import { execText } from "./exec";

function git(cwd: string, args: readonly string[]): Promise<string> {
  return execText(GIT_BINARY, ["-C", cwd, ...args]);
}

export function normalizeGitRoot(
  output: string,
  pathApi: PlatformPath,
): string {
  return pathApi.normalize(output.trim());
}

export async function inspectWorktree(cwd: string): Promise<WorktreeState> {
  let root: string;
  try {
    root = normalizeGitRoot(
      await git(cwd, ["rev-parse", "--show-toplevel"]),
      path,
    );
  } catch (error) {
    console.warn(`not a git worktree: ${cwd}`, error);
    return { isRepo: false, cwd };
  }
  const [porcelain, diffStat] = await Promise.all([
    git(root, ["status", "--porcelain"]),
    git(root, ["diff", "--stat"]),
  ]);
  return { isRepo: true, root, porcelain, diffStat };
}
