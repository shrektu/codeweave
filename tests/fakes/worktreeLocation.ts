import type { PlatformPath } from "node:path";

export function isWorktreeUnder(
  worktree: string,
  directory: string,
  prefix: string,
  pathApi: PlatformPath,
): boolean {
  const relative = pathApi.relative(
    pathApi.normalize(directory),
    pathApi.normalize(worktree),
  );
  const isDirectChild =
    relative !== "" &&
    !relative.includes(pathApi.sep) &&
    !pathApi.isAbsolute(relative);
  return isDirectChild && relative.startsWith(prefix);
}
