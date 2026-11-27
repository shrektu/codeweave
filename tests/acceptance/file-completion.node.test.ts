import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execText, type ExecText } from "../../src/backend/exec";
import {
  createFileCompletion,
  type FileCompletion,
  type FileCompletionDeps,
} from "../../src/backend/fileCompletion";
import { createHandlers } from "../../src/backend/handlers";
import { createIpcServer } from "../../src/backend/ipcServer";
import { createJsonStore } from "../../src/backend/storage";
import { FILE_INDEX_TTL_MS } from "../../src/shared/constants";
import { fromNodePort } from "../../src/shared/port";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { FileCompletionItem } from "../../src/shared/views";
import { fakeAttachmentStore } from "../fakes/fakeAttachmentStore";
import { fakeCheckpointStore } from "../fakes/fakeCheckpointStore";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionHistory,
  fakeSessionPool,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import { fakeSecrets } from "../fakes/fakeVault";

const ISOLATED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const isolatedExec: ExecText = (file, args, options) => {
  const [flag, dir] = args;
  if (flag === "-C" && (dir === undefined || !isAbsolute(dir))) {
    return Promise.reject(
      new Error(`refusing git in non-absolute dir "${String(dir)}"`),
    );
  }
  return execText(file, args, {
    ...options,
    env: { ...ISOLATED_GIT_ENV, ...options?.env },
  });
};

function git(cwd: string, args: readonly string[]): Promise<string> {
  return isolatedExec("git", ["-C", cwd, ...args]);
}

const FILE_LISTING_ARGS = [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
] as const;

let root: string;
let home: string;
const openPorts: MessagePort[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cw-completion-")));
  home = join(root, "home");
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  for (const port of openPorts.splice(0)) {
    port.close();
  }
  await rm(root, { recursive: true, force: true });
});

function completionWith(
  overrides: Partial<FileCompletionDeps> = {},
): FileCompletion {
  return createFileCompletion({
    git,
    homeDir: home,
    protectedPaths: () => Promise.resolve([]),
    now: () => 1_000,
    ...overrides,
  });
}

async function handlersFor(
  files: FileCompletion,
): Promise<ReturnType<typeof createHandlers>> {
  const userData = join(root, "user-data");
  await mkdir(userData, { recursive: true });
  return createHandlers({
    store: createJsonStore(userData),
    ...fakeSecrets(userData),
    userData,
    homeDir: home,
    broadcast: () => undefined,
    sessions: fakeSessionPool(),
    history: fakeSessionHistory(),
    checkpoints: fakeCheckpointStore(),
    attachments: fakeAttachmentStore(),
    files,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    flowRuns: fakeFlowRuns(),
    orchestrator: fakeOrchestrator(),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals: fakeTerminals(),
    postUpdaterConfig: () => undefined,
    editedFiles: {
      observeMain: () => undefined,
      observeRun: () => undefined,
      forget: () => undefined,
      views: () => [],
    },
  });
}

async function createRepo(): Promise<string> {
  const repo = join(root, "project");
  await mkdir(join(repo, "src/backend"), { recursive: true });
  await mkdir(join(repo, "src/utils"), { recursive: true });
  await mkdir(join(repo, "notes"), { recursive: true });
  await mkdir(join(repo, "dist"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "dist/\n");
  await writeFile(join(repo, "README.md"), "# Project\n");
  await writeFile(join(repo, "src/backend/app.ts"), "export {};\n");
  await writeFile(join(repo, "src/utils/helper.ts"), "export {};\n");
  await writeFile(join(repo, "notes/sbk.txt"), "note\n");
  await writeFile(join(repo, "dist/bundle.js"), "bundle\n");
  await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "-m", "Initial commit"]);
  await writeFile(join(repo, "src/backend/extra.ts"), "export {};\n");
  return repo;
}

async function createWorkDir(): Promise<string> {
  const dir = join(root, "work");
  await mkdir(join(dir, "sub/nested"), { recursive: true });
  await mkdir(join(dir, "another"), { recursive: true });
  await mkdir(join(dir, ".config"), { recursive: true });
  await writeFile(join(dir, "alpha.txt"), "");
  await writeFile(join(dir, "visible.txt"), "");
  await writeFile(join(dir, ".secret"), "");
  await writeFile(join(dir, ".config/auth.json"), "");
  await writeFile(join(dir, "sub/artifact.txt"), "");
  await writeFile(join(dir, "sub/child.txt"), "");
  await writeFile(join(dir, "sub/zeta.txt"), "");
  return dir;
}

