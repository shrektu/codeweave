import { describe, expect, it } from "vitest";

import {
  isBelowRoot,
  isInsideWorktree,
  isProtectedAncestor,
  isProtectedPath,
  isWithinRoot,
  mentionsProtectedPath,
  resolveTarget,
  type PermissionContext,
} from "./pathScope";

const POSIX_CTX: PermissionContext = {
  worktreeRoots: ["/home/u"],
  homeDir: "/home/u",
  protectedPaths: ["/home/u/.ssh", "/home/u/.config/*/auth*"],
};
const WIN_CTX: PermissionContext = {
  worktreeRoots: ["C:\\Users\\u"],
  homeDir: "C:\\Users\\u",
  protectedPaths: ["C:\\Users\\u\\.ssh", "C:\\Users\\u\\.config\\*\\auth*"],
};

describe("resolveTarget", () => {
  it("resolves_tilde_forms_against_the_home_dir", () => {
    expect(resolveTarget("~", POSIX_CTX, null, "linux")).toBe("/home/u");
    expect(resolveTarget("~/x/y", POSIX_CTX, null, "linux")).toBe(
      "/home/u/x/y",
    );
    expect(resolveTarget("~/../v", POSIX_CTX, null, "linux")).toBe("/home/v");
  });

  it("treats_other_users_and_variables_as_unresolved", () => {
    expect(resolveTarget("~root/x", POSIX_CTX, "/home/u", "linux")).toBeNull();
    expect(resolveTarget("$HOME/x", POSIX_CTX, "/home/u", "linux")).toBeNull();
    expect(resolveTarget("a$b", POSIX_CTX, "/home/u", "linux")).toBeNull();
  });

  it("needs_a_known_cwd_for_relative_targets", () => {
    expect(resolveTarget("a/b", POSIX_CTX, null, "linux")).toBeNull();
    expect(resolveTarget("a/b", POSIX_CTX, "/home/u/p", "linux")).toBe(
      "/home/u/p/a/b",
    );
    expect(resolveTarget("/abs/x", POSIX_CTX, null, "linux")).toBe("/abs/x");
    expect(resolveTarget("a", POSIX_CTX, "relative", "linux")).toBeNull();
  });

  it("accepts_backslash_tilde_only_on_win32", () => {
    expect(resolveTarget("~\\x", WIN_CTX, null, "win32")).toBe(
      "C:\\Users\\u\\x",
    );
    expect(resolveTarget("~/x", WIN_CTX, null, "win32")).toBe(
      "C:\\Users\\u\\x",
    );
    expect(resolveTarget("~\\x", POSIX_CTX, null, "linux")).toBeNull();
  });
});

describe("isInsideWorktree", () => {
  it("excludes_the_root_itself_and_everything_outside", () => {
    expect(isInsideWorktree("/home/u", POSIX_CTX, null, "linux")).toBe(false);
    expect(isInsideWorktree("/home/u/a", POSIX_CTX, null, "linux")).toBe(true);
    expect(isInsideWorktree("/home/v/a", POSIX_CTX, null, "linux")).toBe(false);
    expect(isInsideWorktree("/home/u/../v", POSIX_CTX, null, "linux")).toBe(
      false,
    );
    expect(isInsideWorktree("/home/user/a", POSIX_CTX, null, "linux")).toBe(
      false,
    );
  });

  it("excludes_protected_paths_even_inside_the_root", () => {
    expect(isInsideWorktree("/home/u/.ssh", POSIX_CTX, null, "linux")).toBe(
      false,
    );
    expect(isInsideWorktree("/home/u/.ssh/k", POSIX_CTX, null, "linux")).toBe(
      false,
    );
    expect(isInsideWorktree("~/.ssh/k", POSIX_CTX, null, "linux")).toBe(false);
    expect(isInsideWorktree("/home/u/.sshx", POSIX_CTX, null, "linux")).toBe(
      true,
    );
  });

  it("within_root_includes_the_root_but_not_protected_paths", () => {
    expect(isWithinRoot("/home/u", POSIX_CTX, null, "linux")).toBe(true);
    expect(isWithinRoot("/home/u/a", POSIX_CTX, null, "linux")).toBe(true);
    expect(isWithinRoot("/home/u/.ssh", POSIX_CTX, null, "linux")).toBe(false);
    expect(isWithinRoot("/tmp", POSIX_CTX, null, "linux")).toBe(false);
    expect(isWithinRoot("a", POSIX_CTX, null, "linux")).toBe(false);
  });

  it("is_below_root_checks_the_lexical_confinement_only", () => {
    expect(isBelowRoot("a/b", "/work/repo", "linux")).toBe(true);
    expect(isBelowRoot("../b", "/work/repo", "linux")).toBe(false);
    expect(isBelowRoot("/work/repo", "/work/repo", "linux")).toBe(false);
  });
});

