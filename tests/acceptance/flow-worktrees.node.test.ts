import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFlowWorktrees,
  type FlowWorktree,
  type FlowWorktrees,
} from "../../src/backend/flowWorktrees";
import { execText, type ExecText } from "../../src/backend/exec";
import { IpcError, IpcErrorCode } from "../../src/shared/protocol";
import { MergeStatus } from "../../src/domain/types";

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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return isolatedExec("git", ["-C", cwd, ...args]);
}

async function createRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet", "--initial-branch=main"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await writeFile(join(dir, "b.txt"), "bee\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", "Initial commit"]);
}

async function commitFile(
  dir: string,
  name: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(dir, name), content);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", message]);
}

const RUN_ID = "0123456789abcdef";

let root: string;
let repo: string;
let flows: FlowWorktrees;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cw-flow-wt-")));
  repo = join(root, "project");
  await createRepo(repo);
  flows = createFlowWorktrees({ exec: isolatedExec });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function conflictingWorktree(): Promise<FlowWorktree> {
  const worktree = await flows.create(repo, RUN_ID);
  await commitFile(worktree.path, "a.txt", "from flow\n", "Flow edit");
  await commitFile(repo, "a.txt", "from main\n", "Main edit");
  return worktree;
}

describe("create", () => {
  it("creates a worktree on codeweave/<runId> at the project HEAD", async () => {
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const worktree = await flows.create(repo, RUN_ID);

    expect(worktree.runId).toBe(RUN_ID);
    expect(worktree.projectRoot).toBe(repo);
    expect(worktree.branch).toBe(`codeweave/${RUN_ID}`);
    expect(worktree.base).toBe(head);
    expect(worktree.path).toBe(
      join(dirname(repo), ".worktrees", `${basename(repo)}-cw-01234567`),
    );
    expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
    expect(
      (await git(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
    ).toBe(worktree.branch);
    expect((await git(worktree.path, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  it("throws CONFLICT on a dirty project and creates nothing", async () => {
    await writeFile(join(repo, "a.txt"), "dirty\n");

    const failure = await flows.create(repo, RUN_ID).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(IpcError);
    expect(failure).toMatchObject({ code: IpcErrorCode.CONFLICT });
    expect(existsSync(join(root, ".worktrees"))).toBe(false);
    expect(await git(repo, ["branch", "--list", `codeweave/*`])).toBe("");
  });

  it("throws VALIDATION outside a git repo", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);

    const failure = await flows.create(plain, RUN_ID).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(IpcError);
    expect(failure).toMatchObject({ code: IpcErrorCode.VALIDATION });
  });
});

describe("create guard", () => {
  it("worktree-destination-uses-git-toplevel", async () => {
    await mkdir(join(repo, "packages"));
    const seen: string[] = [];

    await flows.create(join(repo, "packages"), RUN_ID, (worktreesDir) => {
      seen.push(worktreesDir);
      return Promise.resolve();
    });

    const expected = join(root, ".worktrees");
    expect(seen).toEqual([expected, expected]);
  });

  it.skipIf(process.platform === "win32")(
    "worktree-destination-swapped-after-check-is-removed",
    async () => {
      const outside = join(root, "outside");
      await mkdir(outside);
      const destination = join(root, ".worktrees");
      let calls = 0;

      const failure = await flows
        .create(repo, RUN_ID, async () => {
          calls += 1;
          if (calls === 1) {
            await symlink(outside, destination, "dir");
          }
        })
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(IpcError);
      expect(failure).toMatchObject({ code: IpcErrorCode.VALIDATION });
      expect(await readdir(outside)).toEqual([]);
      expect(
        await git(repo, ["worktree", "list", "--porcelain"]),
      ).not.toContain("codeweave/");
      expect(await git(repo, ["branch", "--list", "codeweave/*"])).toBe("");
    },
  );
});

describe("commitAll", () => {
  it("returns null when nothing changed", async () => {
    const worktree = await flows.create(repo, RUN_ID);

    expect(await flows.commitAll(worktree, "noop")).toBeNull();
  });

  it("returns the new HEAD sha for modified and untracked files", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await writeFile(join(worktree.path, "a.txt"), "changed\n");
    await writeFile(join(worktree.path, "new.txt"), "new\n");

    const sha = await flows.commitAll(worktree, "Flow work");

    const head = (await git(worktree.path, ["rev-parse", "HEAD"])).trim();
    expect(sha).toBe(head);
    expect(sha).not.toBe(worktree.base);
    expect(
      (await git(worktree.path, ["show", "--name-only", "--format=", "HEAD"]))
        .trim()
        .split("\n")
        .sort(),
    ).toEqual(["a.txt", "new.txt"]);
  });
});

describe("diff", () => {
  it("shows modified, deleted and untracked files against base", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await writeFile(join(worktree.path, "a.txt"), "changed\n");
    await rm(join(worktree.path, "b.txt"));
    await writeFile(join(worktree.path, "new.txt"), "brand new\n");

    const text = await flows.diff(worktree);

    expect(text).toContain("+changed");
    expect(text).toContain("deleted file mode");
    expect(text).toContain("diff --git a/b.txt b/b.txt");
    expect(text).toContain("+brand new");
    expect(text).toContain("diff --git a/new.txt b/new.txt");
  });
});

describe("workingDiff", () => {
  it("lists untracked files after the tracked diff and leaves the index unchanged", async () => {
    await writeFile(join(repo, "a.txt"), "changed\n");
    await writeFile(join(repo, "new.txt"), "brand new\n");
    const indexBefore = await git(repo, ["status", "--porcelain=v2"]);

    const text = await flows.workingDiff(repo);

    expect(text).toContain("diff --git a/a.txt b/a.txt");
    expect(text).toContain("+changed");
    expect(text.endsWith("\nUntracked files:\nnew.txt\n")).toBe(true);
    expect(text).not.toContain("+brand new");
    expect(await git(repo, ["status", "--porcelain=v2"])).toBe(indexBefore);
    expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("returns only the tracked diff when nothing is untracked", async () => {
    await writeFile(join(repo, "a.txt"), "changed\n");

    const text = await flows.workingDiff(repo);

    expect(text).toContain("+changed");
    expect(text).not.toContain("Untracked files:");
  });
});

describe("isDirty", () => {
  it("is true for an untracked file and false for a clean tree", async () => {
    expect(await flows.isDirty(repo)).toBe(false);

    await writeFile(join(repo, "new.txt"), "brand new\n");

    expect(await flows.isDirty(repo)).toBe(true);
  });
});

describe("merge", () => {
  it("merges a non-conflicting branch with a merge commit", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await writeFile(join(worktree.path, "flow.txt"), "flow\n");
    await flows.commitAll(worktree, "Flow work");
    await commitFile(repo, "main.txt", "main\n", "Main work");

    const outcome = await flows.merge(worktree);

    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    expect(outcome).toEqual({ status: MergeStatus.merged, commit: head });
    expect(
      (await git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]))
        .trim()
        .split(" "),
    ).toHaveLength(3);
    expect(await readFile(join(repo, "flow.txt"), "utf8")).toBe("flow\n");
  });

  it("returns exactly the conflicted files and leaves MERGE_HEAD", async () => {
    const worktree = await conflictingWorktree();
    await commitFile(worktree.path, "c.txt", "flow c\n", "Flow c");

    const outcome = await flows.merge(worktree);

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["a.txt"],
    });
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("refuses to merge into a dirty project", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await commitFile(worktree.path, "flow.txt", "flow\n", "Flow work");
    await writeFile(join(repo, "a.txt"), "dirty\n");

    const failure = await flows.merge(worktree).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(IpcError);
    expect(failure).toMatchObject({ code: IpcErrorCode.CONFLICT });
  });

  it("refuses to merge while another merge is in progress", async () => {
    const worktree = await conflictingWorktree();
    await flows.merge(worktree);

    const failure = await flows.merge(worktree).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(IpcError);
    expect(failure).toMatchObject({ code: IpcErrorCode.CONFLICT });
  });
});

describe("finishMerge", () => {
  it("returns conflict while markers remain and merged once resolved", async () => {
    const worktree = await conflictingWorktree();
    await flows.merge(worktree);

    const pending = await flows.finishMerge(worktree);
    expect(pending).toEqual({ status: MergeStatus.conflict, files: ["a.txt"] });

    await writeFile(join(repo, "a.txt"), "resolved\n");
    const done = await flows.finishMerge(worktree);

    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    expect(done).toEqual({ status: MergeStatus.merged, commit: head });
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("resolved\n");
  });
});

describe("abortMerge", () => {
  it("restores the pre-merge HEAD and a clean tree", async () => {
    const worktree = await conflictingWorktree();
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await flows.merge(worktree);

    await flows.abortMerge(worktree);

    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });
});

describe("remove", () => {
  it("deletes the worktree dir and branch after a merge", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await writeFile(join(worktree.path, "flow.txt"), "flow\n");
    await flows.commitAll(worktree, "Flow work");
    await flows.merge(worktree);

    await flows.remove(worktree);

    expect(existsSync(worktree.path)).toBe(false);
    expect(await git(repo, ["branch", "--list", worktree.branch])).toBe("");
  });

  it("keeps an unmerged worktree when remove is refused", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await writeFile(join(worktree.path, "flow.txt"), "flow\n");
    await flows.commitAll(worktree, "Flow work");

    await expect(flows.remove(worktree)).rejects.toThrow();

    expect(existsSync(worktree.path)).toBe(true);
    expect(
      (await git(repo, ["branch", "--list", worktree.branch])).trim(),
    ).toContain(worktree.branch);
  });
});