function pathsOf(items: readonly { path: string }[]): string[] {
  return items.map((item) => item.path);
}

describe("files/complete in a git repository", () => {
  it("lists tracked and untracked files with their ancestor dirs", async () => {
    const repo = await createRepo();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "src",
    });

    expect(result.items).toEqual([
      { path: "src", kind: "dir" },
      { path: "src/utils", kind: "dir" },
      { path: "src/backend", kind: "dir" },
      { path: "src/backend/app.ts", kind: "file" },
      { path: "src/utils/helper.ts", kind: "file" },
      { path: "src/backend/extra.ts", kind: "file" },
    ]);
  });

  it("never lists ignored files", async () => {
    const repo = await createRepo();
    const handlers = await handlersFor(completionWith());

    const ignored = await handlers["files/complete"]({
      cwd: repo,
      query: "bundle",
    });
    const topLevel = await handlers["files/complete"]({
      cwd: repo,
      query: "",
    });

    expect(ignored.items).toEqual([]);
    expect(pathsOf(topLevel.items)).toContain("src");
    expect(pathsOf(topLevel.items)).not.toContain("dist");
    expect(pathsOf(topLevel.items)).not.toContain("dist/bundle.js");
  });
});

describe("files/complete git repository matching", () => {
  it("ranks a basename substring match before a subsequence-only match", async () => {
    const repo = await createRepo();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "sbk",
    });

    expect(result.items).toEqual([
      { path: "notes/sbk.txt", kind: "file" },
      { path: "src/backend", kind: "dir" },
      { path: "src/backend/app.ts", kind: "file" },
      { path: "src/backend/extra.ts", kind: "file" },
    ]);
  });

  it("lists only top-level entries for an empty query, dirs first", async () => {
    const repo = await createRepo();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "",
    });

    expect(result.items).toEqual([
      { path: "notes", kind: "dir" },
      { path: "src", kind: "dir" },
      { path: ".gitignore", kind: "file" },
      { path: "README.md", kind: "file" },
    ]);
  });
});

describe("files/complete git entries", () => {
  it("untracked_nested_repo_is_one_dir_entry", async () => {
    const repo = await createRepo();
    await git(repo, ["init", "--quiet", "nested"]);
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "nested",
    });

    expect(result.items).toEqual([{ path: "nested", kind: "dir" }]);
  });

  it("astral_character_query_matches", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "😀.txt"), "emoji\n");
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "😀",
    });

    expect(result.items).toEqual([{ path: "😀.txt", kind: "file" }]);
  });

  it("submodule_is_listed_as_dir", async () => {
    const repo = await createRepo();
    const inner = join(repo, "inner");
    await mkdir(inner);
    await git(inner, ["init", "--quiet", "--initial-branch=main"]);
    await git(inner, ["config", "user.name", "Test"]);
    await git(inner, ["config", "user.email", "test@example.com"]);
    await writeFile(join(inner, "b.txt"), "inner\n");
    await git(inner, ["add", "-A"]);
    await git(inner, ["commit", "--quiet", "-m", "Inner"]);
    await git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "./inner",
      "sub",
    ]);
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "sub",
    });

    expect(result.items).toEqual([{ path: "sub", kind: "dir" }]);
  });
});

describe("files/complete git submodules", () => {
  it("nested_submodule_parent_dir_is_listed", async () => {
    const repo = await createRepo();
    const inner = join(repo, "inner");
    await mkdir(inner);
    await git(inner, ["init", "--quiet", "--initial-branch=main"]);
    await git(inner, ["config", "user.name", "Test"]);
    await git(inner, ["config", "user.email", "test@example.com"]);
    await writeFile(join(inner, "b.txt"), "inner\n");
    await git(inner, ["add", "-A"]);
    await git(inner, ["commit", "--quiet", "-m", "Inner"]);
    await git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "./inner",
      "vendor/lib",
    ]);
    const handlers = await handlersFor(completionWith());

    const topLevel = await handlers["files/complete"]({
      cwd: repo,
      query: "",
    });
    const fuzzy = await handlers["files/complete"]({
      cwd: repo,
      query: "vend",
    });

    expect(pathsOf(topLevel.items)).toContain("vendor");
    expect(pathsOf(fuzzy.items)).toEqual(["vendor", "vendor/lib"]);
  });
});

