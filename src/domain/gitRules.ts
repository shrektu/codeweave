import {
  GIT_BRANCH_COMMIT_FILTER_FLAGS,
  GIT_BRANCH_INLINE_VALUE_PREFIXES,
  GIT_BRANCH_LIST_FLAGS,
  GIT_BRANCH_LISTING_CLUSTER,
  GIT_BRANCH_LISTING_FLAGS,
  GIT_BRANCH_SUBCOMMAND,
  GIT_CONFIG_ATTACHED_PREFIX,
  GIT_CONFIG_OPTIONS,
  GIT_EXEC_FLAGS,
  GIT_OPTIONS_WITH_PATH_ARGUMENT,
  GIT_OUTPUT_FLAG,
  GIT_PUSH_CURRENT_BRANCH_SOURCES,
  GIT_PUSH_DANGEROUS_LETTERS,
  GIT_PUSH_FORBIDDEN_LONG_FLAGS,
  GIT_PUSH_PROGRAM_OPTIONS,
  GIT_PUSH_VALUE_LETTERS,
  GIT_PUSH_VALUE_OPTIONS,
  GIT_READ_SUBCOMMANDS,
  GIT_SAFE_GLOBAL_OPTIONS,
  HEADS_PREFIX_PATTERN,
  PATH_WILDCARD,
  PROTECTED_BRANCHES,
  REFS_PREFIX_PATTERN,
} from "./permissionRules";
import {
  hasAbbreviatedFlag,
  isShortFlagCluster,
  LONG_VALUE_SEPARATOR,
  SHORT_FLAG_PREFIX,
} from "./shellWords";

const GIT_COMMAND = "git";
const PUSH_SUBCOMMAND = "push";
const FORCE_PUSH_REFSPEC_PREFIX = "+";
const REFSPEC_SEPARATOR = ":";

function isDangerousPushCluster(arg: string): boolean {
  return (
    isShortFlagCluster(arg) &&
    GIT_PUSH_DANGEROUS_LETTERS.some((letter) => arg.slice(1).includes(letter))
  );
}

function targetsProtectedBranch(destination: string): boolean {
  const branch = destination
    .replace(REFS_PREFIX_PATTERN, "")
    .replace(HEADS_PREFIX_PATTERN, "");
  return PROTECTED_BRANCHES.includes(branch);
}

function isDangerousRefspec(ref: string): boolean {
  const destination = ref.split(REFSPEC_SEPARATOR).pop() ?? ref;
  return (
    ref.startsWith(FORCE_PUSH_REFSPEC_PREFIX) ||
    ref.startsWith(REFSPEC_SEPARATOR) ||
    ref.endsWith(REFSPEC_SEPARATOR) ||
    ref.includes(PATH_WILDCARD) ||
    targetsProtectedBranch(destination)
  );
}

function pushArguments(args: readonly string[]): readonly string[] | null {
  const index = args.indexOf(PUSH_SUBCOMMAND);
  return index < 0 ? null : args.slice(index + 1);
}

function endsWithDetachedValueLetter(arg: string): boolean {
  if (!isShortFlagCluster(arg)) {
    return false;
  }
  const letters = arg.slice(SHORT_FLAG_PREFIX.length);
  const positions = GIT_PUSH_VALUE_LETTERS.map((letter) =>
    letters.indexOf(letter),
  ).filter((position) => position >= 0);
  return positions.length > 0 && Math.min(...positions) === letters.length - 1;
}

function takesPushValue(arg: string): boolean {
  return (
    GIT_PUSH_VALUE_OPTIONS.includes(arg) ||
    endsWithDetachedValueLetter(arg) ||
    (!arg.includes(LONG_VALUE_SEPARATOR) &&
      hasAbbreviatedFlag([arg], GIT_PUSH_VALUE_OPTIONS))
  );
}

