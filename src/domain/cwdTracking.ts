import { resolveTarget, type PermissionContext } from "./pathScope";
import {
  APPEND_ASSIGNMENT_SUFFIX,
  CD_COMMAND,
  CD_ENV_NAMES,
  CD_OPTION_FLAGS,
  CHAIN_OPERATOR,
  CWD_COMMANDS,
  DASH_PREFIX,
  GLOB_CHAR_PATTERN,
  NON_COMMAND_WORDS,
  OPTIONS_END,
  OR_OPERATOR,
  PIPE_OPERATOR,
  POPD_COMMAND,
  STACK_OFFSET_PATTERN,
  UNRESOLVED_PATH_PREFIX,
} from "./permissionRules";
import { isUnseenExpansion, LONG_VALUE_SEPARATOR } from "./shellWords";

export interface CwdCursor {
  readonly cwd: string | null;
  readonly moved: boolean;
}

export interface CwdStep {
  readonly words: readonly string[];
  readonly chdir: boolean;
  readonly followedBy: string | null;
  readonly precededBy: string | null;
  readonly pipedFromPrevious: boolean;
  readonly cdEnvTainted: boolean;
  readonly wrapped: boolean;
}

export interface DirectoryCommand {
  readonly name: string;
  readonly operands: readonly string[];
}

const UNKNOWN_CWD: CwdCursor = { cwd: null, moved: true };

export function directoryCommand(
  words: readonly string[],
): DirectoryCommand | null {
  const start = words.findIndex((word) => !NON_COMMAND_WORDS.includes(word));
  const name = words[start] ?? "";
  if (start < 0 || !CWD_COMMANDS.includes(name)) {
    return null;
  }
  const args = words.slice(start + 1);
  let skipped = 0;
  while (CD_OPTION_FLAGS.includes(args[skipped] ?? "")) {
    skipped += 1;
  }
  return {
    name,
    operands: args.slice(args[skipped] === OPTIONS_END ? skipped + 1 : skipped),
  };
}

function literalDirectory(
  command: DirectoryCommand,
  ctx: PermissionContext,
  cwd: string,
): string | null {
  const [target, ...extra] = command.operands;
  if (command.name === POPD_COMMAND || extra.length > 0) {
    return null;
  }
  if (target === undefined) {
    return command.name === CD_COMMAND
      ? resolveTarget(UNRESOLVED_PATH_PREFIX, ctx, cwd)
      : null;
  }
  return target.startsWith(DASH_PREFIX) ||
    STACK_OFFSET_PATTERN.test(target) ||
    isUnseenExpansion(target) ||
    GLOB_CHAR_PATTERN.test(target)
    ? null
    : resolveTarget(target, ctx, cwd);
}

export function overridesCdEnv(words: readonly string[]): boolean {
  return words.some((word) =>
    CD_ENV_NAMES.includes(
      (word.split(LONG_VALUE_SEPARATOR, 1)[0] ?? word)
        .replace(APPEND_ASSIGNMENT_SUFFIX, "")
        .toLowerCase(),
    ),
  );
}

function keepsCwd(step: CwdStep, cursor: CwdCursor): boolean {
  return (
    !cursor.moved ||
    step.followedBy === null ||
    step.followedBy === CHAIN_OPERATOR ||
    step.followedBy === PIPE_OPERATOR
  );
}

export function advanceCwd(
  step: CwdStep,
  cursor: CwdCursor,
  ctx: PermissionContext,
): CwdCursor {
  if (cursor.cwd === null) {
    return cursor;
  }
  const command = directoryCommand(step.words);
  if (command === null && !step.chdir) {
    return keepsCwd(step, cursor) ? cursor : UNKNOWN_CWD;
  }
  const conditional =
    step.chdir ||
    step.wrapped ||
    step.cdEnvTainted ||
    step.precededBy === OR_OPERATOR;
  const next =
    command === null || conditional
      ? null
      : literalDirectory(command, ctx, cursor.cwd);
  const chained = step.followedBy === CHAIN_OPERATOR && !step.pipedFromPrevious;
  return chained && next !== null ? { cwd: next, moved: true } : UNKNOWN_CWD;
}