describe("files/complete git symlinks", () => {
  it("git_mode_hides_symlink_to_protected_target", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const fakeHome = join(root, "git-home");
    const codexDir = join(fakeHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    const credential = join(codexDir, "auth.json");
    await writeFile(credential, "{}");
    const repo = join(root, "symlink-repo");
    await mkdir(repo);
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "readme.txt"), "");
    try {
      await symlink(credential, join(repo, "token"));
      await symlink(codexDir, join(repo, "creds"), "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    await git(repo, ["add", "readme.txt", "token", "creds"]);
    await git(repo, ["commit", "--quiet", "-m", "Initial"]);
    await symlink(credential, join(repo, "utoken"));
    await symlink(codexDir, join(repo, "ucreds"), "dir");
    const handlers = await handlersFor(
      completionWith({
        protectedPaths: () => Promise.resolve([credential, codexDir]),
      }),
    );

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "",
    });

    expect(result.items).toEqual([{ path: "readme.txt", kind: "file" }]);
  });
});

describe("files/complete outside a repository", () => {
  it("lists visible entries of the base dirs first without dotfiles", async () => {
    const dir = await createWorkDir();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({ cwd: dir, query: "" });

    expect(result.items).toEqual([
      { path: "another", kind: "dir" },
      { path: "sub", kind: "dir" },
      { path: "alpha.txt", kind: "file" },
      { path: "visible.txt", kind: "file" },
    ]);
  });

  it("shows dotfiles when the name part starts with a dot", async () => {
    const dir = await createWorkDir();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({ cwd: dir, query: "." });

    expect(result.items).toEqual([
      { path: ".config", kind: "dir" },
      { path: ".secret", kind: "file" },
    ]);
  });

  it("lists the children of the directory part", async () => {
    const dir = await createWorkDir();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: dir,
      query: "sub/",
    });

    expect(result.items).toEqual([
      { path: "sub/nested", kind: "dir" },
      { path: "sub/artifact.txt", kind: "file" },
      { path: "sub/child.txt", kind: "file" },
      { path: "sub/zeta.txt", kind: "file" },
    ]);
  });

  it("filters the directory listing by the name prefix", async () => {
    const dir = await createWorkDir();
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: dir,
      query: "sub/a",
    });

    expect(result.items).toEqual([{ path: "sub/artifact.txt", kind: "file" }]);
  });
});

describe("files/complete symlink safety", () => {
  it("symlink_loop_is_skipped_not_fatal", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const dir = join(root, "loop-work");
    await mkdir(dir);
    await writeFile(join(dir, "real.txt"), "");
    try {
      await symlink("loop", join(dir, "loop"));
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({ cwd: dir, query: "" });

    expect(result.items).toEqual([{ path: "real.txt", kind: "file" }]);
  });

  it("symlink_into_protected_dir_lists_nothing_protected", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const fakeHome = join(root, "fake-home");
    const codexDir = join(fakeHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "auth.json"), "{}");
    await writeFile(join(codexDir, "config.toml"), "");
    const project = join(root, "project-with-link");
    await mkdir(project);
    try {
      await symlink(codexDir, join(project, "creds"), "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const handlers = await handlersFor(
      completionWith({
        protectedPaths: () => Promise.resolve([join(codexDir, "auth.json")]),
      }),
    );

    const result = await handlers["files/complete"]({
      cwd: project,
      query: "creds/",
    });

    expect(result.items).toEqual([{ path: "creds/config.toml", kind: "file" }]);
  });
});

describe("files/complete symlink entries", () => {
  it("symlink_entry_to_protected_target_is_hidden", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const fakeHome = join(root, "entry-home");
    const codexDir = join(fakeHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    const credential = join(codexDir, "auth.json");
    await writeFile(credential, "{}");
    const project = join(root, "entry-project");
    await mkdir(project);
    await writeFile(join(project, "readme.txt"), "");
    try {
      await symlink(credential, join(project, "token"));
      await symlink(codexDir, join(project, "creds"), "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const handlers = await handlersFor(
      completionWith({
        protectedPaths: () => Promise.resolve([credential, codexDir]),
      }),
    );

    const result = await handlers["files/complete"]({
      cwd: project,
      query: "",
    });

    expect(result.items).toEqual([{ path: "readme.txt", kind: "file" }]);
  });
});

describe("files/complete base resolution", () => {
  it("symlinked_base_into_protected_repo_lists_nothing", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const repo = await createRepo();
    const alias = join(root, "repo-alias");
    try {
      await symlink(repo, alias, "dir");
    } catch (error) {
      console.warn("symlink creation is not supported here", error);
      context.skip();
      return;
    }
    const handlers = await handlersFor(
      completionWith({ protectedPaths: () => Promise.resolve([repo]) }),
    );

    const result = await handlers["files/complete"]({
      cwd: alias,
      query: "",
    });

    expect(result.items).toEqual([]);
  });
});

