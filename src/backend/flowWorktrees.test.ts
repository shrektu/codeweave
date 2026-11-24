import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MergeStatus } from "../domain/types";
import { IpcErrorCode } from "../shared/protocol";

import type { ExecText } from "./exec";
import { createFlowWorktrees, type FlowWorktree } from "./flowWorktrees";

type Reply = string | Error;

interface FakeGit {
  readonly exec: ExecText;
  readonly commands: string[];
}

function fakeGit(replies: Readonly<Record<string, Reply>>): FakeGit {
  const commands: string[] = [];
  const exec: ExecText = (_file, args) => {
    const command = args.slice(2).join(" ");
    commands.push(command);
    const reply = replies[command];
    if (reply === undefined) {
      return Promise.reject(new Error(`unexpected git ${command}`));
    }
    return typeof reply === "string"
      ? Promise.resolve(reply)
      : Promise.reject(reply);
  };
  return { exec, commands };
}

const EXIT_ONE = Object.assign(new Error("exit 1"), { code: 1 });
const MERGE_HEAD_CHECK = "rev-parse -q --verify MERGE_HEAD";
const UNMERGED_LIST = "ls-files -u -z";
const BRANCH_REF = "symbolic-ref -q HEAD";
const ON_MAIN = "refs/heads/main\n";
const SHA = "a".repeat(40);
const TEXT_STAGES: readonly number[] = [1, 2, 3];

const REGULAR_MODE = "100644";
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

