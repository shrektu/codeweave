import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decidePermission,
  type PermissionContext,
} from "../domain/permissionPolicy";
import { PermissionProfile } from "../domain/types";

import { protectedPaths } from "./protectedPaths";

const HOME = "/home/u";
const USER_DATA = "/home/u/.local/share/Codeweave";
const ALLOW = { action: "allow" };
const ASK = { action: "ask" };

function contextFor(accountDirs: readonly string[]): PermissionContext {
  return {
    worktreeRoots: [HOME],
    homeDir: HOME,
    protectedPaths: protectedPaths({
      homeDir: HOME,
      userData: USER_DATA,
      accountDirs,
    }),
  };
}

function editDecision(
  path: string,
  accountDirs: readonly string[] = [],
): unknown {
  return decidePermission(
    { kind: "edit", paths: [path] },
    PermissionProfile.unattended,
    contextFor(accountDirs),
  );
}

describe("protectedPaths", () => {
  it("joins_the_static_home_list_user_data_and_credential_files", () => {
    const list = protectedPaths(
      { homeDir: HOME, userData: USER_DATA, accountDirs: [] },
      posix,
    );

    expect(list).toEqual([
      "/home/u/.ssh",
      "/home/u/.gnupg",
      "/home/u/.aws",
      "/home/u/.azure",
      "/home/u/.kube",
      "/home/u/.docker",
      "/home/u/.netrc",
      "/home/u/.git-credentials",
      "/home/u/.npmrc",
      "/home/u/.pypirc",
      "/home/u/.config/gh",
      "/home/u/.config/gcloud",
      "/home/u/.password-store",
      "/home/u/.local/share/keyrings",
      "/home/u/.config/*/auth*",
      "/home/u/.claude/.credentials.json",
      "/home/u/.claude/auth.json",
      "/home/u/.claude/oauth_creds.json",
      "/home/u/.claude/google_accounts.json",
      "/home/u/.codex/.credentials.json",
      "/home/u/.codex/auth.json",
      "/home/u/.codex/oauth_creds.json",
      "/home/u/.codex/google_accounts.json",
      "/home/u/.gemini/.credentials.json",
      "/home/u/.gemini/auth.json",
      "/home/u/.gemini/oauth_creds.json",
      "/home/u/.gemini/google_accounts.json",
      "/home/u/.config/opencode/.credentials.json",
      "/home/u/.config/opencode/auth.json",
      "/home/u/.config/opencode/oauth_creds.json",
      "/home/u/.config/opencode/google_accounts.json",
      "/home/u/.local/share/opencode/.credentials.json",
      "/home/u/.local/share/opencode/auth.json",
      "/home/u/.local/share/opencode/oauth_creds.json",
      "/home/u/.local/share/opencode/google_accounts.json",
      "/home/u/.local/share/Codeweave",
    ]);
  });

  it("deduplicates_entries", () => {
    const list = protectedPaths(
      {
        homeDir: HOME,
        userData: "/home/u/.ssh",
        accountDirs: ["/home/u/.claude"],
      },
      posix,
    );

    expect(list.filter((path) => path === "/home/u/.ssh")).toHaveLength(1);
    expect(
      list.filter((path) => path === "/home/u/.claude/auth.json"),
    ).toHaveLength(1);
  });
});

describe("protectedPaths in the permission policy", () => {
  it("claude-home-editable", () => {
    expect(editDecision("/home/u/.claude/CLAUDE.md")).toEqual(ALLOW);
    expect(editDecision("/home/u/.claude/settings.json")).toEqual(ALLOW);
    expect(editDecision("/home/u/.claude/.credentials.json")).toEqual(ASK);
    expect(editDecision("/home/u/.codex/auth.json")).toEqual(ASK);
    expect(editDecision("/home/u/.codex/config.toml")).toEqual(ALLOW);
    expect(editDecision("/home/u/.gemini/oauth_creds.json")).toEqual(ASK);
    expect(editDecision("/home/u/.config/opencode/auth.json")).toEqual(ASK);
    expect(editDecision("/home/u/.config/opencode/opencode.json")).toEqual(
      ALLOW,
    );
  });

  it("imported-account-dir-credentials-only", () => {
    const imported = ["/home/u/work/claude-acc"];

    expect(editDecision("/home/u/work/claude-acc/notes.md", imported)).toEqual(
      ALLOW,
    );
    expect(editDecision("/home/u/work/claude-acc/auth.json", imported)).toEqual(
      ASK,
    );
    expect(
      editDecision("/home/u/work/claude-acc/.credentials.json", imported),
    ).toEqual(ASK);
  });

  it("an_account_dir_inside_user_data_is_covered_by_the_whole_folder", () => {
    const inside = "/home/u/.local/share/Codeweave/accounts/a";
    const list = protectedPaths({
      homeDir: HOME,
      userData: USER_DATA,
      accountDirs: [inside],
    });

    expect(list).not.toContain(`${inside}/auth.json`);
    expect(editDecision(`${inside}/anything.txt`, [inside])).toEqual(ASK);
    expect(editDecision(`${USER_DATA}/settings.json`)).toEqual(ASK);
  });

  it("an_account_dir_equal_to_user_data_adds_nothing", () => {
    const list = protectedPaths({
      homeDir: HOME,
      userData: USER_DATA,
      accountDirs: [USER_DATA],
    });

    expect(list).not.toContain(`${USER_DATA}/auth.json`);
  });
});

describe("protectedPaths on win32", () => {
  it("joins_with_the_given_path_flavor_on_win32", () => {
    const list = protectedPaths(
      {
        homeDir: "C:\\Users\\u",
        userData: "C:\\Users\\u\\AppData\\Roaming\\Codeweave",
        accountDirs: [
          "C:\\Users\\u\\AppData\\Roaming\\Codeweave\\accounts\\a",
          "D:\\acc",
        ],
      },
      win32,
    );

    expect(list).toContain("C:\\Users\\u\\.ssh");
    expect(list).toContain("C:\\Users\\u\\.config\\*\\auth*");
    expect(list).toContain("C:\\Users\\u\\.claude\\auth.json");
    expect(list).toContain("C:\\Users\\u\\AppData\\Roaming\\Codeweave");
    expect(list).toContain("D:\\acc\\auth.json");
    expect(list).not.toContain(
      "C:\\Users\\u\\AppData\\Roaming\\Codeweave\\accounts\\a\\auth.json",
    );
  });

  it("matches_the_user_data_folder_case_insensitively_on_win32", () => {
    const list = protectedPaths(
      {
        homeDir: "C:\\Users\\u",
        userData: "C:\\Users\\u\\AppData\\Roaming\\Codeweave",
        accountDirs: ["c:\\users\\u\\appdata\\roaming\\codeweave\\acc"],
      },
      win32,
    );

    expect(list).not.toContain(
      "c:\\users\\u\\appdata\\roaming\\codeweave\\acc\\auth.json",
    );
  });
});
