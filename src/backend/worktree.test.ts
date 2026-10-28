import { writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { makeTempDir, runGit } from "../../tests/fakes/processHelpers";

import { inspectWorktree, normalizeGitRoot } from "./worktree";

describe("normalizeGitRoot", () => {
  it("normalize_git_root_converts_forward_slashes_on_windows", () => {
    expect(normalizeGitRoot("C:/a/b\n", win32)).toBe("C:\\a\\b");
  });

  it("normalize_git_root_keeps_posix_path_unchanged", () => {
    expect(normalizeGitRoot("/a/b\n", posix)).toBe("/a/b");
  });
});

describe("inspectWorktree", () => {
  it("non_repo_directory_reports_not_a_repo", async () => {
    const cwd = await makeTempDir();

    expect(await inspectWorktree(cwd)).toEqual({ isRepo: false, cwd });
  });

  it("clean_repo_has_empty_porcelain_and_diff_stat", async () => {
    const root = await makeTempDir();
    await runGit(root, ["init", "--quiet"]);

    expect(await inspectWorktree(root)).toEqual({
      isRepo: true,
      root,
      porcelain: "",
      diffStat: "",
    });
  });

  it("untracked_file_shows_in_porcelain", async () => {
    const root = await makeTempDir();
    await runGit(root, ["init", "--quiet"]);
    await writeFile(join(root, "new.txt"), "x");

    const state = await inspectWorktree(root);

    expect(state).toEqual({
      isRepo: true,
      root,
      porcelain: "?? new.txt\n",
      diffStat: "",
    });
  });
});
