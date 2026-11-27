import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileCompletionItem } from "../shared/views";

import {
  createFileCompletion,
  type FileCompletion,
  type FileCompletionDeps,
} from "./fileCompletion";

const GIT_TOP_LEVEL = "/repo\n";
const GIT_LIST_FILES = "ls-files";
const GIT_REV_PARSE = "rev-parse";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cw-file-completion-")),
  );
  tempDirs.push(dir);
  return dir;
}

function gitListing(paths: readonly string[]): string {
  return paths.join("\0");
}

function fakeGit(paths: readonly string[]): FileCompletionDeps["git"] {
  return (_cwd, args) => {
    if (args[0] === GIT_REV_PARSE) {
      return Promise.resolve(GIT_TOP_LEVEL);
    }
    if (args[0] === GIT_LIST_FILES) {
      return Promise.resolve(gitListing(paths));
    }
    return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
  };
}

function completionOn(
  git: FileCompletionDeps["git"],
  overrides: Partial<FileCompletionDeps> = {},
): FileCompletion {
  return createFileCompletion({
    git,
    homeDir: "/home/test",
    protectedPaths: () => Promise.resolve([]),
    now: () => 1_000,
    ...overrides,
  });
}

function pathsOf(items: readonly FileCompletionItem[]): string[] {
  return items.map((item) => item.path);
}

function countingGit(paths: readonly string[]): {
  readonly git: FileCompletionDeps["git"];
  readonly listings: () => number;
} {
  const inner = fakeGit(paths);
  let count = 0;
  return {
    git: (cwd, args, timeoutMs) => {
      if (args[0] === GIT_LIST_FILES) {
        count += 1;
      }
      return inner(cwd, args, timeoutMs);
    },
    listings: () => count,
  };
}

describe("git mode matching", () => {
  it("ranks basename hits before path hits and subsequence hits", async () => {
    const completion = completionOn(
      fakeGit([
        "docs/sbk-guide.md",
        "sbk/src/file.ts",
        "src/backend/model.ts",
        "src/backend/y.ts",
        "src/backend/z.ts",
      ]),
    );

    const base = await makeTempDir();
    const items = await completion.complete(base, "sbk");

    expect(items).toEqual([
      { path: "sbk", kind: "dir" },
      { path: "docs/sbk-guide.md", kind: "file" },
      { path: "sbk/src", kind: "dir" },
      { path: "sbk/src/file.ts", kind: "file" },
      { path: "src/backend", kind: "dir" },
      { path: "src/backend/y.ts", kind: "file" },
      { path: "src/backend/z.ts", kind: "file" },
      { path: "src/backend/model.ts", kind: "file" },
    ]);
  });

  it("matches case insensitively", async () => {
    const completion = completionOn(fakeGit(["Docs/Guide.MD"]));

    const base = await makeTempDir();
    const items = await completion.complete(base, "guide");

    expect(items).toEqual([{ path: "Docs/Guide.MD", kind: "file" }]);
  });

  it("empty_query_in_repo_lists_top_level_only", async () => {
    const completion = completionOn(
      fakeGit(["src/a.ts", "README.md", ".gitignore"]),
    );

    const base = await makeTempDir();
    const items = await completion.complete(base, "");

    expect(items).toEqual([
      { path: "src", kind: "dir" },
      { path: ".gitignore", kind: "file" },
      { path: "README.md", kind: "file" },
    ]);
  });
});