describe("conflicts git leaves without text markers", () => {
  it("keeps a binary conflict unresolved", async () => {
    await commitFile(repo, "bin.dat", "base\0\n", "Add binary");
    const worktree = await flows.create(repo, RUN_ID);
    await commitFile(worktree.path, "bin.dat", "flow\0\n", "Flow binary");
    await commitFile(repo, "bin.dat", "main\0\n", "Main binary");
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const merged = await flows.merge(worktree);
    const first = await flows.finishMerge(worktree);
    const second = await flows.finishMerge(worktree);

    const expected = { status: MergeStatus.conflict, files: ["bin.dat"] };
    expect(merged).toEqual(expected);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  });

  it("keeps a modify/delete conflict unresolved", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await commitFile(worktree.path, "a.txt", "flow edit\n", "Flow edit");
    await git(repo, ["rm", "--quiet", "a.txt"]);
    await git(repo, ["commit", "--quiet", "-m", "Main delete"]);
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const merged = await flows.merge(worktree);
    const finished = await flows.finishMerge(worktree);

    const expected = { status: MergeStatus.conflict, files: ["a.txt"] };
    expect(merged).toEqual(expected);
    expect(finished).toEqual(expected);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  });

  it("reports non-ascii conflict paths verbatim", async () => {
    await commitFile(repo, "zażółć.txt", "base\n", "Add unicode file");
    const worktree = await flows.create(repo, RUN_ID);
    await commitFile(worktree.path, "zażółć.txt", "flow\n", "Flow edit");
    await commitFile(repo, "zażółć.txt", "main\n", "Main edit");

    const merged = await flows.merge(worktree);
    const pending = await flows.finishMerge(worktree);
    await writeFile(join(repo, "zażółć.txt"), "resolved\n");
    const done = await flows.finishMerge(worktree);

    const expected = { status: MergeStatus.conflict, files: ["zażółć.txt"] };
    expect(merged).toEqual(expected);
    expect(pending).toEqual(expected);
    expect(done.status).toBe(MergeStatus.merged);
  });

  it("reports a rename/rename conflict without throwing", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await git(worktree.path, ["mv", "a.txt", "flow-name.txt"]);
    await git(worktree.path, ["commit", "--quiet", "-m", "Flow rename"]);
    await git(repo, ["mv", "a.txt", "main-name.txt"]);
    await git(repo, ["commit", "--quiet", "-m", "Main rename"]);

    const merged = await flows.merge(worktree);
    const finished = await flows.finishMerge(worktree);

    expect(merged.status).toBe(MergeStatus.conflict);
    expect(finished).toEqual(merged);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  });
});

