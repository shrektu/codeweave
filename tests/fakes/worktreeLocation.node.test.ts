import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { isWorktreeUnder } from "./worktreeLocation";

const PREFIX = "beta-cw-";

describe("isWorktreeUnder", () => {
  it("accepts_a_forward_slash_git_path_for_a_backslash_directory_on_win32", () => {
    expect(
      isWorktreeUnder(
        "C:/Users/runneradmin/AppData/Local/Temp/ws/.worktrees/beta-cw-1a2b3c4d",
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ws\\.worktrees",
        PREFIX,
        win32,
      ),
    ).toBe(true);
  });

  it("ignores_drive_letter_and_folder_case_on_win32", () => {
    expect(
      isWorktreeUnder(
        "c:/users/RunnerAdmin/ws/.worktrees/beta-cw-1a2b3c4d",
        "C:\\Users\\runneradmin\\ws\\.worktrees",
        PREFIX,
        win32,
      ),
    ).toBe(true);
  });

  it("rejects_a_worktree_outside_the_directory", () => {
    expect(
      isWorktreeUnder(
        "C:/other/.worktrees/beta-cw-1a2b3c4d",
        "C:\\ws\\.worktrees",
        PREFIX,
        win32,
      ),
    ).toBe(false);
  });

  it("rejects_a_nested_path_below_the_matching_entry", () => {
    expect(
      isWorktreeUnder(
        "/tmp/ws/.worktrees/beta-cw-1a2b3c4d/sub",
        "/tmp/ws/.worktrees",
        PREFIX,
        posix,
      ),
    ).toBe(false);
  });

  it("rejects_an_entry_with_a_different_prefix", () => {
    expect(
      isWorktreeUnder(
        "/tmp/ws/.worktrees/alpha-cw-1a2b3c4d",
        "/tmp/ws/.worktrees",
        PREFIX,
        posix,
      ),
    ).toBe(false);
  });
});