describe("git index entries", () => {
  it("untracked_nested_repo_is_one_dir_entry", async () => {
    const completion = completionOn(fakeGit(["nested/", "src/a.ts"]));

    const base = await makeTempDir();
    const items = await completion.complete(base, "");

    expect(items).toEqual([
      { path: "nested", kind: "dir" },
      { path: "src", kind: "dir" },
    ]);
    expect(pathsOf(items).some((item) => item.endsWith("/"))).toBe(false);
  });

  it("astral_character_query_matches", async () => {
    const completion = completionOn(fakeGit(["😀.txt", "other.ts"]));

    const base = await makeTempDir();
    const items = await completion.complete(base, "😀");

    expect(items).toEqual([{ path: "😀.txt", kind: "file" }]);
  });

  it("submodule_is_listed_as_dir", async () => {
    const completion = completionOn(
      fakeGit([
        `100644 ${"a".repeat(40)} 0\ta.txt`,
        `160000 ${"b".repeat(40)} 0\tsub`,
        "u.txt",
        "nested/",
      ]),
    );
    const base = await makeTempDir();

    const items = await completion.complete(base, "");

    expect(items).toEqual([
      { path: "nested", kind: "dir" },
      { path: "sub", kind: "dir" },
      { path: "a.txt", kind: "file" },
      { path: "u.txt", kind: "file" },
    ]);
  });

  it("nested_submodule_parent_dir_is_listed", async () => {
    const completion = completionOn(
      fakeGit([`160000 ${"b".repeat(40)} 0\tvendor/lib`]),
    );
    const base = await makeTempDir();

    const topLevel = await completion.complete(base, "");
    const fuzzy = await completion.complete(base, "vend");

    expect(topLevel).toEqual([{ path: "vendor", kind: "dir" }]);
    expect(fuzzy).toEqual([
      { path: "vendor", kind: "dir" },
      { path: "vendor/lib", kind: "dir" },
    ]);
  });
});

describe("git mode symlinks", () => {
  it("git_mode_hides_symlink_to_protected_target", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const base = await makeTempDir();
    const fakeHome = await makeTempDir();
    const codexDir = join(fakeHome, ".codex");
    await mkdir(codexDir);
    const credential = join(codexDir, "auth.json");
    await writeFile(credential, "{}");
    await writeFile(join(base, "readme.txt"), "");
    try {
      await symlink(credential, join(base, "token"));
      await symlink(codexDir, join(base, "creds"), "dir");
      await symlink(credential, join(base, "utoken"));
      await symlink(codexDir, join(base, "ucreds"), "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const sha = "a".repeat(40);
    const completion = completionOn(
      fakeGit([
        `100644 ${sha} 0\treadme.txt`,
        `120000 ${sha} 0\ttoken`,
        `120000 ${sha} 0\tcreds`,
        "utoken",
        "ucreds",
      ]),
      { protectedPaths: () => Promise.resolve([credential, codexDir]) },
    );

    const items = await completion.complete(base, "");

    expect(items).toEqual([{ path: "readme.txt", kind: "file" }]);
  });
});

describe("git mode symlink checks", () => {
  it("git_mode_checks_only_symlink_candidates", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const base = await makeTempDir();
    await writeFile(join(base, "readme.txt"), "");
    try {
      await symlink(join(base, "readme.txt"), join(base, "token"));
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const calls: string[] = [];
    const fakeFs = {
      lstat: (target: string) => {
        calls.push(target);
        return lstat(target);
      },
      realpath,
    };
    const sha = "a".repeat(40);
    const completion = completionOn(
      fakeGit([
        `100644 ${sha} 0\treadme.txt`,
        `120000 ${sha} 0\ttoken`,
        "u.txt",
      ]),
      { fs: fakeFs },
    );

    await completion.complete(base, "");

    expect(calls.map((call) => relative(base, call))).toEqual([
      "token",
      "u.txt",
    ]);
  });
});

describe("git index cache", () => {
  it("git_index_is_cached_until_the_ttl_expires", async () => {
    let clock = 1_000;
    const counter = countingGit(["src/a.ts"]);
    const completion = completionOn(counter.git, { now: () => clock });

    const base = await makeTempDir();
    await completion.complete(base, "src");
    clock = 1_000 + 4_999;
    await completion.complete(base, "src");
    expect(counter.listings()).toBe(1);

    clock = 1_000 + 5_000;
    await completion.complete(base, "src");

    expect(counter.listings()).toBe(2);
  });

  it("concurrent_completions_share_one_git_index_build", async () => {
    const gate = Promise.withResolvers<string>();
    let listings = 0;
    const completion = completionOn((_cwd, args) => {
      if (args[0] === GIT_REV_PARSE) {
        return Promise.resolve(GIT_TOP_LEVEL);
      }
      listings += 1;
      return gate.promise;
    });

    const base = await makeTempDir();
    const first = completion.complete(base, "");
    const second = completion.complete(base, "");
    await vi.waitFor(() => {
      expect(listings).toBe(1);
    });
    gate.resolve(gitListing(["src/a.ts"]));

    const [left, right] = await Promise.all([first, second]);

    expect(listings).toBe(1);
    expect(left).toEqual(right);
    expect(left).toEqual([{ path: "src", kind: "dir" }]);
  });

  it("a_failed_build_is_cached_until_the_ttl", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "");
    let clock = 1_000;
    let listings = 0;
    const completion = completionOn(
      (_cwd, args) => {
        if (args[0] === GIT_REV_PARSE) {
          return Promise.resolve(GIT_TOP_LEVEL);
        }
        listings += 1;
        return listings === 1
          ? Promise.reject(new Error("git ls-files failed"))
          : Promise.resolve(gitListing(["src/b.ts"]));
      },
      { now: () => clock },
    );

    const failed = await completion.complete(dir, "");
    const cached = await completion.complete(dir, "");
    clock = 1_000 + 5_000;
    const retried = await completion.complete(dir, "");

    expect(failed).toEqual([{ path: "a.txt", kind: "file" }]);
    expect(cached).toEqual([{ path: "a.txt", kind: "file" }]);
    expect(retried).toEqual([{ path: "src", kind: "dir" }]);
    expect(listings).toBe(2);
  });

  it("git_failure_is_not_retried_within_ttl", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "");
    let clock = 1_000;
    let listings = 0;
    const completion = completionOn(
      (_cwd, args) => {
        if (args[0] === GIT_REV_PARSE) {
          return Promise.resolve(GIT_TOP_LEVEL);
        }
        listings += 1;
        return Promise.reject(new Error("git ls-files timed out"));
      },
      { now: () => clock },
    );

    await completion.complete(dir, "");
    await completion.complete(dir, "");
    expect(listings).toBe(1);

    clock = 1_000 + 5_000;
    await completion.complete(dir, "");

    expect(listings).toBe(2);
  });
});

