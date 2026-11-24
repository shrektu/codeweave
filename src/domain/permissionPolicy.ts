import { dirname } from "node:path/posix";

import { parse, type ParseEntry } from "shell-quote";

import { findExecCommands, shellScript } from "./commandParse";
import {
  advanceCwd,
  directoryCommand,
  overridesCdEnv,
  type CwdCursor,
} from "./cwdTracking";
import {
  isInsideWorktree,
  isProtectedOrAncestor,
  isProtectedTarget,
  isWithinRoot,
  mentionsProtectedPath,
  type PermissionContext,
} from "./pathScope";
import {
  hasGitInlineConfig,
  isDangerousGitPush,
  isReadOnlyGit,
  isUncertainGitPush,
} from "./gitRules";
import {
  CD_COMMAND,
  COMMAND_ALIAS_PATTERN,
  COMMAND_ALIAS_PREFIX,
  CWD_COMMANDS,
  DASH_PREFIX,
  DOWNLOAD_COMMANDS,
  ENV_ASSIGNMENT_PATTERN,
  ENV_COMMAND,
  FD_DUPLICATION_OPERATORS,
  FD_TARGET_PATTERN,
  FIND_COMMAND,
  FIND_ASK_FLAGS,
  FIND_FILES0_FLAG,
  GLOB_CHAR_PATTERN,
  HARMLESS_WRITE_TARGETS,
  INPUT_REDIRECT_OPERATORS,
  INTERPRETER_COMMANDS,
  MIGRATION_COMMANDS,
  NETWORK_DEVICE_PREFIXES,
  NON_COMMAND_WORDS,
  OPAQUE_COMMANDS,
  PIPE_OPERATOR,
  PRIVILEGE_COMMANDS,
  READ_ONLY_COMMANDS,
  READ_ONLY_FORBIDDEN_FLAGS,
  REASON_GIT_PUSH,
  REASON_MIGRATION,
  REASON_PIPE_TO_SHELL,
  REASON_PLAN_NO_WRITES,
  REASON_PRIVILEGE,
  REASON_RM_OUTSIDE,
  REASON_RM_PROTECTED,
  RM_LONG_PREFIX_MIN_LENGTH,
  RM_RECURSIVE_FLAGS,
  RM_SHORT_FLAG_LETTERS,
  RUNTIME_WORD_PATTERN,
  SEGMENT_OPERATORS,
  SHELL_COMMANDS,
  hasGitSensitivePrefix,
  hasGitSensitiveSubscript,
  isRiskyEnvName,
  setsGitSensitiveEnv,
  TRUSTED_BIN_DIRS,
  UNPARSEABLE_SUBSTRINGS,
  UNSUPPORTED_WHITESPACE_PATTERN,
  VARIABLE_MARKER,
  VERSION_SUFFIX_PATTERN,
  WRAPPER_SPECS,
  type WrapperSpec,
} from "./permissionRules";
import {
  bindRedirections,
  fdRedirectionFlags,
  type Redirection,
} from "./shellRedirects";
import {
  baseName,
  isShortFlagCluster,
  isUnseenExpansion,
  LONG_FLAG_PREFIX,
  LONG_VALUE_SEPARATOR,
  PATH_SEPARATOR_PATTERN,
  SHORT_FLAG_PREFIX,
} from "./shellWords";
import { PermissionProfile } from "./types";

export interface PermissionQuery {
  readonly kind: "read" | "edit" | "execute" | "other";
  readonly command?: string;
  readonly paths?: readonly string[];
  readonly cwd?: string;
}

export type PermissionDecision =
  | { readonly action: "allow" }
  | { readonly action: "ask" }
  | { readonly action: "deny"; readonly reason: string };

export type { PermissionContext };

interface Segment {
  readonly words: readonly string[];
  readonly pipedFromPrevious: boolean;
  readonly leadingGlob: boolean;
  readonly redirections: readonly Redirection[];
  readonly followedBy: string | null;
}

