import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { MergeStatus, type MergeOutcome } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import {
  BINARY_SNIFF_BYTES,
  CONFLICT_MARKER_OURS,
  CONFLICT_MARKER_SEPARATOR,
  CONFLICT_MARKER_THEIRS,
  FLOW_BRANCH_PREFIX,
  FLOW_RUN_SHORT_ID_LENGTH,
  FLOW_WORKTREE_INFIX,
  FLOW_WORKTREES_DIR,
  GIT_BINARY,
  GIT_REGULAR_MODE_PREFIX,
  MERGE_STAGE_OURS,
  MERGE_STAGE_THEIRS,
  NUL_BYTE,
  NUL_CHAR,
} from "./constants";
import type { ExecText } from "./exec";
import { normalizeGitRoot } from "./worktree";

export interface FlowWorktree {
  readonly runId: string;
  readonly projectRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
}

export type WorktreeGuard = (
  worktreesDir: string,
  worktreePath: string,
) => Promise<void>;

export interface FlowWorktrees {
  resolveProjectRoot(cwd: string): Promise<string>;
  create(
    projectCwd: string,
    runId: string,
    guard?: WorktreeGuard,
  ): Promise<FlowWorktree>;
  commitAll(worktree: FlowWorktree, message: string): Promise<string | null>;
  diff(worktree: FlowWorktree): Promise<string>;
  workingDiff(cwd: string): Promise<string>;
  isDirty(cwd: string): Promise<boolean>;
  merge(worktree: FlowWorktree): Promise<MergeOutcome>;
  finishMerge(worktree: FlowWorktree): Promise<MergeOutcome>;
  abortMerge(worktree: FlowWorktree): Promise<void>;
  remove(worktree: FlowWorktree): Promise<void>;
}

type Git = (dir: string, args: readonly string[]) => Promise<string>;

const GIT_EXIT_FALSE = 1;
const WORKTREE_PLACEMENT_MESSAGE =
  "The worktree was not created inside the worktrees directory";
const LINE_BREAK = /\r?\n/;
const UNTRACKED_FILES_HEADING = "Untracked files:";

function exitCode(error: unknown): number | undefined {
  if (error instanceof Error && "code" in error) {
    return typeof error.code === "number" ? error.code : undefined;
  }
  return undefined;
}

function isConflictMarker(line: string): boolean {
  return (
    line.startsWith(CONFLICT_MARKER_OURS) ||
    line === CONFLICT_MARKER_SEPARATOR ||
    line.startsWith(CONFLICT_MARKER_THEIRS)
  );
}

interface UnmergedEntry {
  readonly stages: Set<number>;
  regular: boolean;
}

async function readRegularFile(file: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(file)).isFile()) {
      return null;
    }
    return await readFile(file);
  } catch (error) {
    console.warn(`cannot read unmerged path: ${file}`, error);
    return null;
  }
}

function hasBothSides(stages: ReadonlySet<number>): boolean {
  return stages.has(MERGE_STAGE_OURS) && stages.has(MERGE_STAGE_THEIRS);
}

async function isUnresolved(
  file: string,
  entry: UnmergedEntry,
): Promise<boolean> {
  if (!entry.regular || !hasBothSides(entry.stages)) {
    return true;
  }
  const content = await readRegularFile(file);
  if (
    content === null ||
    content.subarray(0, BINARY_SNIFF_BYTES).includes(NUL_BYTE)
  ) {
    return true;
  }
  return content.toString("utf8").split(LINE_BREAK).some(isConflictMarker);
}

async function gitSucceeds(
  git: Git,
  dir: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await git(dir, args);
    return true;
  } catch (error) {
    if (exitCode(error) === GIT_EXIT_FALSE) {
      return false;
    }
    throw error;
  }
}

