import { describe, expect, it } from "vitest";

import { buildContextPackage } from "../../src/domain/contextPackage";

describe("context package acceptance", () => {
  it("context_package_outside_git_repo", () => {
    const text = buildContextPackage({
      userPrompts: ["Add a README"],
      interruptedTurn: [],
      worktree: { isRepo: false, cwd: "/home/user/scratch" },
      maxResultChars: 2000,
    });

    expect(text).toContain("not a git repository");
    expect(text).toContain("/home/user/scratch");
    expect(text).toContain("Add a README");
  });
});
