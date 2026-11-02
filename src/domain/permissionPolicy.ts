import { isAbsolute, relative, resolve, sep } from "node:path";
import { dirname } from "node:path/posix";

import { parse, type ParseEntry } from "shell-quote";

import { findExecCommands, shellScript } from "./commandParse";
import {
  BRACE_EXPANSION_PATTERN,
  COMMAND_ALIAS_PATTERN,
  COMMAND_ALIAS_PREFIX,
  CWD_COMMANDS,
  DASH_PREFIX,
  DOWNLOAD_COMMANDS,
  ENV_ASSIGNMENT_PATTERN,
  FIND_COMMAND,
  FIND_ASK_FLAGS,
  FIND_FILES0_FLAG,
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
  GLOB_CHAR_PATTERN,
  HEADS_PREFIX_PATTERN,
  INTERPRETER_COMMANDS,
  MIGRATION_COMMANDS,
  NON_COMMAND_WORDS,
  OPAQUE_COMMANDS,
  PIPE_OPERATOR,
  PRIVILEGE_COMMANDS,
  PROTECTED_BRANCHES,
  READ_ONLY_COMMANDS,
  READ_ONLY_FORBIDDEN_FLAGS,
  REFS_PREFIX_PATTERN,
  REASON_GIT_PUSH,
  REASON_MIGRATION,
  REASON_PIPE_TO_SHELL,
  REASON_PLAN_NO_WRITES,
  REASON_PRIVILEGE,
  REASON_RM_OUTSIDE,
  RM_LONG_PREFIX_MIN_LENGTH,
  RM_RECURSIVE_FLAGS,
  RM_SHORT_FLAG_LETTERS,
  RUNTIME_WORD_PATTERN,
  SEGMENT_OPERATORS,
  SHELL_COMMANDS,
  TRUSTED_BIN_DIRS,
  UNPARSEABLE_SUBSTRINGS,
  UNREPORTED_GLOB_START_PATTERN,
  UNRESOLVED_PATH_PREFIX,
  UNSUPPORTED_WHITESPACE_PATTERN,
  VARIABLE_MARKER,
  VERSION_SUFFIX_PATTERN,
  WRAPPER_SPECS,
  type WrapperSpec,
} from "./permissionRules";
import { PermissionProfile } from "./types";

export interface PermissionQuery {
  readonly kind: "read" | "edit" | "execute" | "other";
  readonly command?: string;
  readonly paths?: readonly string[];
}

export type PermissionDecision =
  | { readonly action: "allow" }
  | { readonly action: "ask" }
  | { readonly action: "deny"; readonly reason: string };

export interface PermissionContext {
  readonly worktreeRoot: string;
}

interface Segment {
  readonly words: readonly string[];
  readonly pipedFromPrevious: boolean;
  readonly leadingGlob: boolean;
}

interface ScopedContext extends PermissionContext {
  readonly cwdUnresolved: boolean;
}

interface OptionStep {
  readonly consumed: number;
  readonly known: boolean;
  readonly split?: string;
  readonly option?: string;
}

interface OptionScan {
  readonly rest: readonly string[];
  readonly uncertain: boolean;
  readonly writes: boolean;
  readonly chdir: boolean;
}

interface Unwrapped {
  readonly words: readonly string[];
  readonly uncertain: boolean;
  readonly writes: boolean;
  readonly chdir: boolean;
}

const ALLOW: PermissionDecision = { action: "allow" };
const ASK: PermissionDecision = { action: "ask" };
const PLAN_DENY: PermissionDecision = {
  action: "deny",
  reason: REASON_PLAN_NO_WRITES,
};
const SEVERITY: Readonly<Record<PermissionDecision["action"], number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const SHORT_FLAG_PREFIX = "-";
const LONG_FLAG_PREFIX = "--";
const LONG_VALUE_SEPARATOR = "=";
const WHITESPACE_PATTERN = /\s+/;
const PUSH_SUBCOMMAND = "push";
const FORCE_PUSH_REFSPEC_PREFIX = "+";
const REFSPEC_SEPARATOR = ":";
const WILDCARD_CHAR = "*";

function mostRestrictive(
  decisions: readonly PermissionDecision[],
): PermissionDecision {
  return decisions.reduce(
    (worst, next) =>
      SEVERITY[next.action] > SEVERITY[worst.action] ? next : worst,
    ALLOW,
  );
}

