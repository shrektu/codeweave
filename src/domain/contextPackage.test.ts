import { describe, expect, it } from "vitest";

import { DEFAULT_HANDOFF_CHARS } from "./constants";
import { buildContextPackage } from "./contextPackage";
import type { TurnLogEntry } from "./sessionReducer";
import type { WorktreeState } from "./types";

const CLEAN_REPO: WorktreeState = {
  isRepo: true,
  root: "/repo",
  porcelain: "",
  diffStat: "",
};

function pack(
  interruptedTurn: readonly TurnLogEntry[],
  overrides: {
    userPrompts?: readonly string[];
    worktree?: WorktreeState;
    maxResultChars?: number;
  } = {},
): string {
  return buildContextPackage({
    reason: "rotation",
    userPrompts: overrides.userPrompts ?? ["Do the thing"],
    lastReply: null,
    interruptedTurn,
    worktree: overrides.worktree ?? CLEAN_REPO,
    maxResultChars: overrides.maxResultChars ?? 100,
  });
}

function completed(
  title: string,
  command: string,
  output = "ok",
): TurnLogEntry {
  return { toolCallId: title, title, command, status: "completed", output };
}

describe("context package: sections", () => {
  it("lists the user prompts in order", () => {
    const text = pack([], { userPrompts: ["First goal", "Second goal"] });

    expect(text).toContain("1. First goal\n2. Second goal");
  });

  it("handles an empty history", () => {
    const text = pack([], { userPrompts: [] });

    expect(text).toContain("No user prompts were recorded.");
    expect(text).toContain("No tool calls were made in the interrupted turn.");
    expect(text).toContain("The working tree is clean.");
  });

  it("ends with the inspect-first instruction", () => {
    expect(
      pack([]).endsWith(
        "then continue the work from where it was interrupted.",
      ),
    ).toBe(true);
    expect(pack([])).toContain(
      "Inspect the current state of the working directory first",
    );
  });

  it("includes git status and diff stat of a dirty repo", () => {
    const text = pack([], {
      worktree: {
        isRepo: true,
        root: "/repo",
        porcelain: " M a.ts\n",
        diffStat: " a.ts | 2 +-\n",
      },
    });

    expect(text).toContain("git status --porcelain:\n M a.ts");
    expect(text).toContain("git diff --stat:\n a.ts | 2 +-");
  });

  it("says so when the directory is not a git repository", () => {
    const text = pack([], { worktree: { isRepo: false, cwd: "/tmp/x" } });

    expect(text).toContain(
      "The working directory /tmp/x is not a git repository.",
    );
    expect(text).not.toContain("git status");
  });
});

describe("context package: interrupted turn", () => {
  it("shows a completed tool with its output", () => {
    const text = pack([completed("Edit a.ts", "edit", "edited 3 lines")]);

    expect(text).toContain(
      "- Edit a.ts\n  Status: completed\n  Result: edited 3 lines",
    );
  });

  it("marks a tool without a result as not executed or unknown", () => {
    const text = pack([
      { toolCallId: "t", title: "Run tests", status: "in_progress" },
    ]);

    expect(text).toContain("Status: started, result not executed or unknown");
  });

  it("keeps a result of exactly maxResultChars and truncates one char more", () => {
    const exact = pack([completed("A", "ls", "x".repeat(10))], {
      maxResultChars: 10,
    });
    const over = pack([completed("A", "ls", "x".repeat(11))], {
      maxResultChars: 10,
    });

    expect(exact).toContain(`Result: ${"x".repeat(10)}\n`);
    expect(exact).not.toContain("truncated");
    expect(over).toContain(
      `Result: ${"x".repeat(10)}\n[truncated, 1 more characters]`,
    );
  });

  it.each([
    "git push origin main",
    "pnpm publish --access public",
    "npm publish",
    "curl -X POST http://api.example.com",
    "rm -rf build",
    "kubectl apply -f deploy.yaml",
    "terraform apply -auto-approve",
    "pnpm run db:migrate",
    "./scripts/deploy.sh staging",
  ])("flags %s as a side effect", (command) => {
    const text = pack([completed("Bash", command)]);

    expect(text).toContain("do not re-run automatically");
  });

  it("does not flag harmless commands", () => {
    const text = pack([
      completed("Bash", "git status"),
      completed("Read", "cat a.ts"),
    ]);

    expect(text).not.toContain("do not re-run automatically");
  });
});

describe("context package: reasons", () => {
  it("rotation_package_text_unchanged", () => {
    const text = buildContextPackage({
      reason: "rotation",
      userPrompts: ["Do the thing"],
      lastReply: null,
      interruptedTurn: [],
      worktree: CLEAN_REPO,
      maxResultChars: 100,
    });

    expect(text).toBe(
      [
        "You are taking over a coding session from another account that hit its usage limit. Everything you need to know about the session so far is below.",
        "## Goal\n1. Do the thing",
        "## Interrupted turn\nNo tool calls were made in the interrupted turn.",
        "## Working tree\nRepository root: /repo\nThe working tree is clean.",
        "## Instruction\nInspect the current state of the working directory first, then continue the work from where it was interrupted.",
      ].join("\n\n"),
    );
  });

  it("resume_package_contains_prompts_last_reply_and_worktree", () => {
    const text = buildContextPackage({
      reason: "resume",
      userPrompts: ["Old goal", "Second goal"],
      lastReply: "Old reply",
      interruptedTurn: [],
      worktree: CLEAN_REPO,
      maxResultChars: 100,
    });

    expect(text).toContain("1. Old goal\n2. Second goal");
    expect(text).toContain("## Last assistant message\nOld reply");
    expect(text).toContain("## Working tree\nRepository root: /repo");
    expect(text).toContain("after the application restarted");
    expect(text).toContain("where this session stopped");
    expect(text).not.toContain("hit its usage limit");
  });

  it("resume_package_truncates_a_long_last_reply", () => {
    const text = buildContextPackage({
      reason: "resume",
      userPrompts: ["Old goal"],
      lastReply: "z".repeat(DEFAULT_HANDOFF_CHARS + 5),
      interruptedTurn: [],
      worktree: CLEAN_REPO,
      maxResultChars: 100,
    });

    expect(text).toContain("[truncated, 5 more characters]");
  });
});