describe("git index timeouts", () => {
  it("git_calls_use_short_timeout", async () => {
    const timeouts: (number | undefined)[] = [];
    const completion = completionOn(
      (_cwd: string, args: readonly string[], timeoutMs?: number) => {
        timeouts.push(timeoutMs);
        return args[0] === GIT_REV_PARSE
          ? Promise.resolve(GIT_TOP_LEVEL)
          : Promise.resolve(gitListing(["src/a.ts"]));
      },
    );

    const base = await makeTempDir();
    await completion.complete(base, "src");

    expect(timeouts).toEqual([3_000, 3_000]);
  });
});

describe("git index eviction", () => {
  it("expired_indexes_are_evicted", async () => {
    let clock = 1_000;
    const counter = countingGit(["src/a.ts"]);
    const completion = completionOn(counter.git, { now: () => clock });
    const rootBase = await makeTempDir();
    const bases = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) =>
      join(rootBase, name),
    );
    await Promise.all(bases.map((dir) => mkdir(dir, { recursive: true })));
    for (const base of bases) {
      await completion.complete(base, "src");
    }
    expect(counter.listings()).toBe(8);

    clock = 1_000 + 5_000;
    const first = bases[0] ?? "";
    await completion.complete(first, "src");
    const ninth = join(rootBase, "i");
    await mkdir(ninth);
    await completion.complete(ninth, "src");
    await completion.complete(first, "src");

    expect(counter.listings()).toBe(10);
  });

  it("index_cache_is_capped", async () => {
    const counter = countingGit(["src/a.ts"]);
    const completion = completionOn(counter.git, { now: () => 1_000 });
    const rootBase = await makeTempDir();
    const bases = Array.from({ length: 9 }, (_value, index) =>
      join(rootBase, String(index)),
    );
    await Promise.all(bases.map((dir) => mkdir(dir, { recursive: true })));
    for (const base of bases) {
      await completion.complete(base, "src");
    }
    expect(counter.listings()).toBe(9);

    await completion.complete(bases[0] ?? "", "src");

    expect(counter.listings()).toBe(10);
  });
});

