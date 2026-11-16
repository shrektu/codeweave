import { SIDE_EFFECT_PATTERNS } from "./constants";
import type { TurnLogEntry } from "./sessionReducer";
import type { WorktreeState } from "./types";

export interface ContextPackageInput {
  readonly userPrompts: readonly string[];
  readonly interruptedTurn: readonly TurnLogEntry[];
  readonly worktree: WorktreeState;
  readonly maxResultChars: number;
}

const INTRO =
  "You are taking over a coding session from another account that hit its usage limit. " +
  "Everything you need to know about the session so far is below.";
const INSTRUCTION =
  "Inspect the current state of the working directory first, then continue the work from where it was interrupted.";

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated, ${String(text.length - maxChars)} more characters]`;
}

function isSideEffect(entry: TurnLogEntry): boolean {
  const subject = entry.command ?? entry.title;
  return SIDE_EFFECT_PATTERNS.some((pattern) => pattern.test(subject));
}

function describeEntry(entry: TurnLogEntry, maxChars: number): string {
  const lines = [`- ${entry.title}`];
  if (entry.status === "completed" || entry.status === "failed") {
    lines.push(`  Status: ${entry.status}`);
    lines.push(
      `  Result: ${truncate(entry.output ?? "(no output)", maxChars)}`,
    );
  } else {
    lines.push("  Status: started, result not executed or unknown");
  }
  if (isSideEffect(entry)) {
    lines.push(
      "  Side effect: do not re-run automatically; verify its effect first.",
    );
  }
  return lines.join("\n");
}

function goalSection(prompts: readonly string[]): string {
  const body =
    prompts.length === 0
      ? "No user prompts were recorded."
      : prompts
          .map((prompt, index) => `${String(index + 1)}. ${prompt}`)
          .join("\n");
  return `## Goal\n${body}`;
}

function turnSection(turn: readonly TurnLogEntry[], maxChars: number): string {
  const body =
    turn.length === 0
      ? "No tool calls were made in the interrupted turn."
      : turn.map((entry) => describeEntry(entry, maxChars)).join("\n");
  return `## Interrupted turn\n${body}`;
}

export function worktreeSection(worktree: WorktreeState): string {
  if (!worktree.isRepo) {
    return `## Working tree\nThe working directory ${worktree.cwd} is not a git repository.`;
  }
  const status =
    worktree.porcelain.trim() === ""
      ? "The working tree is clean."
      : `git status --porcelain:\n${worktree.porcelain.trimEnd()}`;
  const stat =
    worktree.diffStat.trim() === ""
      ? ""
      : `\n\ngit diff --stat:\n${worktree.diffStat.trimEnd()}`;
  return `## Working tree\nRepository root: ${worktree.root}\n${status}${stat}`;
}

export function buildContextPackage(input: ContextPackageInput): string {
  return [
    INTRO,
    goalSection(input.userPrompts),
    turnSection(input.interruptedTurn, input.maxResultChars),
    worktreeSection(input.worktree),
    `## Instruction\n${INSTRUCTION}`,
  ].join("\n\n");
}