async function head(git: Git, dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

async function isDirty(git: Git, dir: string): Promise<boolean> {
  return (await git(dir, ["status", "--porcelain"])).trim() !== "";
}

function mergeInProgress(git: Git, dir: string): Promise<boolean> {
  return gitSucceeds(git, dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
}

async function unmergedStages(
  git: Git,
  dir: string,
): Promise<Map<string, UnmergedEntry>> {
  const entries = new Map<string, UnmergedEntry>();
  const output = await git(dir, ["ls-files", "-u", "-z"]);
  for (const line of output.split(NUL_CHAR)) {
    const tab = line.indexOf("\t");
    if (tab >= 0) {
      const file = line.slice(tab + 1);
      const [mode, , stage] = line.slice(0, tab).split(" ");
      const entry = entries.get(file) ?? { stages: new Set(), regular: true };
      entry.stages.add(Number(stage));
      entry.regular &&= mode?.startsWith(GIT_REGULAR_MODE_PREFIX) ?? false;
      entries.set(file, entry);
    }
  }
  return entries;
}

async function unmergedFiles(git: Git, dir: string): Promise<string[]> {
  return [...(await unmergedStages(git, dir)).keys()];
}

async function currentBranchRef(git: Git, dir: string): Promise<string> {
  try {
    return (await git(dir, ["symbolic-ref", "-q", "HEAD"])).trim();
  } catch (error) {
    if (exitCode(error) === GIT_EXIT_FALSE) {
      throw new IpcError(
        IpcErrorCode.CONFLICT,
        "The project is not on a branch",
      );
    }
    throw error;
  }
}

async function requireMergeInProgress(git: Git, dir: string): Promise<void> {
  if (!(await mergeInProgress(git, dir))) {
    throw new IpcError(IpcErrorCode.CONFLICT, "No merge is in progress");
  }
}

async function mergedOutcome(git: Git, dir: string): Promise<MergeOutcome> {
  return { status: MergeStatus.merged, commit: await head(git, dir) };
}

async function resolveProjectRoot(git: Git, cwd: string): Promise<string> {
  try {
    return normalizeGitRoot(
      await git(cwd, ["rev-parse", "--show-toplevel"]),
      path,
    );
  } catch (error) {
    console.warn(`not a git worktree: ${cwd}`, error);
    throw new IpcError(IpcErrorCode.VALIDATION, `Not a git repository: ${cwd}`);
  }
}

function worktreePath(projectRoot: string, runId: string): string {
  const shortId = runId.slice(0, FLOW_RUN_SHORT_ID_LENGTH);
  return path.join(
    path.dirname(projectRoot),
    FLOW_WORKTREES_DIR,
    `${path.basename(projectRoot)}${FLOW_WORKTREE_INFIX}${shortId}`,
  );
}

export async function isLinkEntry(entry: string): Promise<boolean> {
  try {
    return (await lstat(entry)).isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertWorktreePlacement(
  worktreesDir: string,
  worktreePath: string,
): Promise<void> {
  const inside =
    !(await isLinkEntry(worktreesDir)) &&
    (await realpath(worktreePath)) ===
      path.join(await realpath(worktreesDir), path.basename(worktreePath));
  if (!inside) {
    throw new IpcError(IpcErrorCode.VALIDATION, WORKTREE_PLACEMENT_MESSAGE);
  }
}

async function discardWorktree(
  git: Git,
  worktree: FlowWorktree,
): Promise<void> {
  try {
    await git(worktree.projectRoot, [
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]);
    await git(worktree.projectRoot, ["branch", "-D", worktree.branch]);
  } catch (error) {
    console.error(`failed to discard worktree ${worktree.path}`, error);
  }
}

async function create(
  git: Git,
  projectCwd: string,
  runId: string,
  guard?: WorktreeGuard,
): Promise<FlowWorktree> {
  const projectRoot = await resolveProjectRoot(git, projectCwd);
  if (await isDirty(git, projectRoot)) {
    throw new IpcError(
      IpcErrorCode.CONFLICT,
      "The project has uncommitted changes",
    );
  }
  const base = await head(git, projectRoot);
  const branch = `${FLOW_BRANCH_PREFIX}${runId}`;
  const dir = worktreePath(projectRoot, runId);
  const worktreesDir = path.dirname(dir);
  await guard?.(worktreesDir, dir);
  await git(projectRoot, ["worktree", "add", "-b", branch, dir, base]);
  const worktree = { runId, projectRoot, path: dir, branch, base };
  if (guard === undefined) {
    return worktree;
  }
  try {
    await guard(worktreesDir, dir);
    await assertWorktreePlacement(worktreesDir, dir);
  } catch (error) {
    await discardWorktree(git, worktree);
    throw error;
  }
  return worktree;
}

async function commitAll(
  git: Git,
  worktree: FlowWorktree,
  message: string,
): Promise<string | null> {
  await git(worktree.path, ["add", "-A"]);
  if (await gitSucceeds(git, worktree.path, ["diff", "--cached", "--quiet"])) {
    return null;
  }
  await git(worktree.path, ["commit", "-m", message]);
  return head(git, worktree.path);
}

async function diff(git: Git, worktree: FlowWorktree): Promise<string> {
  await git(worktree.path, ["add", "-A", "--intent-to-add"]);
  return git(worktree.path, ["diff", worktree.base]);
}

async function workingDiff(git: Git, cwd: string): Promise<string> {
  const tracked = await git(cwd, ["diff", "HEAD"]);
  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split(NUL_CHAR)
    .filter((file) => file !== "");
  return untracked.length === 0
    ? tracked
    : `${tracked}\n${UNTRACKED_FILES_HEADING}\n${untracked.join("\n")}\n`;
}

async function merge(git: Git, worktree: FlowWorktree): Promise<MergeOutcome> {
  const { projectRoot, branch } = worktree;
  await currentBranchRef(git, projectRoot);
  if (await isDirty(git, projectRoot)) {
    throw new IpcError(
      IpcErrorCode.CONFLICT,
      "The project has uncommitted changes",
    );
  }
  if (await mergeInProgress(git, projectRoot)) {
    throw new IpcError(IpcErrorCode.CONFLICT, "A merge is already in progress");
  }
  try {
    await git(projectRoot, [
      "merge",
      "--no-ff",
      "-m",
      `Merge ${branch}`,
      branch,
    ]);
  } catch (error) {
    const files = await unmergedFiles(git, projectRoot);
    if (files.length === 0) {
      throw error;
    }
    return { status: MergeStatus.conflict, files };
  }
  return mergedOutcome(git, projectRoot);
}

async function finishMerge(
  git: Git,
  worktree: FlowWorktree,
): Promise<MergeOutcome> {
  const { projectRoot } = worktree;
  await requireMergeInProgress(git, projectRoot);
  const entries = [...(await unmergedStages(git, projectRoot))];
  const unresolved = await Promise.all(
    entries.map(([file, entry]) =>
      isUnresolved(path.join(projectRoot, file), entry),
    ),
  );
  const remaining = entries
    .map(([file]) => file)
    .filter((_file, index) => unresolved[index]);
  if (remaining.length > 0) {
    return { status: MergeStatus.conflict, files: remaining };
  }
  await git(projectRoot, ["add", "-A"]);
  await git(projectRoot, ["commit", "--no-edit"]);
  return mergedOutcome(git, projectRoot);
}

async function abortMerge(git: Git, worktree: FlowWorktree): Promise<void> {
  await requireMergeInProgress(git, worktree.projectRoot);
  await git(worktree.projectRoot, ["merge", "--abort"]);
}

async function remove(git: Git, worktree: FlowWorktree): Promise<void> {
  const target = await currentBranchRef(git, worktree.projectRoot);
  const merged = await gitSucceeds(git, worktree.projectRoot, [
    "merge-base",
    "--is-ancestor",
    worktree.branch,
    target,
  ]);
  if (!merged) {
    throw new IpcError(
      IpcErrorCode.CONFLICT,
      `Branch ${worktree.branch} has unmerged commits`,
    );
  }
  await git(worktree.projectRoot, ["worktree", "remove", worktree.path]);
  await git(worktree.projectRoot, ["branch", "-d", worktree.branch]);
}

export function createFlowWorktrees(deps: {
  readonly exec: ExecText;
}): FlowWorktrees {
  const git: Git = (dir, args) => deps.exec(GIT_BINARY, ["-C", dir, ...args]);
  return {
    resolveProjectRoot: (cwd) => resolveProjectRoot(git, cwd),
    create: (projectCwd, runId, guard) => create(git, projectCwd, runId, guard),
    commitAll: (worktree, message) => commitAll(git, worktree, message),
    diff: (worktree) => diff(git, worktree),
    workingDiff: (cwd) => workingDiff(git, cwd),
    isDirty: (cwd) => isDirty(git, cwd),
    merge: (worktree) => merge(git, worktree),
    finishMerge: (worktree) => finishMerge(git, worktree),
    abortMerge: (worktree) => abortMerge(git, worktree),
    remove: (worktree) => remove(git, worktree),
  };
}