describe("files/complete base selection", () => {
  it("uses the home dir as the base when cwd is missing", async () => {
    const customHome = join(root, "custom-home");
    await mkdir(customHome, { recursive: true });
    await writeFile(join(customHome, "home.txt"), "");
    const handlers = await handlersFor(completionWith({ homeDir: customHome }));

    const result = await handlers["files/complete"]({ query: "" });

    expect(result.items).toEqual([{ path: "home.txt", kind: "file" }]);
  });

  it("returns nothing for a nonexistent directory part", async () => {
    const dir = await createWorkDir();
    const handlers = await handlersFor(completionWith());

    const present = await handlers["files/complete"]({
      cwd: dir,
      query: "sub/",
    });
    const missing = await handlers["files/complete"]({
      cwd: dir,
      query: "missing/",
    });

    expect(present.items).not.toEqual([]);
    expect(missing.items).toEqual([]);
  });
});

describe("files/complete filtering and limits", () => {
  it("never returns protected paths", async () => {
    const guardedHome = join(root, "guarded-home");
    const codexDir = join(guardedHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "auth.json"), "{}");
    await writeFile(join(codexDir, "config.toml"), "");
    const handlers = await handlersFor(
      completionWith({
        homeDir: guardedHome,
        protectedPaths: () => Promise.resolve([join(codexDir, "auth.json")]),
      }),
    );

    const result = await handlers["files/complete"]({ query: ".codex/" });

    expect(result.items).toEqual([
      { path: ".codex/config.toml", kind: "file" },
    ]);
  });

  it("caps the result at fifty entries", async () => {
    const bigDir = join(root, "big");
    await mkdir(bigDir, { recursive: true });
    const names = Array.from(
      { length: 60 },
      (_value, index) => `file-${String(index).padStart(2, "0")}.txt`,
    );
    await Promise.all(names.map((name) => writeFile(join(bigDir, name), "")));
    const handlers = await handlersFor(completionWith());

    const result = await handlers["files/complete"]({
      cwd: bigDir,
      query: "",
    });

    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toEqual({ path: "file-00.txt", kind: "file" });
    expect(result.items.at(-1)).toEqual({
      path: "file-49.txt",
      kind: "file",
    });
  });
});

describe("files/complete query boundaries", () => {
  it("returns nothing for a parent escape or an absolute query", async () => {
    const repo = await createRepo();
    const handlers = await handlersFor(completionWith());

    const escaping = await handlers["files/complete"]({
      cwd: repo,
      query: "../x",
    });
    const nested = await handlers["files/complete"]({
      cwd: repo,
      query: "src/../../../x",
    });
    const absolute = await handlers["files/complete"]({
      cwd: repo,
      query: "/etc/passwd",
    });
    const inside = await handlers["files/complete"]({
      cwd: repo,
      query: "src",
    });

    expect(pathsOf(inside.items)).toContain("src/backend/app.ts");
    expect(escaping.items).toEqual([]);
    expect(nested.items).toEqual([]);
    expect(absolute.items).toEqual([]);
  });
});

describe("files/complete git index cache", () => {
  it("caches the index for the ttl and rebuilds after it", async () => {
    const repo = await createRepo();
    let clock = 1_000;
    let listings = 0;
    const files = completionWith({
      git: (cwd, args) => {
        if (args[0] === "ls-files") {
          listings += 1;
        }
        return git(cwd, args);
      },
      now: () => clock,
    });
    const handlers = await handlersFor(files);
    const complete = async (): Promise<{ items: FileCompletionItem[] }> =>
      handlers["files/complete"]({ cwd: repo, query: "src" });

    await complete();
    const nearExpiry = 1_000 + FILE_INDEX_TTL_MS - 1;
    clock = nearExpiry;
    await complete();
    expect(listings).toBe(1);

    clock = 1_000 + FILE_INDEX_TTL_MS;
    await complete();

    expect(listings).toBe(2);
  });
});

