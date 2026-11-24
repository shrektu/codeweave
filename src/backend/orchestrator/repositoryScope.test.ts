import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionContext } from "../../domain/pathScope";
import type { WorktreeState } from "../../domain/types";
import { IpcError, IpcErrorCode } from "../../shared/protocol";

import {
  assertAllowedRepositoryPath,
  createRepositoryScope,
  repositoryKey,
  resolveLexicalRepository,
  type RepositoryScope,
} from "./repositoryScope";

const OUTSIDE = "The repository is outside the session folder";
const PROTECTED = "The repository is a protected location";
const INVALID = "The repository must be a path to a git repository";
const UNREADABLE = "The repository path cannot be resolved";
const NUM_RUNS = 300;

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly protectedPaths: string[];
  readonly projectRootCalls: string[];
  readonly projectRoots: Map<string, string>;
  readonly inspect: ReturnType<
    typeof vi.fn<(cwd: string) => Promise<WorktreeState>>
  >;
  scope(sessionCwd?: string): RepositoryScope;
}

let tempRoot = "";

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cw-scope-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const protectedPaths = [join(root, ".ssh"), join(root, "userdata")];
  const projectRootCalls: string[] = [];
  const projectRoots = new Map<string, string>();
  const inspect = vi.fn<(cwd: string) => Promise<WorktreeState>>((cwd) =>
    Promise.resolve({ isRepo: false, cwd }),
  );
  tempRoot = root;
  return {
    root,
    workspace,
    protectedPaths,
    projectRootCalls,
    projectRoots,
    inspect,
    scope: (sessionCwd = workspace) =>
      createRepositoryScope({
        sessionCwd: () => sessionCwd,
        homeDir: root,
        platform: process.platform,
        inspectWorktree: inspect,
        protectedPaths: () => Promise.resolve(protectedPaths),
        resolveProjectRoot: (cwd) => {
          projectRootCalls.push(cwd);
          return Promise.resolve(projectRoots.get(cwd) ?? cwd);
        },
      }),
  };
}