describe("protected patterns", () => {
  it("a_star_matches_a_run_of_characters_within_one_segment", () => {
    const patterns = ["/home/u/.config/*/auth*"];

    for (const path of [
      "/home/u/.config/app/auth.json",
      "/home/u/.config/app/auth",
      "/home/u/.config/x/authorized_keys",
      "/home/u/.config/app/auth/deep/file",
    ]) {
      expect(isProtectedPath(path, patterns, "linux"), path).toBe(true);
    }
    for (const path of [
      "/home/u/.config/app/sub/auth.json",
      "/home/u/.config/auth.json",
      "/home/u/.config/app/oauth.json",
      "/home/u/.config/app",
    ]) {
      expect(isProtectedPath(path, patterns, "linux"), path).toBe(false);
    }
  });

  it("a_star_in_the_middle_of_a_segment_needs_both_ends", () => {
    const patterns = ["/p/a*b*c"];

    expect(isProtectedPath("/p/abc", patterns, "linux")).toBe(true);
    expect(isProtectedPath("/p/aXbYc", patterns, "linux")).toBe(true);
    expect(isProtectedPath("/p/aXbY", patterns, "linux")).toBe(false);
    expect(isProtectedPath("/p/bac", patterns, "linux")).toBe(false);
  });

  it("ancestors_of_protected_patterns_are_detected_separately", () => {
    const patterns = ["/home/u/.config/gh", "/home/u/.ssh"];

    expect(isProtectedAncestor("/home/u/.config", patterns, "linux")).toBe(
      true,
    );
    expect(isProtectedAncestor("/home/u", patterns, "linux")).toBe(true);
    expect(isProtectedAncestor("/home/u/.ssh", patterns, "linux")).toBe(false);
    expect(isProtectedAncestor("/home/u/proj", patterns, "linux")).toBe(false);
    expect(isProtectedPath("/home/u/.config", patterns, "linux")).toBe(false);
  });

  it("relative_patterns_are_ignored", () => {
    expect(isProtectedPath("/home/u/.ssh", [".ssh"], "linux")).toBe(false);
  });
});

describe("protected patterns per platform", () => {
  it("protected-paths-win32", () => {
    const patterns = WIN_CTX.protectedPaths;

    for (const path of [
      "C:\\Users\\u\\.ssh\\id_rsa",
      "c:\\users\\U\\.SSH\\id_rsa",
      "C:/Users/u/.ssh/id_rsa",
      "c:/users/u/.config/app/AUTH.json",
    ]) {
      expect(isProtectedPath(path, patterns, "win32"), path).toBe(true);
    }
    expect(isProtectedPath("D:\\Users\\u\\.ssh", patterns, "win32")).toBe(
      false,
    );
    expect(isProtectedPath("C:\\Users\\u\\proj", patterns, "win32")).toBe(
      false,
    );
  });

  it("darwin_compares_case_insensitively_and_linux_exactly", () => {
    const patterns = ["/Users/u/.ssh"];

    expect(isProtectedPath("/users/U/.SSH/k", patterns, "darwin")).toBe(true);
    expect(isProtectedPath("/users/U/.SSH/k", patterns, "linux")).toBe(false);
    expect(isProtectedPath("/Users/u/.ssh/k", patterns, "linux")).toBe(true);
  });

  it("win32_scope_resolves_inside_and_protected_with_backslashes", () => {
    expect(isInsideWorktree("C:\\Users\\u\\proj", WIN_CTX, null, "win32")).toBe(
      true,
    );
    expect(isInsideWorktree("~\\.ssh\\k", WIN_CTX, null, "win32")).toBe(false);
    expect(isInsideWorktree("proj\\a", WIN_CTX, "C:\\Users\\u", "win32")).toBe(
      true,
    );
    expect(isInsideWorktree("D:\\x", WIN_CTX, null, "win32")).toBe(false);
  });

  it("a_target_glob_may_match_a_protected_segment", () => {
    const patterns = ["/home/u/.ssh", "/home/u/.config/gh"];

    expect(isProtectedPath("/home/u/.s*", patterns, "linux")).toBe(true);
    expect(isProtectedPath("/home/u/.config/g?", patterns, "linux")).toBe(true);
    expect(isProtectedPath("/home/u/*", patterns, "linux")).toBe(false);
    expect(isProtectedPath("/home/u/b*", patterns, "linux")).toBe(false);
  });
});

describe("mentionsProtectedPath", () => {
  it("detects_resolved_absolute_and_tilde_forms_inside_words", () => {
    for (const word of [
      "/home/u/.ssh/k",
      "~/.ssh",
      "open('~/.ssh/x','w')",
      "--dir=/home/u/.ssh",
      "--dir=~/.ssh/keys",
      "rel=.ssh/k",
    ]) {
      expect(
        mentionsProtectedPath(word, POSIX_CTX, "/home/u", "linux"),
        word,
      ).toBe(true);
    }
    for (const word of ["/home/u/proj", "~/proj", "x.ssh", "ssh"]) {
      expect(
        mentionsProtectedPath(word, POSIX_CTX, "/home/u", "linux"),
        word,
      ).toBe(false);
    }
  });

  it("the_fixed_prefix_of_a_wildcard_pattern_counts", () => {
    expect(
      mentionsProtectedPath("cp ~/.config/x", POSIX_CTX, null, "linux"),
    ).toBe(true);
  });

  it("matches_win32_forms_with_both_separators_ignoring_case", () => {
    for (const word of [
      "C:\\Users\\u\\.ssh\\k",
      "c:/users/u/.SSH/k",
      "~\\.ssh\\k",
      "~/.ssh/k",
    ]) {
      expect(mentionsProtectedPath(word, WIN_CTX, null, "win32"), word).toBe(
        true,
      );
    }
  });

  it("win32_drive_less_rooted_spelling_inside_a_word_counts", () => {
    for (const word of [
      "open('/Users/u/.ssh/x','w')",
      "open('\\Users\\u\\.SSH\\x','w')",
    ]) {
      expect(mentionsProtectedPath(word, WIN_CTX, null, "win32"), word).toBe(
        true,
      );
    }
    expect(
      mentionsProtectedPath(
        "open('/Users/u/proj','w')",
        WIN_CTX,
        null,
        "win32",
      ),
    ).toBe(false);
  });
});
