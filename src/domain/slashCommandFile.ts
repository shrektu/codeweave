import { parse } from "yaml";
import { z } from "zod";

import { formatIssues, FRONTMATTER_PATTERN, type ParseResult } from "./flows";

export const SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const BUILTIN_SLASH_COMMANDS = [
  "clear",
  "compact",
  "model",
  "resume",
  "rewind",
] as const;
export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];

const EMPTY_BODY = "Command body is empty";
const EMPTY_DESCRIPTION = "";
const INVALID_YAML_PREFIX = "Invalid YAML frontmatter: ";

export interface SlashCommandFile {
  readonly name: string | null;
  readonly description: string;
  readonly body: string;
}

const FrontmatterSchema = z.looseObject({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

type Frontmatter = z.infer<typeof FrontmatterSchema>;

const NO_FRONTMATTER: Frontmatter = {};

function parseFrontmatter(yaml: string): ParseResult<Frontmatter> {
  try {
    const result = FrontmatterSchema.safeParse(parse(yaml) ?? NO_FRONTMATTER);
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false, errors: formatIssues(result.error.issues) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`${INVALID_YAML_PREFIX}${message}`] };
  }
}

export function parseSlashCommandFile(
  markdown: string,
): ParseResult<SlashCommandFile> {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  const frontmatter: ParseResult<Frontmatter> =
    match?.[1] === undefined
      ? { ok: true, value: NO_FRONTMATTER }
      : parseFrontmatter(match[1]);
  if (!frontmatter.ok) {
    return frontmatter;
  }
  const body = (
    match === null ? markdown : markdown.slice(match[0].length)
  ).trim();
  if (body === "") {
    return { ok: false, errors: [EMPTY_BODY] };
  }
  return {
    ok: true,
    value: {
      name: frontmatter.value.name ?? null,
      description: frontmatter.value.description ?? EMPTY_DESCRIPTION,
      body,
    },
  };
}
