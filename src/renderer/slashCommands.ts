import type { BuiltinSlashCommand } from "../domain/slashCommandFile";
import type { SlashCommandView } from "../shared/views";

import type { IpcClient } from "./ipc";

export const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

const SLASH_MARKER = "/";
const WHITESPACE = /\s/;
const ARGUMENTS_SEPARATOR = "\n\n";

export interface SlashInput {
  readonly name: string;
  readonly args: string;
}

export interface SlashArgumentOption {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly run: () => void;
}

export interface SlashArgument {
  readonly options: (query: string) => readonly SlashArgumentOption[];
}

export interface SlashBuiltin {
  readonly name: BuiltinSlashCommand;
  readonly description: string;
  readonly run: (args: string) => boolean | Promise<boolean>;
  readonly argument?: SlashArgument;
}

export function activeSlashQuery(text: string, caret: number): string | null {
  if (!text.startsWith(SLASH_MARKER)) {
    return null;
  }
  const position = Math.min(Math.max(caret, 0), text.length);
  if (position === 0) {
    return null;
  }
  const firstWhitespace = text.search(WHITESPACE);
  const limit = firstWhitespace === -1 ? text.length : firstWhitespace;
  if (position > limit) {
    return null;
  }
  return text.slice(1, position);
}

export function parseSlashInput(text: string): SlashInput | null {
  if (!text.startsWith(SLASH_MARKER)) {
    return null;
  }
  const rest = text.slice(1);
  const firstWhitespace = rest.search(WHITESPACE);
  const name = firstWhitespace === -1 ? rest : rest.slice(0, firstWhitespace);
  if (name === "") {
    return null;
  }
  const args =
    firstWhitespace === -1 ? "" : rest.slice(firstWhitespace + 1).trim();
  return { name, args };
}

export function expandSlashCommand(body: string, args: string): string {
  if (body.includes(ARGUMENTS_PLACEHOLDER)) {
    return body.replaceAll(ARGUMENTS_PLACEHOLDER, args);
  }
  return args === "" ? body : `${body}${ARGUMENTS_SEPARATOR}${args}`;
}

export function matchSlashItems<T extends { readonly name: string }>(
  query: string,
  items: readonly T[],
): T[] {
  const needle = query.toLowerCase();
  const prefixes: T[] = [];
  const substrings: T[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefixes.push(item);
    } else if (name.includes(needle)) {
      substrings.push(item);
    }
  }
  return [...prefixes, ...substrings];
}

export function resolveSlashText(
  text: string,
  commands: readonly SlashCommandView[],
): string {
  const parsed = parseSlashInput(text);
  if (parsed === null) {
    return text;
  }
  const command = commands.find((candidate) => candidate.name === parsed.name);
  if (command === undefined) {
    return text;
  }
  return expandSlashCommand(command.body, parsed.args);
}

export async function resolvePromptText(
  client: IpcClient,
  cwd: string | undefined,
  text: string,
): Promise<string> {
  if (!text.startsWith(SLASH_MARKER)) {
    return text;
  }
  try {
    const list = await client.request(
      "commands/list",
      cwd === undefined ? {} : { cwd },
    );
    return resolveSlashText(text, list.commands);
  } catch (caught: unknown) {
    console.warn("slash command lookup failed", caught);
    return text;
  }
}