async function failureOf(call: Promise<unknown>): Promise<IpcError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof IpcError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempRoot !== "") {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("path forms", () => {
  it("accepts_relative_dot_tilde_absolute_trailing_slash_and_the_root_itself", async () => {
    const fx = await makeFixture();
    const beta = join(fx.workspace, "beta");
    await mkdir(beta);
    const scope = fx.scope();

    const resolved = await Promise.all(
      [
        "beta",
        "./beta",
        "beta/",
        "../workspace/beta",
        "~/workspace/beta",
        beta,
      ].map((raw) => scope.resolveRepository(raw)),
    );

    expect(resolved).toEqual(Array.from({ length: 6 }, () => beta));
    expect(await scope.resolveRepository(".")).toBe(fx.workspace);
    expect(await scope.resolveRepository(fx.workspace)).toBe(fx.workspace);
  });

  it("returns_the_git_toplevel_of_a_subfolder", async () => {
    const fx = await makeFixture();
    const sub = join(fx.workspace, "alpha", "packages");
    await mkdir(sub, { recursive: true });
    fx.projectRoots.set(sub, join(fx.workspace, "alpha"));

    const resolved = await fx.scope().resolveRepository("alpha/packages");

    expect(resolved).toBe(join(fx.workspace, "alpha"));
  });

  it("resolves_a_path_through_a_symlink_to_its_real_location", async () => {
    const fx = await makeFixture();
    const real = join(fx.workspace, "real");
    await mkdir(real);
    await symlink(real, join(fx.workspace, "alias"), "dir");

    expect(await fx.scope().resolveRepository("alias")).toBe(real);
  });
});

describe("rejections", () => {
  it("rejects_repository_outside_root_and_symlink_escapes", async () => {
    const fx = await makeFixture();
    await mkdir(join(fx.root, "workspace-other"));
    await mkdir(join(fx.root, "elsewhere"));
    await symlink(
      join(fx.root, "elsewhere"),
      join(fx.workspace, "escape"),
      "dir",
    );
    await symlink(join(fx.root, "loop-b"), join(fx.root, "loop-a"));
    await symlink(join(fx.root, "loop-a"), join(fx.root, "loop-b"));
    const scope = fx.scope();

    for (const raw of [
      "../loop-a",
      "../elsewhere",
      "../workspace-other",
      join(fx.root, "elsewhere"),
      "escape",
      "escape/missing",
      "/",
      "~",
    ]) {
      const error = await failureOf(scope.resolveRepository(raw));
      expect(error.code, raw).toBe(IpcErrorCode.VALIDATION);
      expect(error.message, raw).toBe(OUTSIDE);
    }
    expect(fx.projectRootCalls).toEqual([]);
  });
});

describe("protected paths", () => {
  it("rejects_protected_paths_wildcards_symlinks_and_protected_root", async () => {
    const fx = await makeFixture();
    const wideScope = (): RepositoryScope => {
      fx.inspect.mockResolvedValue({ isRepo: false, cwd: fx.root });
      return fx.scope(fx.root);
    };
    await mkdir(join(fx.root, ".ssh", "keys"), { recursive: true });
    await mkdir(join(fx.root, "userdata", "child"), { recursive: true });
    await mkdir(join(fx.root, "proj"));
    fx.protectedPaths.push(join(fx.root, ".config", "*", "auth-repo"));
    await mkdir(join(fx.root, ".config", "app", "auth-repo"), {
      recursive: true,
    });
    await symlink(join(fx.root, ".ssh"), join(fx.root, "proj", "link"), "dir");
    const scope = wideScope();

    for (const raw of [
      "~/.ssh",
      ".ssh/keys",
      "userdata",
      "userdata/child",
      ".config/app/auth-repo",
      "proj/link",
      "proj/link/keys",
    ]) {
      const error = await failureOf(scope.resolveRepository(raw));
      expect(error.code, raw).toBe(IpcErrorCode.VALIDATION);
      expect(error.message, raw).toBe(PROTECTED);
    }
    expect(fx.projectRootCalls).toEqual([]);
    expect(await scope.resolveRepository("proj")).toBe(join(fx.root, "proj"));

    fx.protectedPaths.push(fx.root);
    expect((await failureOf(scope.resolveRepository("proj"))).message).toBe(
      PROTECTED,
    );
  });
});

describe("invalid input", () => {
  it("rejects_blank_nul_variable_and_other_user_paths_without_touching_git", async () => {
    const fx = await makeFixture();
    const scope = fx.scope();

    for (const raw of [
      "",
      "   ",
      "a\0b",
      "$HOME/repo",
      "~other/repo",
      "~\\repo",
    ]) {
      const error = await failureOf(scope.resolveRepository(raw));
      expect(error.code, JSON.stringify(raw)).toBe(IpcErrorCode.VALIDATION);
      expect(error.message, JSON.stringify(raw)).toBe(INVALID);
    }
    expect(fx.projectRootCalls).toEqual([]);
  });

  it("rejects_a_git_toplevel_that_escapes_the_permission_root_or_is_protected", async () => {
    const fx = await makeFixture();
    const inside = join(fx.workspace, "sub");
    await mkdir(inside);
    fx.projectRoots.set(inside, fx.root);
    expect((await failureOf(fx.scope().resolveRepository("sub"))).message).toBe(
      OUTSIDE,
    );
    expect(fx.projectRootCalls).toEqual([inside]);

    await mkdir(join(fx.workspace, "node"));
    fx.protectedPaths.push(join(fx.workspace, "vault"));
    fx.projectRoots.set(
      join(fx.workspace, "node"),
      join(fx.workspace, "vault"),
    );
    expect(
      (await failureOf(fx.scope().resolveRepository("node"))).message,
    ).toBe(PROTECTED);
  });
});

describe("unresolvable paths", () => {
  it("rejects_symlink_loops_with_a_validation_error_and_a_warning", async () => {
    const fx = await makeFixture();
    await symlink(join(fx.workspace, "b"), join(fx.workspace, "a"));
    await symlink(join(fx.workspace, "a"), join(fx.workspace, "b"));

    const error = await failureOf(fx.scope().resolveRepository("a"));

    expect(error.code).toBe(IpcErrorCode.VALIDATION);
    expect(error.message).toBe(UNREADABLE);
    expect(console.warn).toHaveBeenCalled();
    expect(fx.projectRootCalls).toEqual([]);
  });
});

describe("permission root", () => {
  it("uses_the_git_toplevel_of_a_session_started_in_a_subfolder", async () => {
    const fx = await makeFixture();
    const repo = join(fx.workspace, "alpha");
    const sub = join(repo, "packages");
    await mkdir(sub, { recursive: true });
    await mkdir(join(fx.workspace, "beta"));
    fx.inspect.mockResolvedValue({
      isRepo: true,
      root: repo,
      porcelain: "",
      diffStat: "",
    });
    const scope = fx.scope(sub);

    expect(await scope.resolveRepository(repo)).toBe(repo);
    expect(
      (await failureOf(scope.resolveRepository(join(fx.workspace, "beta"))))
        .message,
    ).toBe(OUTSIDE);
    expect(await scope.sessionExclusivityKey()).toBe(
      repositoryKey(repo, process.platform),
    );
  });

  it("computes_the_root_once_and_retries_after_a_failure", async () => {
    const fx = await makeFixture();
    await mkdir(join(fx.workspace, "beta"));
    const scope = fx.scope();
    fx.inspect.mockRejectedValueOnce(new Error("git gone"));

    await expect(scope.resolveRepository("beta")).rejects.toThrow("git gone");
    await scope.resolveRepository("beta");
    await scope.resolveRepository("beta");

    expect(fx.inspect).toHaveBeenCalledTimes(2);
  });

  it("keys_the_session_by_its_real_folder", async () => {
    const fx = await makeFixture();
    await symlink(fx.workspace, join(fx.root, "alias"), "dir");

    const key = await fx.scope(join(fx.root, "alias")).sessionExclusivityKey();

    expect(key).toBe(repositoryKey(fx.workspace, process.platform));
  });
});

const POSIX_CTX: PermissionContext = {
  worktreeRoots: ["/ws"],
  homeDir: "/home/u",
  protectedPaths: ["/home/u/.ssh", "/ws/.secret", "/ws/.config/*/auth-repo"],
};
const WIN_CTX: PermissionContext = {
  worktreeRoots: ["C:\\Work"],
  homeDir: "C:\\Users\\u",
  protectedPaths: ["C:\\Users\\u\\.ssh", "C:\\Work\\.secret"],
};

function winAccepted(raw: string): string {
  return resolveLexicalRepository(raw, WIN_CTX, "C:\\Work", "win32");
}

function winAllowed(raw: string, ctx: PermissionContext = WIN_CTX): void {
  assertAllowedRepositoryPath(winAccepted(raw), ctx, "win32");
}

describe("platform forms", () => {
  it("accepts_win32_drive_slash_and_tilde_forms_inside_the_root", () => {
    expect(winAccepted("C:\\Work\\repo")).toBe("C:\\Work\\repo");
    expect(winAccepted("C:/Work/repo")).toBe("C:\\Work\\repo");
    expect(winAccepted("repo")).toBe("C:\\Work\\repo");
    expect(winAccepted("~\\repo")).toBe("C:\\Users\\u\\repo");
    expect(winAccepted("~/repo")).toBe("C:\\Users\\u\\repo");
    expect(() => {
      winAllowed("C:\\Work\\repo");
    }).not.toThrow();
    expect(() => {
      winAllowed("c:\\work\\Repo");
    }).not.toThrow();
  });

  it("rejects_win32_other_drives_and_case_folded_protected_paths", () => {
    const homeRoot = { ...WIN_CTX, worktreeRoots: ["C:\\Users\\u"] } as const;
    expect(() => {
      winAllowed("D:\\repo");
    }).toThrow(OUTSIDE);
    expect(() => {
      winAllowed("c:\\work\\.SECRET\\x");
    }).toThrow(PROTECTED);
    expect(() => {
      winAllowed("c:\\users\\U\\.SSH", homeRoot);
    }).toThrow(PROTECTED);
  });

  it("refuses_a_backslash_tilde_path_on_linux", () => {
    expect(() =>
      resolveLexicalRepository("~\\repo", POSIX_CTX, "/ws", "linux"),
    ).toThrow(INVALID);
  });

  it("folds_the_repository_key_on_win32_and_darwin_only", () => {
    expect(repositoryKey("C:\\Work\\Repo", "win32")).toBe(
      repositoryKey("c:\\work\\repo", "win32"),
    );
    expect(repositoryKey("/Users/U/Repo", "darwin")).toBe(
      repositoryKey("/users/u/repo", "darwin"),
    );
    expect(repositoryKey("/Users/U/Repo", "linux")).not.toBe(
      repositoryKey("/users/u/repo", "linux"),
    );
  });
});

const SEGMENT = fc.constantFrom("a", "b", "..", ".", ".secret", "x y");
const PROTECTED_PREFIXES: readonly string[] = [
  "/home/u/.ssh",
  "/ws/.secret",
  "/ws/.config/app/auth-repo",
];

function outcomeOf(raw: string): string | IpcError {
  try {
    const resolved = resolveLexicalRepository(raw, POSIX_CTX, "/ws", "linux");
    assertAllowedRepositoryPath(resolved, POSIX_CTX, "linux");
    return resolved;
  } catch (error) {
    if (error instanceof IpcError) {
      return error;
    }
    throw error;
  }
}

describe("repository path properties", () => {
  it("relative_paths_resolve_inside_the_root_unprotected_or_fail_validation", () => {
    fc.assert(
      fc.property(fc.array(SEGMENT, { maxLength: 8 }), (segments) => {
        const outcome = outcomeOf(segments.join("/") || ".");
        if (outcome instanceof IpcError) {
          expect(outcome.code).toBe(IpcErrorCode.VALIDATION);
          return;
        }
        expect(outcome === "/ws" || outcome.startsWith("/ws/")).toBe(true);
        expect(outcome === "/ws/.secret").toBe(false);
        expect(outcome.startsWith("/ws/.secret/")).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("paths_under_any_protected_prefix_always_fail_validation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_PREFIXES),
        fc.array(fc.constantFrom("a", "b", "c d"), { maxLength: 4 }),
        (prefix, tail) => {
          const outcome = outcomeOf([prefix, ...tail].join("/"));
          expect(outcome).toBeInstanceOf(IpcError);
          expect(outcome).toMatchObject({ code: IpcErrorCode.VALIDATION });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
