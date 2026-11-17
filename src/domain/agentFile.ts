import { stringify, type Document } from "yaml";

import { AGENT_ID_PATTERN } from "./constants";
import { rewriteFrontmatterYaml } from "./flowFile";
import {
  agentBlocks,
  parseAgentDocuments,
  type AgentBlock,
  type AgentDefinition,
  type ParseResult,
} from "./flows";

const CRLF = "\r\n";
const LF = "\n";
const FENCE = "---";
const CARRIAGE_RETURN = "\r";
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\u2028\\u2029]");
const MANAGED_KEYS = [
  "id",
  "role",
  "provider",
  "model",
  "permissionProfile",
  "taskClass",
] as const;

const INVALID_ID =
  "Agent id must start with a letter or digit and contain only letters, digits, _ and -";
const BLANK_ROLE = "Role must not be blank";
const BLANK_MODEL = "Model must not be blank when set";
const FENCE_LINE = `Instructions must not contain a line that is exactly "${FENCE}"`;

interface LocatedBlock {
  readonly block: AgentBlock;
  readonly isLast: boolean;
  readonly count: number;
}

function isBlank(value: string | undefined): boolean {
  return value?.trim() === "";
}

export function validateAgent(
  definition: AgentDefinition,
  body: string,
  otherIds: readonly string[],
): string[] {
  const lowerId = definition.id.toLowerCase();
  return [
    ...(AGENT_ID_PATTERN.test(definition.id) ? [] : [INVALID_ID]),
    ...(otherIds.some((other) => other.toLowerCase() === lowerId)
      ? [`Agent id "${definition.id}" is already used by another agent`]
      : []),
    ...(definition.role.trim() === "" ? [BLANK_ROLE] : []),
    ...(isBlank(definition.model) ? [BLANK_MODEL] : []),
    ...(body.split(LINE_BREAK).includes(FENCE) ? [FENCE_LINE] : []),
  ];
}

function locateBlock(markdown: string, id: string): ParseResult<LocatedBlock> {
  const documents = parseAgentDocuments(markdown);
  if (!documents.ok) {
    return documents;
  }
  const blocks = agentBlocks(markdown);
  const matching = blocks.filter(
    (_block, index) => documents.value[index]?.definition.id === id,
  );
  const [block] = matching;
  if (matching.length !== 1 || block === undefined) {
    return {
      ok: false,
      errors: [
        matching.length === 0
          ? `Agent "${id}" not found in the file`
          : `Agent id "${id}" appears ${String(matching.length)} times in the file`,
      ],
    };
  }
  return {
    ok: true,
    value: { block, isLast: block === blocks.at(-1), count: blocks.length },
  };
}

function applyAgent(document: Document, definition: AgentDefinition): void {
  for (const key of MANAGED_KEYS) {
    const value = definition[key];
    if (value === undefined) {
      document.delete(key);
    } else {
      document.set(key, value);
    }
  }
}

function eolOf(markdown: string, block: AgentBlock): string {
  return markdown.startsWith(CARRIAGE_RETURN, block.start + FENCE.length)
    ? CRLF
    : LF;
}

export function serializeAgentBlock(
  markdown: string,
  originalId: string,
  definition: AgentDefinition,
  body: string,
): ParseResult<string> {
  const located = locateBlock(markdown, originalId);
  if (!located.ok) {
    return located;
  }
  const { block, isLast } = located.value;
  const rewritten = rewriteFrontmatterYaml({
    yaml: block.yaml,
    managedKeys: MANAGED_KEYS,
    subject: "agent",
    apply: (document) => {
      applyAgent(document, definition);
    },
  });
  if (!rewritten.ok) {
    return rewritten;
  }
  const eol = eolOf(markdown, block);
  const yaml = rewritten.value.replaceAll(LF, eol);
  const text = body.trim().replaceAll(/\r?\n/g, eol);
  const closing = isLast ? "" : eol;
  return {
    ok: true,
    value: `${markdown.slice(0, block.start)}${FENCE}${eol}${yaml}${eol}${FENCE}${eol}${eol}${text}${eol}${closing}${markdown.slice(block.end)}`,
  };
}

export function removeAgentBlock(
  markdown: string,
  id: string,
): ParseResult<string | null> {
  const located = locateBlock(markdown, id);
  if (!located.ok) {
    return located;
  }
  const { block, count } = located.value;
  if (count === 1) {
    return { ok: true, value: null };
  }
  const remaining = markdown.slice(0, block.start) + markdown.slice(block.end);
  const reparsed = parseAgentDocuments(remaining);
  return reparsed.ok ? { ok: true, value: remaining } : reparsed;
}

function plainAgent(definition: AgentDefinition): Record<string, string> {
  return Object.fromEntries(
    MANAGED_KEYS.flatMap((key) => {
      const value = definition[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export function newAgentFile(
  definition: AgentDefinition,
  body: string,
): string {
  const yaml = stringify(plainAgent(definition), { lineWidth: 0 }).trimEnd();
  return `${FENCE}${LF}${yaml}${LF}${FENCE}${LF}${LF}${body.trim()}${LF}`;
}
