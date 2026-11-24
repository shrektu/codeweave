import {
  ASSIGNMENT_SEPARATOR,
  BRACE_EXPANSION_PATTERN,
  DASH_PREFIX,
  GLOB_CHAR_PATTERN,
  UNREPORTED_GLOB_START_PATTERN,
  VARIABLE_MARKER,
} from "./permissionRules";

export const PATH_SEPARATOR_PATTERN = /[\\/]/;
export const SHORT_FLAG_PREFIX = "-";
export const LONG_FLAG_PREFIX = "--";
export const LONG_VALUE_SEPARATOR = ASSIGNMENT_SEPARATOR;

export function baseName(command: string): string {
  return command.split(PATH_SEPARATOR_PATTERN).pop() ?? command;
}

export function isShortFlagCluster(arg: string): boolean {
  return arg.startsWith(SHORT_FLAG_PREFIX) && !arg.startsWith(LONG_FLAG_PREFIX);
}

export function hasAbbreviatedFlag(
  args: readonly string[],
  flags: readonly string[],
): boolean {
  return args.some((arg) => {
    const name = arg.split(LONG_VALUE_SEPARATOR, 1)[0] ?? arg;
    return (
      name.startsWith(LONG_FLAG_PREFIX) &&
      name.length > LONG_FLAG_PREFIX.length &&
      flags.some((flag) => flag.startsWith(name))
    );
  });
}

export function isUnseenExpansion(word: string): boolean {
  if (
    BRACE_EXPANSION_PATTERN.test(word) ||
    word.includes(VARIABLE_MARKER) ||
    UNREPORTED_GLOB_START_PATTERN.test(word)
  ) {
    return true;
  }
  const optionName = word.split(LONG_VALUE_SEPARATOR, 1)[0] ?? word;
  return word.startsWith(DASH_PREFIX) && GLOB_CHAR_PATTERN.test(optionName);
}
