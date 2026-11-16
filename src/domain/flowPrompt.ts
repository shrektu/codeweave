import { DEFAULT_MAX_RESULT_CHARS } from "./constants";
import { truncate, worktreeSection } from "./contextPackage";
import { NodeInputKind, type NodeInput } from "./flowRun";
import type { WorktreeState } from "./types";

export interface NodePromptInput {
  readonly flowTitle: string;
  readonly nodeId: string;
  readonly agentRole: string;
  readonly agentBody: string;
  readonly task: string;
  readonly inputs: readonly NodeInput[];
  readonly worktree: WorktreeState;
  readonly givesVerdict: boolean;
}

const SECTION_TITLE_BY_KIND: Readonly<Record<NodeInputKind, string>> = {
  [NodeInputKind.handoff]: "Hand-off from",
  [NodeInputKind.findings]: "Review findings from",
};
const VERDICT_INSTRUCTION =
  "## Verdict\nEnd your reply with exactly one final line, either " +
  "`VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`.";

function roleSection({ agentRole, agentBody }: NodePromptInput): string {
  const body = agentBody.trim();
  return `## Your role\n${agentRole}${body === "" ? "" : `\n\n${body}`}`;
}

function inputSection({ kind, from, text }: NodeInput): string {
  return `## ${SECTION_TITLE_BY_KIND[kind]} ${from}\n${truncate(text, DEFAULT_MAX_RESULT_CHARS)}`;
}

export function buildNodePrompt(input: NodePromptInput): string {
  return [
    `# Flow: ${input.flowTitle}\nNode: ${input.nodeId}`,
    roleSection(input),
    `## Task\n${input.task}`,
    ...input.inputs.map(inputSection),
    worktreeSection(input.worktree),
    ...(input.givesVerdict ? [VERDICT_INSTRUCTION] : []),
  ].join("\n\n");
}
