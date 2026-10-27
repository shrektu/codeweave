import {
  FIND_EXEC_BATCH_TERMINATOR,
  FIND_EXEC_FLAGS,
  FIND_EXEC_TERMINATOR,
  FIND_PLACEHOLDER,
  OPTION_PREFIX_PATTERN,
  SHELL_COMMAND_LETTER,
  SHELL_OPTIONS_END_WORDS,
  SHELL_PLAIN_FLAGS,
  SHELL_SHORT_CLUSTER_PATTERN,
  SHELL_VALUE_FLAG,
} from "./permissionRules";

type ShellWordKind =
  "plain" | "command" | "value" | "end" | "unknown" | "operand";

function shellWordKind(word: string): ShellWordKind {
  if (word === SHELL_VALUE_FLAG) {
    return "value";
  }
  if (SHELL_OPTIONS_END_WORDS.includes(word)) {
    return "end";
  }
  if (SHELL_PLAIN_FLAGS.includes(word)) {
    return "plain";
  }
  if (SHELL_SHORT_CLUSTER_PATTERN.test(word)) {
    return word.includes(SHELL_COMMAND_LETTER) ? "command" : "plain";
  }
  return OPTION_PREFIX_PATTERN.test(word) ? "unknown" : "operand";
}

function scanShellArgs(
  args: readonly string[],
  commandSeen: boolean,
): string | undefined {
  const [word, ...rest] = args;
  if (word === undefined) {
    return undefined;
  }
  switch (shellWordKind(word)) {
    case "operand":
      return commandSeen ? word : undefined;
    case "end":
      return commandSeen ? rest[0] : undefined;
    case "value":
      return scanAfterValue(rest, commandSeen);
    case "command":
      return scanShellArgs(rest, true);
    case "plain":
      return scanShellArgs(rest, commandSeen);
    default:
      return undefined;
  }
}

function scanAfterValue(
  rest: readonly string[],
  commandSeen: boolean,
): string | undefined {
  const [name, ...tail] = rest;
  return name === undefined || OPTION_PREFIX_PATTERN.test(name)
    ? undefined
    : scanShellArgs(tail, commandSeen);
}

export function shellScript(args: readonly string[]): string | undefined {
  return scanShellArgs(args, false);
}

function endsExec(current: readonly string[], arg: string): boolean {
  return (
    arg === FIND_EXEC_TERMINATOR ||
    (arg === FIND_EXEC_BATCH_TERMINATOR && current.at(-1) === FIND_PLACEHOLDER)
  );
}

export function findExecCommands(
  args: readonly string[],
): readonly (readonly string[])[] {
  const commands: string[][] = [];
  let current: string[] | undefined;
  for (const arg of args) {
    if (current === undefined) {
      if (FIND_EXEC_FLAGS.includes(arg)) {
        current = [];
        commands.push(current);
      }
    } else if (endsExec(current, arg)) {
      current = undefined;
    } else {
      current.push(arg);
    }
  }
  return commands;
}