interface ScopedContext extends PermissionContext {
  readonly cwd: string | null;
  readonly envOverridden: boolean;
  readonly cdEnvTainted: boolean;
  readonly touchesProtected: boolean;
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
  readonly assigns: boolean;
  readonly writes: boolean;
  readonly chdir: boolean;
  readonly wrapped: boolean;
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
const WHITESPACE_PATTERN = /\s+/;

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

function decideWriteAt(
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const scoped =
    ctx.cwd !== null &&
    !ctx.touchesProtected &&
    isWithinRoot(ctx.cwd, ctx, ctx.cwd);
  return scoped
    ? decideWrite(profile)
    : mostRestrictive([ASK, decideWrite(profile)]);
}

function splitSegments(
  tokens: readonly ParseEntry[],
  fdFlags: readonly boolean[],
): Segment[] | null {
  const bound = bindRedirections(tokens, fdFlags);
  if (bound === null) {
    return null;
  }
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirections: Redirection[] = [];
  let pipedFromPrevious = false;
  let nextPiped = false;
  let leadingGlob = false;
  const close = (followedBy: string | null): void => {
    if (words.length > 0 || redirections.length > 0) {
      segments.push({
        words,
        pipedFromPrevious,
        leadingGlob,
        redirections,
        followedBy,
      });
    }
    words = [];
    redirections = [];
    leadingGlob = false;
    pipedFromPrevious = nextPiped;
  };
  for (const token of bound) {
    if (typeof token === "string") {
      words.push(token);
    } else if ("target" in token) {
      redirections.push(token);
    } else if ("pattern" in token) {
      words.push(token.pattern);
      leadingGlob ||= GLOB_CHAR_PATTERN.test(token.pattern.charAt(0));
    } else if ("op" in token && SEGMENT_OPERATORS.includes(token.op)) {
      nextPiped = token.op === PIPE_OPERATOR;
      close(token.op);
    } else {
      return null;
    }
  }
  nextPiped = false;
  close(null);
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

function isRelaxedAssignment(word: string, atStart: boolean): boolean {
  const name = word.slice(0, word.indexOf(LONG_VALUE_SEPARATOR));
  return atStart && !isRiskyEnvName(name);
}

function unwrap(words: readonly string[]): Unwrapped {
  let rest = words;
  let atStart = true;
  let uncertain = false;
  let assigns = false;
  let writes = false;
  let chdir = false;
  let wrapped = false;
  for (;;) {
    const first = rest[0];
    if (first === undefined) {
      return { words: rest, uncertain, assigns, writes, chdir, wrapped };
    }
    if (ENV_ASSIGNMENT_PATTERN.test(first)) {
      rest = rest.slice(1);
      const relaxed = isRelaxedAssignment(first, atStart);
      assigns ||= relaxed;
      uncertain ||= !relaxed;
      continue;
    }
    const spec = RUNTIME_WORD_PATTERN.test(first)
      ? undefined
      : WRAPPER_SPECS.get(baseName(first));
    if (spec === undefined) {
      return { words: rest, uncertain, assigns, writes, chdir, wrapped };
    }
    wrapped = true;
    const scan = scanWrapperOptions(spec, rest.slice(1));
    rest = scan.rest;
    atStart &&= baseName(first) === ENV_COMMAND;
    uncertain ||=
      scan.uncertain || spec.injectsArgs || !isTrustedExecutable(first);
    writes ||= scan.writes;
    chdir ||= scan.chdir;
  }
}

function isRiskyRmFlag(flag: string): boolean {
  return (
    (flag.length >= RM_LONG_PREFIX_MIN_LENGTH &&
      RM_RECURSIVE_FLAGS.some((full) => full.startsWith(flag))) ||
    (isShortFlagCluster(flag) &&
      RM_SHORT_FLAG_LETTERS.some((letter) => flag.slice(1).includes(letter)))
  );
}

function riskyRmTargets(args: readonly string[]): readonly string[] | null {
  const separator = args.indexOf(LONG_FLAG_PREFIX);
  const optionArgs = separator < 0 ? args : args.slice(0, separator);
  const flags = optionArgs.filter((arg) => arg.startsWith(SHORT_FLAG_PREFIX));
  if (!flags.some(isRiskyRmFlag)) {
    return null;
  }
  return [
    ...optionArgs.filter((arg) => !arg.startsWith(SHORT_FLAG_PREFIX)),
    ...(separator < 0 ? [] : args.slice(separator + 1)),
  ];
}

function rmDangerReason(
  args: readonly string[],
  ctx: ScopedContext,
): string | null {
  const targets = riskyRmTargets(args);
  if (targets === null) {
    return null;
  }
  if (targets.some((target) => isProtectedTarget(target, ctx, ctx.cwd))) {
    return REASON_RM_PROTECTED;
  }
  if (
    targets.length === 0 ||
    targets.some((target) => !isInsideWorktree(target, ctx, ctx.cwd))
  ) {
    return REASON_RM_OUTSIDE;
  }
  return targets.some((target) => isProtectedOrAncestor(target, ctx, ctx.cwd))
    ? REASON_RM_PROTECTED
    : null;
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

function decideDirectoryChange(
  args: readonly string[],
  ctx: ScopedContext,
): PermissionDecision {
  const change = directoryCommand([CD_COMMAND, ...args]);
  return change?.operands.some((target) =>
    isProtectedTarget(target, ctx, ctx.cwd),
  ) === true
    ? ASK
    : ALLOW;
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
  if (name === "rm") {
    const reason = rmDangerReason(args, ctx);
    if (reason !== null) {
      return reason;
    }
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

function isOptionWord(word: string): boolean {
  return word.startsWith(SHORT_FLAG_PREFIX);
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

function decideFind(
  args: readonly string[],
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const nested = findExecCommands(args).map((words) => {
    const inner = decideSegmentWords(
      {
        words,
        pipedFromPrevious: false,
        leadingGlob: false,
        redirections: [],
        followedBy: null,
      },
      [],
      PermissionProfile.ask,
      ctx,
    );
    return inner.action === ALLOW.action
      ? inner
      : mostRestrictive([inner, decideWriteAt(profile, ctx)]);
  });
  const untrusted = args.some((arg) => FIND_ASK_FLAGS.includes(arg))
    ? mostRestrictive([ASK, decideWriteAt(profile, ctx)])
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
  const cwd = unwrapped.chdir ? null : outer.cwd;
  const ctx: ScopedContext = {
    ...outer,
    cwd,
    touchesProtected: segment.words.some((word) =>
      mentionsProtectedPath(word, outer, cwd),
    ),
  };
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
    unwrapped.writes
      ? mostRestrictive([ASK, decideWriteAt(profile, ctx)])
      : ALLOW,
    unwrapped.assigns || ctx.envOverridden
      ? decideAssigns(first, profile, ctx)
      : ALLOW,
  ]);
}

function decideAssigns(
  command: string,
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const name = baseName(command);
  return name === "git" ||
    name === FIND_COMMAND ||
    SHELL_COMMANDS.includes(name)
    ? ASK
    : decideWriteAt(profile, ctx);
}

function decideRedirection(
  redirection: Redirection,
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const { op, target } = redirection;
  if (
    isUnseenExpansion(target) ||
    NETWORK_DEVICE_PREFIXES.some((prefix) => target.startsWith(prefix))
  ) {
    return mostRestrictive([ASK, decideWrite(profile)]);
  }
  if (
    INPUT_REDIRECT_OPERATORS.includes(op) ||
    (FD_DUPLICATION_OPERATORS.includes(op) && FD_TARGET_PATTERN.test(target)) ||
    HARMLESS_WRITE_TARGETS.includes(target)
  ) {
    return ALLOW;
  }
  return isInsideWorktree(target, ctx, ctx.cwd)
    ? decideWrite(profile)
    : mostRestrictive([ASK, decideWrite(profile)]);
}

function decideSegment(
  segment: Segment,
  upstream: readonly Segment[],
  profile: PermissionProfile,
  ctx: ScopedContext,
): PermissionDecision {
  const decision = mostRestrictive([
    decideSegmentWords(segment, upstream, profile, ctx),
    ...segment.redirections.map((redirection) =>
      decideRedirection(redirection, profile, ctx),
    ),
  ]);
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
  if (CWD_COMMANDS.includes(first)) {
    return decideDirectoryChange(args, ctx);
  }
  if (!isTrustedExecutable(first)) {
    return decideWriteAt(profile, ctx);
  }
  if (name === FIND_COMMAND) {
    return decideFind(args, profile, ctx);
  }
  if (SHELL_COMMANDS.includes(name)) {
    const script = shellScript(args);
    return script === undefined
      ? mostRestrictive([ASK, decideWriteAt(profile, ctx)])
      : decideExecute(script, profile, ctx);
  }
  if (isInterpreter(name) && args.every(isOptionWord)) {
    return mostRestrictive([ASK, decideWriteAt(profile, ctx)]);
  }
  return isReadOnlyCommand(name, args) ? ALLOW : decideWriteAt(profile, ctx);
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
  const fdFlags = fdRedirectionFlags(command);
  const segments =
    fdFlags === null
      ? null
      : splitSegments(
          parse(command, (key) => `${VARIABLE_MARKER}${key}`),
          fdFlags,
        );
  if (segments === null || segments.length === 0) {
    return ASK;
  }
  const decisions: PermissionDecision[] = [];
  let cursor: CwdCursor = { cwd: ctx.cwd, moved: false };
  let envOverridden = ctx.envOverridden;
  const cdEnvTainted =
    ctx.cdEnvTainted ||
    segments.some((segment) => overridesCdEnv(segment.words));
  for (const [index, segment] of segments.entries()) {
    const scoped = { ...ctx, cwd: cursor.cwd, envOverridden, cdEnvTainted };
    decisions.push(
      decideSegment(segment, pipeUpstream(segments, index), profile, scoped),
    );
    const unwrapped = unwrap(segment.words);
    const { words } = unwrapped;
    cursor = advanceCwd(
      {
        words,
        chdir: unwrapped.chdir,
        wrapped: unwrapped.wrapped,
        followedBy: segment.followedBy,
        precededBy: segments[index - 1]?.followedBy ?? null,
        pipedFromPrevious: segment.pipedFromPrevious,
        cdEnvTainted,
      },
      cursor,
      scoped,
    );
    envOverridden =
      envOverridden ||
      hasGitSensitivePrefix(segment.words) ||
      hasGitSensitiveSubscript(segment.words) ||
      setsGitSensitiveEnv(words);
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
    paths.every((path) => isInsideWorktree(path, ctx, ctx.worktreeRoots[0]));
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
          cwd: query.cwd ?? ctx.worktreeRoots[0],
          envOverridden: false,
          cdEnvTainted: false,
          touchesProtected: false,
        }),
        profile,
      );
    case "other":
      return profile === PermissionProfile.unattended ? ALLOW : ASK;
  }
}
