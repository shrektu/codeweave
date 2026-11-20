import { expect, it } from "vitest";

import { buildNodePrompt, type NodePromptInput } from "./flowPrompt";
import { NodeInputKind } from "./flowRun";

const BASE: NodePromptInput = {
  flowTitle: "Ship it",
  nodeId: "review",
  agentRole: "Reviews the diff",
  agentBody: "Report bugs only.",
  task: "Add login",
  inputs: [],
  worktree: { isRepo: false, cwd: "/work" },
  givesVerdict: false,
};

const VERDICT_SECTION =
  "## Verdict\nEnd your reply with exactly one final line, either " +
  "`VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`.";

it("prompt_lists_every_section_in_order_for_a_reviewer", () => {
  const prompt = buildNodePrompt({
    ...BASE,
    givesVerdict: true,
    inputs: [
      { from: "build", kind: NodeInputKind.handoff, text: "built it" },
      { from: "lint", kind: NodeInputKind.findings, text: "fix x" },
    ],
  });

  expect(prompt).toBe(
    [
      "# Flow: Ship it\nNode: review",
      "## Your role\nReviews the diff\n\nReport bugs only.",
      "## Task\nAdd login",
      "## Hand-off from build\nbuilt it",
      "## Review findings from lint\nfix x",
      "## Working tree\nThe working directory /work is not a git repository.",
      VERDICT_SECTION,
    ].join("\n\n"),
  );
});

it("prompt_omits_the_verdict_instruction_for_non_reviewers", () => {
  const prompt = buildNodePrompt({ ...BASE, givesVerdict: false });

  expect(prompt).not.toContain("VERDICT");
  expect(prompt).not.toContain("## Verdict");
});

it("prompt_has_no_hand_off_sections_without_inputs", () => {
  const prompt = buildNodePrompt(BASE);

  expect(prompt).not.toContain("## Hand-off");
  expect(prompt).not.toContain("## Review findings");
});

it("prompt_role_section_is_just_the_role_when_the_agent_has_no_body", () => {
  const prompt = buildNodePrompt({ ...BASE, agentBody: "  \n" });

  expect(prompt).toContain("## Your role\nReviews the diff\n\n## Task");
});

it("prompt_caps_every_input_text_at_the_hand_off_limit", () => {
  const long = "x".repeat(16_500);

  const prompt = buildNodePrompt({
    ...BASE,
    inputs: [
      { from: "build", kind: NodeInputKind.handoff, text: long },
      { from: "lint", kind: NodeInputKind.findings, text: long },
    ],
  });

  const capped = `${"x".repeat(16_000)}\n[truncated, 500 more characters]`;
  expect(prompt).toContain(`## Hand-off from build\n${capped}`);
  expect(prompt).toContain(`## Review findings from lint\n${capped}`);
  expect(prompt).not.toContain("x".repeat(16_001));
});

it("prompt_truncates_an_input_one_character_over_the_limit", () => {
  const over = "z".repeat(16_001);

  const prompt = buildNodePrompt({
    ...BASE,
    inputs: [{ from: "build", kind: NodeInputKind.handoff, text: over }],
  });

  expect(prompt).toContain(
    `## Hand-off from build\n${"z".repeat(16_000)}\n[truncated, 1 more characters]`,
  );
});

it("prompt_keeps_an_input_at_the_cap_whole", () => {
  const exact = "y".repeat(16_000);

  const prompt = buildNodePrompt({
    ...BASE,
    inputs: [{ from: "build", kind: NodeInputKind.handoff, text: exact }],
  });

  expect(prompt).toContain(`## Hand-off from build\n${exact}\n\n## Working`);
});

it("prompt_summarises_a_git_worktree", () => {
  const prompt = buildNodePrompt({
    ...BASE,
    worktree: {
      isRepo: true,
      root: "/work/app",
      porcelain: " M src/login.ts\n",
      diffStat: " src/login.ts | 4 ++--\n",
    },
  });

  expect(prompt).toContain(
    "## Working tree\nRepository root: /work/app\n" +
      "git status --porcelain:\n M src/login.ts\n\n" +
      "git diff --stat:\n src/login.ts | 4 ++--",
  );
});
