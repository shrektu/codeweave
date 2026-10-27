import { describe, expect, it } from "vitest";

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
    userPrompts: overrides.userPrompts ?? ["Do the thing"],
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