async function commitIndexEntry(
  dir: string,
  mode: string,
  object: string,
  name: string,
): Promise<void> {
  await git(dir, [
    "update-index",
    "--add",
    "--cacheinfo",
    `${mode},${object},${name}`,
  ]);
  await git(dir, ["commit", "--quiet", "-m", `Set ${name}`]);
}

async function commitSymlink(
  dir: string,
  name: string,
  target: string,
): Promise<void> {
  const source = join(root, "link-target.tmp");
  await writeFile(source, target);
  const blob = (await git(dir, ["hash-object", "-w", source])).trim();
  await commitIndexEntry(dir, "120000", blob, name);
  await rm(join(dir, name), { force: true });
  await git(dir, ["checkout", "--quiet", "--", name]);
}

async function emptyCommit(message: string): Promise<string> {
  await git(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

describe("special-file conflicts", () => {
  it("keeps a symlink conflict unresolved", async () => {
    await commitFile(repo, "c.txt", "clean main text\n", "Add c");
    await commitSymlink(repo, "link", "a.txt");
    const worktree = await flows.create(repo, RUN_ID);
    await commitSymlink(worktree.path, "link", "b.txt");
    await commitSymlink(repo, "link", "c.txt");
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const merged = await flows.merge(worktree);
    const finished = await flows.finishMerge(worktree);

    const expected = { status: MergeStatus.conflict, files: ["link"] };
    expect(merged).toEqual(expected);
    expect(finished).toEqual(expected);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  });

  it("reports a submodule conflict without throwing", async () => {
    const original = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const flowSide = await emptyCommit("Flow submodule commit");
    const mainSide = await emptyCommit("Main submodule commit");
    await commitIndexEntry(repo, "160000", original, "sub");
    await mkdir(join(repo, "sub"));
    const worktree = await flows.create(repo, RUN_ID);
    await commitIndexEntry(worktree.path, "160000", flowSide, "sub");
    await commitIndexEntry(repo, "160000", mainSide, "sub");
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const merged = await flows.merge(worktree);
    const finished = await flows.finishMerge(worktree);

    const expected = { status: MergeStatus.conflict, files: ["sub"] };
    expect(merged).toEqual(expected);
    expect(finished).toEqual(expected);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  });
});

describe("detached HEAD", () => {
  it("refuses to merge on a detached HEAD", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await commitFile(worktree.path, "flow.txt", "flow\n", "Flow work");
    await git(repo, ["checkout", "--quiet", "--detach"]);
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const failure = await flows.merge(worktree).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: IpcErrorCode.CONFLICT });
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect(existsSync(join(repo, "flow.txt"))).toBe(false);
  });

  it("refuses to remove on a detached HEAD", async () => {
    const worktree = await flows.create(repo, RUN_ID);
    await commitFile(worktree.path, "flow.txt", "flow\n", "Flow work");
    await flows.merge(worktree);
    await git(repo, ["checkout", "--quiet", "--detach"]);

    const failure = await flows.remove(worktree).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: IpcErrorCode.CONFLICT });
    expect(existsSync(worktree.path)).toBe(true);
    expect(
      (await git(repo, ["branch", "--list", worktree.branch])).trim(),
    ).toContain(worktree.branch);
  });
});