function unmerged(
  ...entries: readonly (readonly [string, readonly number[], string?])[]
): string {
  return entries
    .flatMap(([file, stages, mode = REGULAR_MODE]) =>
      stages.map((stage) => `${mode} ${SHA} ${String(stage)}\t${file}\0`),
    )
    .join("");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-flow-unit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function worktreeAt(projectRoot: string): FlowWorktree {
  return {
    runId: "run",
    projectRoot,
    path: join(projectRoot, "wt"),
    branch: "codeweave/run",
    base: SHA,
  };
}

async function finishWith(content: string): Promise<unknown> {
  await writeFile(join(dir, "f.txt"), content);
  const { exec } = fakeGit({
    [MERGE_HEAD_CHECK]: SHA,
    [UNMERGED_LIST]: unmerged(["f.txt", TEXT_STAGES]),
    "add -A": "",
    "commit --no-edit": "",
    "rev-parse HEAD": `${SHA}\n`,
  });
  return createFlowWorktrees({ exec }).finishMerge(worktreeAt(dir));
}

describe("finishMerge marker detection", () => {
  it("treats a separator line with trailing text as resolved", async () => {
    expect(await finishWith("a\n======= kept\nb\n")).toEqual({
      status: MergeStatus.merged,
      commit: SHA,
    });
  });

  it("treats a marker inside a line as resolved", async () => {
    expect(await finishWith("x <<<<<<< y\nz >>>>>>> w\n")).toEqual({
      status: MergeStatus.merged,
      commit: SHA,
    });
  });

  it("detects an opening marker on a CRLF line", async () => {
    expect(await finishWith("<<<<<<< ours\r\nx\r\n")).toEqual({
      status: MergeStatus.conflict,
      files: ["f.txt"],
    });
  });

  it("detects a CRLF separator line", async () => {
    expect(await finishWith("a\r\n=======\r\nb\r\n")).toEqual({
      status: MergeStatus.conflict,
      files: ["f.txt"],
    });
  });

  it("detects a closing marker", async () => {
    expect(await finishWith("a\n>>>>>>> theirs\n")).toEqual({
      status: MergeStatus.conflict,
      files: ["f.txt"],
    });
  });

  it("reports only the files that still hold markers", async () => {
    await writeFile(join(dir, "bad.txt"), "<<<<<<< ours\n");
    await writeFile(join(dir, "good.txt"), "fine\n");
    const { exec } = fakeGit({
      [MERGE_HEAD_CHECK]: SHA,
      [UNMERGED_LIST]: unmerged(
        ["good.txt", TEXT_STAGES],
        ["bad.txt", TEXT_STAGES],
      ),
    });

    const outcome = await createFlowWorktrees({ exec }).finishMerge(
      worktreeAt(dir),
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["bad.txt"],
    });
  });

  it("refuses when no merge is in progress", async () => {
    const { exec } = fakeGit({ [MERGE_HEAD_CHECK]: EXIT_ONE });

    await expect(
      createFlowWorktrees({ exec }).finishMerge(worktreeAt(dir)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("non-text conflicts", () => {
  async function finishWithEntries(
    entries: string,
    files: Readonly<Record<string, string>>,
  ): Promise<{ outcome: unknown; commands: string[] }> {
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        writeFile(join(dir, name), content),
      ),
    );
    const { exec, commands } = fakeGit({
      [MERGE_HEAD_CHECK]: SHA,
      [UNMERGED_LIST]: entries,
    });
    const outcome = await createFlowWorktrees({ exec }).finishMerge(
      worktreeAt(dir),
    );
    return { outcome, commands };
  }

  it("keeps a binary conflict unresolved", async () => {
    const { outcome, commands } = await finishWithEntries(
      unmerged(["bin.dat", TEXT_STAGES]),
      { "bin.dat": "ours\0theirs" },
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["bin.dat"],
    });
    expect(commands).not.toContain("add -A");
  });

  it("keeps a modify/delete conflict unresolved", async () => {
    const { outcome, commands } = await finishWithEntries(
      unmerged(["gone.txt", [1, 3]], ["fine.txt", TEXT_STAGES]),
      { "gone.txt": "kept text\n", "fine.txt": "resolved\n" },
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["gone.txt"],
    });
    expect(commands).not.toContain("add -A");
  });

  it("reports a rename/rename conflict without throwing", async () => {
    const { outcome, commands } = await finishWithEntries(
      unmerged(["old.txt", [1]], ["new.txt", [2]]),
      { "new.txt": "text\n" },
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["old.txt", "new.txt"],
    });
    expect(commands).not.toContain("add -A");
  });
});

async function finishWithSpecial(
  entries: string,
  layout: () => Promise<void>,
): Promise<{ outcome: unknown; commands: string[] }> {
  await layout();
  const { exec, commands } = fakeGit({
    [MERGE_HEAD_CHECK]: SHA,
    [UNMERGED_LIST]: entries,
  });
  const outcome = await createFlowWorktrees({ exec }).finishMerge(
    worktreeAt(dir),
  );
  return { outcome, commands };
}

describe("special-file conflicts", () => {
  it("keeps a symlink conflict unresolved", async () => {
    const { outcome, commands } = await finishWithSpecial(
      unmerged(["link", TEXT_STAGES, SYMLINK_MODE]),
      () => writeFile(join(dir, "link"), "plain text, no markers\n"),
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["link"],
    });
    expect(commands).not.toContain("add -A");
  });

  it("reports a submodule conflict without throwing", async () => {
    const { outcome, commands } = await finishWithSpecial(
      unmerged(["sub", TEXT_STAGES, GITLINK_MODE]),
      () => mkdir(join(dir, "sub")),
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["sub"],
    });
    expect(commands).not.toContain("add -A");
  });

  it("treats a directory at a regular unmerged path as unresolved", async () => {
    const { outcome } = await finishWithSpecial(
      unmerged(["odd", TEXT_STAGES]),
      () => mkdir(join(dir, "odd")),
    );

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["odd"],
    });
  });

  it.skipIf(process.platform === "win32")(
    "never reads through a symlink at a regular unmerged path",
    async () => {
      const { outcome } = await finishWithSpecial(
        unmerged(["via", TEXT_STAGES]),
        async () => {
          await writeFile(join(dir, "target.txt"), "clean text\n");
          await symlink(join(dir, "target.txt"), join(dir, "via"));
        },
      );

      expect(outcome).toEqual({
        status: MergeStatus.conflict,
        files: ["via"],
      });
    },
  );
});

describe("conflict path listing", () => {
  it("reports non-ascii conflict paths verbatim", async () => {
    const { exec, commands } = fakeGit({
      [BRANCH_REF]: ON_MAIN,
      "status --porcelain": "",
      [MERGE_HEAD_CHECK]: EXIT_ONE,
      "merge --no-ff -m Merge codeweave/run codeweave/run": new Error("c"),
      [UNMERGED_LIST]: unmerged(["zażółć.txt", TEXT_STAGES]),
    });

    const outcome = await createFlowWorktrees({ exec }).merge(worktreeAt(dir));

    expect(outcome).toEqual({
      status: MergeStatus.conflict,
      files: ["zażółć.txt"],
    });
    expect(commands).toContain(UNMERGED_LIST);
  });
});