function deny(reason: string): PermissionDecision {
  return { action: "deny", reason };
}

function baseName(command: string): string {
  return command.split(PATH_SEPARATOR_PATTERN).pop() ?? command;
}

function isShortFlagCluster(arg: string): boolean {
  return arg.startsWith(SHORT_FLAG_PREFIX) && !arg.startsWith(LONG_FLAG_PREFIX);
}

function decideWrite(profile: PermissionProfile): PermissionDecision {
  switch (profile) {
    case PermissionProfile.unattended:
      return ALLOW;
    case PermissionProfile.plan:
      return PLAN_DENY;
    default:
      return ASK;
  }
}

function splitSegments(tokens: readonly ParseEntry[]): Segment[] | null {
  const segments: Segment[] = [];
  let words: string[] = [];
  let pipedFromPrevious = false;
  let nextPiped = false;
  let leadingGlob = false;
  const close = (): void => {
    if (words.length > 0) {
      segments.push({ words, pipedFromPrevious, leadingGlob });
    }
    words = [];
    leadingGlob = false;
    pipedFromPrevious = nextPiped;
  };
  for (const token of tokens) {
    if (typeof token === "string") {
      words.push(token);
    } else if ("pattern" in token) {
      words.push(token.pattern);
      leadingGlob ||= GLOB_CHAR_PATTERN.test(token.pattern.charAt(0));
    } else if ("op" in token && SEGMENT_OPERATORS.includes(token.op)) {
      nextPiped = token.op === PIPE_OPERATOR;
      close();
    } else {
      return null;
    }
  }
  nextPiped = false;
  close();
  return segments;
}

function longOptionStep(
  spec: WrapperSpec,
  args: readonly string[],
  index: number,
): OptionStep {
  const word = args[index] ?? "";
  const separator = word.indexOf(LONG_VALUE_SEPARATOR);
  const inline = separator < 0 ? undefined : word.slice(separator + 1);
  const name = word.slice(
    LONG_FLAG_PREFIX.length,
    separator < 0 ? undefined : separator,
  );
  const consumed = inline === undefined ? 2 : 1;
  const value = inline ?? args[index + 1] ?? "";
  if (spec.splitLong.includes(name)) {
    return { consumed, known: true, split: value };
  }
  if (spec.valueLong.includes(name)) {
    return { consumed, known: true, option: `${LONG_FLAG_PREFIX}${name}` };
  }
  return {
    consumed: 1,
    known: inline === undefined && spec.flagLong.includes(name),
  };
}

function shortClusterStep(
  spec: WrapperSpec,
  args: readonly string[],
  index: number,
): OptionStep {
  const letters = (args[index] ?? "").slice(SHORT_FLAG_PREFIX.length);
  for (let position = 0; position < letters.length; position += 1) {
    const letter = letters.charAt(position);
    const attached = letters.slice(position + 1);
    const consumed = attached === "" ? 2 : 1;
    const value = attached === "" ? (args[index + 1] ?? "") : attached;
    if (spec.splitShort.includes(letter)) {
      return { consumed, known: true, split: value };
    }
    if (spec.valueShort.includes(letter)) {
      return { consumed, known: true, option: `${SHORT_FLAG_PREFIX}${letter}` };
    }
    if (spec.optionalShort.includes(letter)) {
      return { consumed: 1, known: true };
    }
    if (!spec.flagShort.includes(letter)) {
      return { consumed: 1, known: false };
    }
  }
  return { consumed: 1, known: true };
}

function scanWrapperOptions(
  spec: WrapperSpec,
  initial: readonly string[],
): OptionScan {
  let args = initial;
  let index = 0;
  let uncertain = false;
  let writes = false;
  let chdir = false;
  while (index < args.length) {
    const word = args[index] ?? "";
    if (word === LONG_FLAG_PREFIX) {
      index += 1;
      break;
    }
    if (word === SHORT_FLAG_PREFIX) {
      index += 1;
    } else if (word.startsWith(SHORT_FLAG_PREFIX)) {
      const step = word.startsWith(LONG_FLAG_PREFIX)
        ? longOptionStep(spec, args, index)
        : shortClusterStep(spec, args, index);
      uncertain ||= !step.known;
      writes ||= spec.writeOptions.includes(step.option ?? "");
      chdir ||= spec.chdirOptions.includes(step.option ?? "");
      if (step.split === undefined) {
        index += step.consumed;
      } else {
        uncertain = true;
        args = [
          ...step.split.split(WHITESPACE_PATTERN).filter(Boolean),
          ...args.slice(index + step.consumed),
        ];
        index = 0;
      }
    } else {
      break;
    }
  }
  return {
    rest: args.slice(index + spec.positional),
    uncertain,
    writes,
    chdir,
  };
}