function pushPositionals(rest: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (takesPushValue(arg)) {
      index += 1;
    } else if (!arg.startsWith(SHORT_FLAG_PREFIX)) {
      positionals.push(arg);
    }
  }
  return positionals;
}

export function isDangerousGitPush(args: readonly string[]): boolean {
  const rest = pushArguments(args);
  if (rest === null) {
    return false;
  }
  return (
    rest.some(isDangerousPushCluster) ||
    hasAbbreviatedFlag(rest, GIT_PUSH_FORBIDDEN_LONG_FLAGS) ||
    pushPositionals(rest).some(isDangerousRefspec)
  );
}

export function isUncertainGitPush(
  name: string,
  args: readonly string[],
): boolean {
  const rest = pushArguments(args);
  if (name !== GIT_COMMAND || rest === null) {
    return false;
  }
  const refspecs = pushPositionals(rest).slice(1);
  return (
    refspecs.length === 0 ||
    hasAbbreviatedFlag(rest, GIT_PUSH_PROGRAM_OPTIONS) ||
    refspecs.some((ref) => GIT_PUSH_CURRENT_BRANCH_SOURCES.includes(ref))
  );
}

function isConfigOption(arg: string): boolean {
  return (
    GIT_CONFIG_OPTIONS.some(
      (option) => arg === option || arg.startsWith(`${option}=`),
    ) ||
    (isShortFlagCluster(arg) && arg.startsWith(GIT_CONFIG_ATTACHED_PREFIX))
  );
}

export function hasGitInlineConfig(
  name: string,
  args: readonly string[],
): boolean {
  if (name !== GIT_COMMAND) {
    return false;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (isConfigOption(arg)) {
      return true;
    }
    if (GIT_OPTIONS_WITH_PATH_ARGUMENT.includes(arg)) {
      index += 1;
    } else if (!arg.startsWith(SHORT_FLAG_PREFIX)) {
      return false;
    }
  }
  return false;
}

function gitSubcommand(
  args: readonly string[],
): { sub: string; rest: readonly string[] } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (GIT_OPTIONS_WITH_PATH_ARGUMENT.includes(arg)) {
      index += 1;
    } else if (arg.startsWith(SHORT_FLAG_PREFIX)) {
      if (!GIT_SAFE_GLOBAL_OPTIONS.includes(arg)) {
        return null;
      }
    } else {
      return { sub: arg, rest: args.slice(index + 1) };
    }
  }
  return null;
}

function isBranchListingOption(arg: string): boolean {
  return (
    GIT_BRANCH_LISTING_FLAGS.includes(arg) ||
    GIT_BRANCH_LISTING_CLUSTER.test(arg) ||
    GIT_BRANCH_INLINE_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
    GIT_BRANCH_COMMIT_FILTER_FLAGS.some((flag) =>
      arg.startsWith(`${flag}${LONG_VALUE_SEPARATOR}`),
    )
  );
}

function isReadOnlyBranch(rest: readonly string[]): boolean {
  let positionals = 0;
  let listing = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (GIT_BRANCH_COMMIT_FILTER_FLAGS.includes(arg)) {
      index += 1;
    } else if (isBranchListingOption(arg)) {
      listing = GIT_BRANCH_LIST_FLAGS.includes(arg) || listing;
    } else if (arg.startsWith(SHORT_FLAG_PREFIX)) {
      return false;
    } else {
      positionals += 1;
    }
  }
  return positionals === 0 || listing;
}

export function isReadOnlyGit(args: readonly string[]): boolean {
  const parsed = gitSubcommand(args);
  if (parsed === null) {
    return false;
  }
  if (parsed.sub === GIT_BRANCH_SUBCOMMAND) {
    return isReadOnlyBranch(parsed.rest);
  }
  return (
    GIT_READ_SUBCOMMANDS.includes(parsed.sub) &&
    !hasAbbreviatedFlag(parsed.rest, [GIT_OUTPUT_FLAG, ...GIT_EXEC_FLAGS])
  );
}