describe("directory mode", () => {
  it("git_failure_falls_back_to_directory_listing", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "child.txt"), "");
    const completion = completionOn(() =>
      Promise.reject(new Error("not a git repository")),
    );

    const items = await completion.complete(dir, "sub/");

    expect(items).toEqual([{ path: "sub/child.txt", kind: "file" }]);
  });

  it("ls_files_failure_falls_back_to_directory_listing", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "child.txt"), "");
    const completion = completionOn((_cwd, args) =>
      args[0] === GIT_REV_PARSE
        ? Promise.resolve(GIT_TOP_LEVEL)
        : Promise.reject(new Error("maxBuffer exceeded")),
    );

    const items = await completion.complete(dir, "sub/");

    expect(items).toEqual([{ path: "sub/child.txt", kind: "file" }]);
  });
});

describe("directory mode entries", () => {
  it("broken_symlink_is_skipped", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const dir = await makeTempDir();
    const target = join(dir, "target");
    await mkdir(target);
    await writeFile(join(dir, "real.txt"), "");
    try {
      await symlink(target, join(dir, "dir-link"), "dir");
      await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
      await symlink(join(dir, "missing.txt"), join(dir, "broken"));
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const completion = completionOn(() =>
      Promise.reject(new Error("not a git repository")),
    );

    const items = await completion.complete(dir, "");

    expect(items).toEqual([
      { path: "dir-link", kind: "dir" },
      { path: "target", kind: "dir" },
      { path: "link.txt", kind: "file" },
      { path: "real.txt", kind: "file" },
    ]);
  });

  it("eacces_on_the_listed_dir_returns_empty", async (context) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      context.skip();
      return;
    }
    const dir = await makeTempDir();
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    const completion = completionOn(() =>
      Promise.reject(new Error("not a git repository")),
    );
    try {
      const items = await completion.complete(dir, "locked/");

      expect(items).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

describe("symlink safety", () => {
  it("symlink_loop_is_skipped_not_fatal", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const dir = await makeTempDir();
    await writeFile(join(dir, "real.txt"), "");
    try {
      await symlink("loop", join(dir, "loop"));
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const completion = completionOn(() =>
      Promise.reject(new Error("not a git repository")),
    );

    const items = await completion.complete(dir, "");

    expect(items).toEqual([{ path: "real.txt", kind: "file" }]);
  });

  it("symlink_into_protected_dir_lists_nothing_protected", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const dir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const codexDir = join(fakeHome, ".codex");
    await mkdir(codexDir);
    const credential = join(codexDir, "auth.json");
    await writeFile(credential, "{}");
    await writeFile(join(codexDir, "config.toml"), "");
    const external = await makeTempDir();
    await writeFile(join(external, "visible.txt"), "");
    try {
      await symlink(codexDir, join(dir, "creds"), "dir");
      await symlink(external, join(dir, "shared"), "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const completion = completionOn(
      () => Promise.reject(new Error("not a git repository")),
      { protectedPaths: () => Promise.resolve([credential, codexDir]) },
    );

    const protectedItems = await completion.complete(dir, "creds/");
    const externalItems = await completion.complete(dir, "shared/");

    expect(protectedItems).toEqual([]);
    expect(externalItems).toEqual([
      { path: "shared/visible.txt", kind: "file" },
    ]);
  });

  it("symlink_entry_to_protected_target_is_hidden", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const dir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const codexDir = join(fakeHome, ".codex");
    await mkdir(codexDir);
    const credential = join(codexDir, "auth.json");
    await writeFile(credential, "{}");
    await writeFile(join(dir, "readme.txt"), "");
    try {
      await symlink(credential, join(dir, "token"));
      await symlink(codexDir, join(dir, "creds"), "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const completion = completionOn(
      () => Promise.reject(new Error("not a git repository")),
      { protectedPaths: () => Promise.resolve([credential, codexDir]) },
    );

    const items = await completion.complete(dir, "");

    expect(items).toEqual([{ path: "readme.txt", kind: "file" }]);
  });
});

describe("base resolution", () => {
  it("symlinked_base_into_protected_repo_lists_nothing", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const repo = await makeTempDir();
    const aliasParent = await makeTempDir();
    const alias = join(aliasParent, "alias");
    try {
      await symlink(repo, alias, "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const protectedFile = join(repo, "src/a.ts");
    const wholeRepo = completionOn(fakeGit(["src/a.ts"]), {
      protectedPaths: () => Promise.resolve([repo]),
    });
    const fileLevel = completionOn(fakeGit(["src/a.ts"]), {
      protectedPaths: () => Promise.resolve([protectedFile]),
    });
    const unprotected = completionOn(fakeGit(["src/a.ts"]));

    expect(await wholeRepo.complete(alias, "")).toEqual([]);
    expect(await fileLevel.complete(alias, "src/a")).toEqual([]);
    expect(pathsOf(await unprotected.complete(alias, "src/a"))).toEqual([
      "src/a.ts",
    ]);
  });
});

describe("directory mode guards", () => {
  it("parent_escape_query_returns_nothing", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "");
    const completion = completionOn(() =>
      Promise.reject(new Error("not a git repository")),
    );

    const inside = await completion.complete(dir, "");
    const escaping = await completion.complete(dir, "../x");
    const absolute = await completion.complete(dir, resolve(dir, "a.txt"));

    expect(pathsOf(inside)).toEqual(["a.txt"]);
    expect(escaping).toEqual([]);
    expect(absolute).toEqual([]);
  });

  it("returns paths with forward slashes only", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "child.txt"), "");
    const completion = completionOn(() =>
      Promise.reject(new Error("not a git repository")),
    );

    const items = await completion.complete(dir, "sub/");

    expect(pathsOf(items)).toEqual(["sub/child.txt"]);
    expect(items.every((item) => !item.path.includes("\\"))).toBe(true);
  });
});