function isTrustedExecutable(word: string): boolean {
  return (
    !PATH_SEPARATOR_PATTERN.test(word) ||
    TRUSTED_BIN_DIRS.includes(dirname(word))
  );
}

function unwrap(words: readonly string[]): Unwrapped {
  let rest = words;
  let uncertain = false;
  let writes = false;
  let chdir = false;
  for (;;) {
    const first = rest[0];
    if (first === undefined) {
      return { words: rest, uncertain, writes, chdir };
    }
    if (ENV_ASSIGNMENT_PATTERN.test(first)) {
      rest = rest.slice(1);
      uncertain = true;
      continue;
    }
    const spec = RUNTIME_WORD_PATTERN.test(first)
      ? undefined
      : WRAPPER_SPECS.get(baseName(first));
    if (spec === undefined) {
      return { words: rest, uncertain, writes, chdir };
    }
    const scan = scanWrapperOptions(spec, rest.slice(1));
    rest = scan.rest;
    uncertain ||=
      scan.uncertain || spec.injectsArgs || !isTrustedExecutable(first);
    writes ||= scan.writes;
    chdir ||= scan.chdir;
  }
}

export function isInsideWorktree(
  target: string,
  worktreeRoot: string,
  cwdUnresolved: boolean,
): boolean {
  if (
    target.startsWith(UNRESOLVED_PATH_PREFIX) ||
    target.includes(VARIABLE_MARKER) ||
    (cwdUnresolved && !isAbsolute(target))
  ) {
    return false;
  }
  const relation = relative(worktreeRoot, resolve(worktreeRoot, target));
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function isRiskyRmFlag(flag: string): boolean {
  return (
    (flag.length >= RM_LONG_PREFIX_MIN_LENGTH &&
      RM_RECURSIVE_FLAGS.some((full) => full.startsWith(flag))) ||
    (isShortFlagCluster(flag) &&
      RM_SHORT_FLAG_LETTERS.some((letter) => flag.slice(1).includes(letter)))
  );
}

function isDangerousRm(args: readonly string[], ctx: ScopedContext): boolean {
  const separator = args.indexOf(LONG_FLAG_PREFIX);
  const optionArgs = separator < 0 ? args : args.slice(0, separator);
  const flags = optionArgs.filter((arg) => arg.startsWith(SHORT_FLAG_PREFIX));
  const targets = [
    ...optionArgs.filter((arg) => !arg.startsWith(SHORT_FLAG_PREFIX)),
    ...(separator < 0 ? [] : args.slice(separator + 1)),
  ];
  if (!flags.some(isRiskyRmFlag)) {
    return false;
  }
  return (
    targets.length === 0 ||
    targets.some(
      (target) =>
        !isInsideWorktree(target, ctx.worktreeRoot, ctx.cwdUnresolved),
    )
  );
}

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
    ref.includes(WILDCARD_CHAR) ||
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

function isDangerousGitPush(args: readonly string[]): boolean {
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

function isUncertainGitPush(name: string, args: readonly string[]): boolean {
  const rest = pushArguments(args);
  if (name !== "git" || rest === null) {
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

function hasGitInlineConfig(name: string, args: readonly string[]): boolean {
  if (name !== "git") {
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

function isPrivilegeLookalike(first: string, args: readonly string[]): boolean {
  return (
    first.startsWith(COMMAND_ALIAS_PREFIX) ||
    args.some((word) =>
      PRIVILEGE_COMMANDS.includes(
        baseName(word.replace(COMMAND_ALIAS_PATTERN, "")),
      ),
    )
  );
}

function isDirectoryChange(words: readonly string[]): boolean {
  const first = words.find((word) => !NON_COMMAND_WORDS.includes(word));
  return first !== undefined && CWD_COMMANDS.includes(baseName(first));
}

function matchesMigration(words: readonly string[]): boolean {
  return MIGRATION_COMMANDS.some(([name, ...subcommand]) =>
    words.some(
      (word, index) =>
        baseName(word) === name &&
        subcommand.every((part, offset) => words[index + 1 + offset] === part),
    ),
  );
}

function isInterpreter(name: string): boolean {
  return INTERPRETER_COMMANDS.includes(
    name.replace(VERSION_SUFFIX_PATTERN, ""),
  );
}

function isDownloadSegment(segment: Segment): boolean {
  return DOWNLOAD_COMMANDS.includes(
    baseName(unwrap(segment.words).words[0] ?? ""),
  );
}

function isDownloadPipedIntoExecutor(
  name: string,
  upstream: readonly Segment[],
): boolean {
  return (
    (SHELL_COMMANDS.includes(name) || isInterpreter(name)) &&
    upstream.some(isDownloadSegment)
  );
}

function pipeUpstream(
  segments: readonly Segment[],
  index: number,
): readonly Segment[] {
  let start = index;
  while (start > 0 && segments[start]?.pipedFromPrevious === true) {
    start -= 1;
  }
  return segments.slice(start, index);
}

function commandDangerReason(
  name: string,
  args: readonly string[],
  ctx: ScopedContext,
): string | null {
  if (PRIVILEGE_COMMANDS.includes(name)) {
    return REASON_PRIVILEGE;
  }
  if (name === "rm" && isDangerousRm(args, ctx)) {
    return REASON_RM_OUTSIDE;
  }
  return name === "git" && isDangerousGitPush(args) ? REASON_GIT_PUSH : null;
}

function dangerReason(
  words: readonly string[],
  upstream: readonly Segment[],
  ctx: ScopedContext,
): string | null {
  const [first = "", ...args] = words;
  const name = baseName(first);
  const direct = commandDangerReason(name, args, ctx);
  if (direct !== null) {
    return direct;
  }
  if (isDownloadPipedIntoExecutor(name, upstream)) {
    return REASON_PIPE_TO_SHELL;
  }
  return matchesMigration(words) ? REASON_MIGRATION : null;
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

function isOptionWord(word: string): boolean {
  return word.startsWith(SHORT_FLAG_PREFIX);
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

function isReadOnlyGit(args: readonly string[]): boolean {
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

function hasAbbreviatedFlag(
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

function hasAnyFlag(
  args: readonly string[],
  flags: readonly string[],
): boolean {
  return args.some((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

function isReadOnlyCommand(name: string, args: readonly string[]): boolean {
  if (name === "git") {
    return isReadOnlyGit(args);
  }
  return (
    READ_ONLY_COMMANDS.includes(name) &&
    !hasAnyFlag(args, READ_ONLY_FORBIDDEN_FLAGS.get(name) ?? [])
  );
}

function isUnseenExpansion(word: string): boolean {
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

function decideFind(
  args: readonly string[],
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const nested = findExecCommands(args).map((words) => {
    const inner = decideSegmentWords(
      { words, pipedFromPrevious: false, leadingGlob: false },
      [],
      PermissionProfile.ask,
      ctx,
    );
    return inner.action === ALLOW.action
      ? inner
      : mostRestrictive([inner, decideWrite(profile)]);
  });
  const untrusted = args.some((arg) => FIND_ASK_FLAGS.includes(arg))
    ? mostRestrictive([ASK, decideWrite(profile)])
    : ALLOW;
  const feedsPlaceholder =
    nested.length > 0 && args.includes(FIND_FILES0_FLAG) ? ASK : ALLOW;
  return mostRestrictive([untrusted, feedsPlaceholder, ...nested]);
}

function decideSegmentWords(
  segment: Segment,
  upstream: readonly Segment[],
  profile: PermissionProfile,
  outer: ScopedContext,
): PermissionDecision {
  const unwrapped = unwrap(segment.words);
  const [first, ...args] = unwrapped.words;
  const ctx = unwrapped.chdir ? { ...outer, cwdUnresolved: true } : outer;
  if (first === undefined) {
    return ASK;
  }
  if (NON_COMMAND_WORDS.includes(first) || first.startsWith(DASH_PREFIX)) {
    const inner = { ...segment, words: args };
    return mostRestrictive([
      ASK,
      decideSegmentWords(inner, upstream, profile, ctx),
    ]);
  }
  const reason = dangerReason(unwrapped.words, upstream, ctx);
  if (reason !== null) {
    return deny(reason);
  }
  const needsConfirmation =
    unwrapped.uncertain ||
    isPrivilegeLookalike(first, args) ||
    hasGitInlineConfig(baseName(first), args) ||
    isUncertainGitPush(baseName(first), args);
  return mostRestrictive([
    decideCommand(first, args, profile, ctx),
    needsConfirmation ? ASK : ALLOW,
    unwrapped.writes ? mostRestrictive([ASK, decideWrite(profile)]) : ALLOW,
  ]);
}

function decideSegment(
  segment: Segment,
  upstream: readonly Segment[],
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const decision = decideSegmentWords(segment, upstream, profile, ctx);
  return segment.leadingGlob || segment.words.some(isUnseenExpansion)
    ? mostRestrictive([ASK, decision])
    : decision;
}

function decideCommand(
  first: string,
  args: readonly string[],
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const name = baseName(first);
  if (RUNTIME_WORD_PATTERN.test(first) || OPAQUE_COMMANDS.includes(name)) {
    return ASK;
  }
  if (!isTrustedExecutable(first)) {
    return decideWrite(profile);
  }
  if (name === FIND_COMMAND) {
    return decideFind(args, profile, ctx);
  }
  if (SHELL_COMMANDS.includes(name)) {
    const script = shellScript(args);
    return script === undefined
      ? mostRestrictive([ASK, decideWrite(profile)])
      : decideExecute(script, profile, ctx);
  }
  if (isInterpreter(name) && args.every(isOptionWord)) {
    return mostRestrictive([ASK, decideWrite(profile)]);
  }
  return isReadOnlyCommand(name, args) ? ALLOW : decideWrite(profile);
}

function decideExecute(
  command: string | undefined,
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  if (
    command === undefined ||
    command.trim() === "" ||
    UNSUPPORTED_WHITESPACE_PATTERN.test(command) ||
    UNPARSEABLE_SUBSTRINGS.some((fragment) => command.includes(fragment))
  ) {
    return ASK;
  }
  const segments = splitSegments(
    parse(command, (key) => `${VARIABLE_MARKER}${key}`),
  );
  if (segments === null || segments.length === 0) {
    return ASK;
  }
  const decisions: PermissionDecision[] = [];
  let cwdUnresolved = ctx.cwdUnresolved;
  for (const [index, segment] of segments.entries()) {
    decisions.push(
      decideSegment(segment, pipeUpstream(segments, index), profile, {
        ...ctx,
        cwdUnresolved,
      }),
    );
    cwdUnresolved =
      cwdUnresolved || isDirectoryChange(unwrap(segment.words).words);
  }
  return mostRestrictive(decisions);
}

function planReadOnly(
  decision: PermissionDecision,
  profile: PermissionProfile,
): PermissionDecision {
  return profile === PermissionProfile.plan && decision.action === ASK.action
    ? PLAN_DENY
    : decision;
}

function decideEdit(
  paths: readonly string[] | undefined,
  profile: PermissionProfile,
  ctx: PermissionContext,
): PermissionDecision {
  const confined =
    paths !== undefined &&
    paths.length > 0 &&
    paths.every((path) => isInsideWorktree(path, ctx.worktreeRoot, false));
  if (!confined) {
    return mostRestrictive([ASK, decideWrite(profile)]);
  }
  return profile === PermissionProfile.acceptEdits
    ? ALLOW
    : decideWrite(profile);
}

export function decidePermission(
  query: PermissionQuery,
  profile: PermissionProfile,
  ctx: PermissionContext,
): PermissionDecision {
  if (profile === PermissionProfile.bypass) {
    return ALLOW;
  }
  switch (query.kind) {
    case "read":
      return ALLOW;
    case "edit":
      return decideEdit(query.paths, profile, ctx);
    case "execute":
      return planReadOnly(
        decideExecute(query.command, profile, {
          ...ctx,
          cwdUnresolved: false,
        }),
        profile,
      );
    case "other":
      return profile === PermissionProfile.unattended ? ALLOW : ASK;
  }
}
