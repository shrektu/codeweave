import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ELECTRON_RUN_AS_NODE_ENV,
  FLAG_ENABLED,
  LAUNCHER_SCRIPT,
} from "../constants";
import { resolveAdapterEntry } from "../claude/launch";
import { writeAtomic } from "../storage";

import {
  HOOK_COMMAND_TYPE,
  HOOK_CONFIG_DIR_NAME,
  HOOK_ENTRY_FILE,
  HOOK_EVENT_PRE_TOOL_USE,
  HOOK_GROUP_NAME,
  HOOK_MATCHER_ALL,
  HOOK_TIMEOUT_SECONDS,
  HOOK_WRAPPER_BASENAME,
  HOOK_WRAPPER_POSIX_EXTENSION,
  HOOK_WRAPPER_WINDOWS_EXTENSION,
  HOOKS_JSON_FILE,
} from "./constants";
import { posixQuote } from "./shellQuote";

export interface AgyHookConfigInput {
  readonly configDir: string;
  readonly execPath: string;
  readonly hookEntry: string;
  readonly platform: NodeJS.Platform;
}

const NOT_FOUND_CODE = "ENOENT";
const DOUBLE_QUOTE = '"';
const ESCAPED_DOUBLE_QUOTE = '\\"';
const WINDOWS_PLATFORM: NodeJS.Platform = "win32";
const LEFTOVER_WRAPPER_EXTENSIONS: readonly string[] = [
  HOOK_WRAPPER_POSIX_EXTENSION,
  HOOK_WRAPPER_WINDOWS_EXTENSION,
];

export function locateAgyHookEntry(): string {
  return resolveAdapterEntry(
    join(dirname(fileURLToPath(import.meta.url)), HOOK_ENTRY_FILE),
  );
}

function doubleQuoted(text: string): string {
  return `${DOUBLE_QUOTE}${text}${DOUBLE_QUOTE}`;
}

function posixCommand(input: AgyHookConfigInput): string {
  return `${ELECTRON_RUN_AS_NODE_ENV}=${FLAG_ENABLED} exec ${posixQuote(input.execPath)} -e ${posixQuote(LAUNCHER_SCRIPT)} ${posixQuote(input.hookEntry)}`;
}

function windowsCommand(input: AgyHookConfigInput): string {
  const script = LAUNCHER_SCRIPT.replaceAll(DOUBLE_QUOTE, ESCAPED_DOUBLE_QUOTE);
  return `set ${doubleQuoted(`${ELECTRON_RUN_AS_NODE_ENV}=${FLAG_ENABLED}`)} && ${doubleQuoted(input.execPath)} -e ${doubleQuoted(script)} ${doubleQuoted(input.hookEntry)}`;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      Reflect.get(error, "code") === NOT_FOUND_CODE
    ) {
      return null;
    }
    throw error;
  }
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  if ((await readIfPresent(file)) !== content) {
    await writeAtomic(file, content);
  }
}

function hooksJsonOf(command: string): string {
  return JSON.stringify({
    [HOOK_GROUP_NAME]: {
      [HOOK_EVENT_PRE_TOOL_USE]: [
        {
          matcher: HOOK_MATCHER_ALL,
          hooks: [
            {
              type: HOOK_COMMAND_TYPE,
              command,
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  });
}

export async function writeAgyHookConfig(
  input: AgyHookConfigInput,
): Promise<void> {
  const dir = join(input.configDir, HOOK_CONFIG_DIR_NAME);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    LEFTOVER_WRAPPER_EXTENSIONS.map((extension) =>
      rm(join(dir, `${HOOK_WRAPPER_BASENAME}${extension}`), { force: true }),
    ),
  );
  const command =
    input.platform === WINDOWS_PLATFORM
      ? windowsCommand(input)
      : posixCommand(input);
  await writeIfChanged(join(dir, HOOKS_JSON_FILE), hooksJsonOf(command));
}