describe("protected paths and limits", () => {
  it("protected_credential_file_is_hidden", async () => {
    const dir = await makeTempDir();
    const codexDir = join(dir, ".codex");
    await mkdir(codexDir);
    const credential = join(codexDir, "auth.json");
    await writeFile(credential, "{}");
    await writeFile(join(codexDir, "config.toml"), "");
    const completion = completionOn(
      () => Promise.reject(new Error("not a git repository")),
      { protectedPaths: () => Promise.resolve([credential]) },
    );

    const items = await completion.complete(dir, ".codex/");

    expect(items).toEqual([{ path: ".codex/config.toml", kind: "file" }]);
  });

  it("caps the result after dropping protected paths", async () => {
    const base = await makeTempDir();
    const names = Array.from(
      { length: 60 },
      (_value, index) => `file-${String(index).padStart(2, "0")}.txt`,
    );
    const completion = completionOn(fakeGit(names), {
      protectedPaths: () =>
        Promise.resolve([
          join(base, "file-00.txt"),
          join(base, "file-01.txt"),
          join(base, "file-02.txt"),
          join(base, "file-03.txt"),
          join(base, "file-04.txt"),
        ]),
    });

    const items = await completion.complete(base, "");

    expect(items).toHaveLength(50);
    expect(items[0]).toEqual({ path: "file-05.txt", kind: "file" });
    expect(items.at(-1)).toEqual({ path: "file-54.txt", kind: "file" });
  });
});