describe("files/complete concurrent index builds", () => {
  it("shares one build between two concurrent calls", async () => {
    const repo = await createRepo();
    const listing = await git(repo, FILE_LISTING_ARGS);
    const gate = Promise.withResolvers<string>();
    let listings = 0;
    const files = completionWith({
      git: (cwd, args) => {
        if (args[0] !== "ls-files") {
          return git(cwd, args);
        }
        listings += 1;
        return gate.promise;
      },
    });
    const handlers = await handlersFor(files);

    const first = handlers["files/complete"]({ cwd: repo, query: "src" });
    const second = handlers["files/complete"]({ cwd: repo, query: "src" });
    await vi.waitFor(() => {
      expect(listings).toBe(1);
    });
    gate.resolve(listing);

    const [left, right] = await Promise.all([first, second]);

    expect(listings).toBe(1);
    expect(left).toEqual(right);
    expect(pathsOf(left.items)).toContain("src/backend/app.ts");
  });
});

describe("files/complete index failures", () => {
  it("retries a failed build only after the ttl", async () => {
    const repo = await createRepo();
    let clock = 1_000;
    let listings = 0;
    const files = completionWith({
      git: (cwd, args) => {
        if (args[0] !== "ls-files") {
          return git(cwd, args);
        }
        listings += 1;
        return listings === 1
          ? Promise.reject(new Error("git ls-files failed"))
          : git(cwd, args);
      },
      now: () => clock,
    });
    const handlers = await handlersFor(files);

    const failed = await handlers["files/complete"]({
      cwd: repo,
      query: "src",
    });
    clock = 1_000 + 4_000;
    const cached = await handlers["files/complete"]({
      cwd: repo,
      query: "src",
    });
    expect(failed.items).toEqual([{ path: "src", kind: "dir" }]);
    expect(cached.items).toEqual([{ path: "src", kind: "dir" }]);
    expect(listings).toBe(1);

    clock = 1_000 + FILE_INDEX_TTL_MS;
    const retried = await handlers["files/complete"]({
      cwd: repo,
      query: "src",
    });

    expect(pathsOf(retried.items)).toContain("src/backend/app.ts");
    expect(listings).toBe(2);
  });

  it("falls back to directory listing when git ls-files throws", async () => {
    const repo = await createRepo();
    const files = completionWith({
      git: (cwd, args) =>
        args[0] === "ls-files"
          ? Promise.reject(new Error("maxBuffer exceeded"))
          : git(cwd, args),
    });
    const handlers = await handlersFor(files);

    const result = await handlers["files/complete"]({
      cwd: repo,
      query: "src/utils/",
    });

    expect(result.items).toEqual([
      { path: "src/utils/helper.ts", kind: "file" },
    ]);
  });
});

describe("files/complete index timeouts", () => {
  it("git_failure_is_not_retried_within_ttl", async () => {
    const repo = await createRepo();
    let clock = 1_000;
    let listings = 0;
    const files = completionWith({
      git: (cwd, args) => {
        if (args[0] !== "ls-files") {
          return git(cwd, args);
        }
        listings += 1;
        return Promise.reject(new Error("git ls-files timed out"));
      },
      now: () => clock,
    });
    const handlers = await handlersFor(files);
    const complete = async (): Promise<unknown> =>
      handlers["files/complete"]({ cwd: repo, query: "src" });

    await complete();
    await complete();
    expect(listings).toBe(1);

    clock = 1_000 + FILE_INDEX_TTL_MS;
    await complete();

    expect(listings).toBe(2);
  });

  it("git_calls_use_short_timeout", async () => {
    const repo = await createRepo();
    const timeouts: (number | undefined)[] = [];
    const files = completionWith({
      git: (cwd: string, args: readonly string[], timeoutMs?: number) => {
        timeouts.push(timeoutMs);
        return git(cwd, args);
      },
    });
    const handlers = await handlersFor(files);

    await handlers["files/complete"]({ cwd: repo, query: "src" });

    expect(timeouts).toEqual([3_000, 3_000]);
  });
});

describe("files/complete protocol", () => {
  it("rejects a query longer than the limit with VALIDATION", async () => {
    const handlers = await handlersFor(completionWith());
    const { port1, port2 } = new MessageChannel();
    openPorts.push(port1, port2);
    createIpcServer(fromNodePort(port1), handlers);

    const response = await new Promise<unknown>((resolve) => {
      port2.once("message", resolve);
      port2.postMessage({
        v: 7,
        id: "f-1",
        method: "files/complete",
        params: { query: "x".repeat(257) },
      });
    });

    expect(response).toEqual({
      v: 7,
      id: "f-1",
      ok: false,
      error: {
        code: IpcErrorCode.VALIDATION,
        message: expect.any(String) as string,
      },
    });
  });
});