describe("detached HEAD", () => {
  it("refuses to merge on a detached HEAD", async () => {
    const { exec, commands } = fakeGit({ [BRANCH_REF]: EXIT_ONE });

    await expect(
      createFlowWorktrees({ exec }).merge(worktreeAt(dir)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commands.some((command) => command.startsWith("merge "))).toBe(
      false,
    );
  });

  it("refuses to remove on a detached HEAD", async () => {
    const { exec, commands } = fakeGit({ [BRANCH_REF]: EXIT_ONE });

    await expect(
      createFlowWorktrees({ exec }).remove(worktreeAt(dir)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commands.some((command) => command.startsWith("worktree "))).toBe(
      false,
    );
  });

  it("checks ancestry against the current branch ref", async () => {
    const { exec, commands } = fakeGit({
      [BRANCH_REF]: ON_MAIN,
      "merge-base --is-ancestor codeweave/run refs/heads/main": "",
      [`worktree remove ${join(dir, "wt")}`]: "",
      "branch -d codeweave/run": "",
    });

    await createFlowWorktrees({ exec }).remove(worktreeAt(dir));

    expect(commands).toContain(
      "merge-base --is-ancestor codeweave/run refs/heads/main",
    );
  });
});

describe("merge failures", () => {
  it("rethrows a merge failure that left no unmerged paths", async () => {
    const failure = new Error("merge exploded");
    const { exec } = fakeGit({
      [BRANCH_REF]: ON_MAIN,
      "status --porcelain": "",
      [MERGE_HEAD_CHECK]: EXIT_ONE,
      "merge --no-ff -m Merge codeweave/run codeweave/run": failure,
      [UNMERGED_LIST]: "",
    });

    await expect(
      createFlowWorktrees({ exec }).merge(worktreeAt(dir)),
    ).rejects.toBe(failure);
  });

  it("rethrows an unexpected failure of the merge-in-progress probe", async () => {
    const failure = Object.assign(new Error("fatal"), { code: 128 });
    const { exec } = fakeGit({
      [BRANCH_REF]: ON_MAIN,
      "status --porcelain": "",
      [MERGE_HEAD_CHECK]: failure,
    });

    await expect(
      createFlowWorktrees({ exec }).merge(worktreeAt(dir)),
    ).rejects.toBe(failure);
  });
});

describe("create naming", () => {
  const PROJECT = join("/work", "proj");

  function createExec(runId: string, shortId: string): ExecText {
    const added = join("/work", ".worktrees", `proj-cw-${shortId}`);
    return fakeGit({
      "rev-parse --show-toplevel": "/work/proj\n",
      "status --porcelain": "",
      "rev-parse HEAD": `${SHA}\n`,
      [`worktree add -b codeweave/${runId} ${added} ${SHA}`]: "",
    }).exec;
  }

  it("uses the whole runId when it is shorter than 8 characters", async () => {
    const worktree = await createFlowWorktrees({
      exec: createExec("abc", "abc"),
    }).create(join(PROJECT, "sub"), "abc");

    expect(worktree).toEqual({
      runId: "abc",
      projectRoot: PROJECT,
      path: join("/work", ".worktrees", "proj-cw-abc"),
      branch: "codeweave/abc",
      base: SHA,
    });
  });

  it("trims the toplevel newline and truncates a long runId to 8", async () => {
    const worktree = await createFlowWorktrees({
      exec: createExec("0123456789", "01234567"),
    }).create(PROJECT, "0123456789");

    expect(worktree.projectRoot).toBe(PROJECT);
    expect(worktree.path).toBe(join("/work", ".worktrees", "proj-cw-01234567"));
  });
});

describe("resolveProjectRoot", () => {
  it("returns_the_trimmed_toplevel_of_a_subfolder", async () => {
    const worktrees = createFlowWorktrees({
      exec: fakeGit({ "rev-parse --show-toplevel": "/work/proj\n" }).exec,
    });

    expect(await worktrees.resolveProjectRoot("/work/proj/sub")).toBe(
      join("/work", "proj"),
    );
  });

  it("resolveProjectRoot_throws_validation_on_git_failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const worktrees = createFlowWorktrees({
      exec: fakeGit({ "rev-parse --show-toplevel": EXIT_ONE }).exec,
    });

    await expect(
      worktrees.resolveProjectRoot("/work/plain"),
    ).rejects.toMatchObject({
      code: IpcErrorCode.VALIDATION,
      message: "Not a git repository: /work/plain",
    });
  });
});
