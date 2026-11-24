import { posix, win32, type PlatformPath } from "node:path";

import {
  ASSIGNMENT_SEPARATOR,
  CASE_FOLDED_PLATFORMS,
  GLOB_CHAR_PATTERN,
  HOME_RELATIVE_PREFIX,
  HOME_RELATIVE_PREFIX_WIN32,
  PATH_WILDCARD,
  POSIX_SEPARATOR,
  UNRESOLVED_PATH_PREFIX,
  VARIABLE_MARKER,
  WIN32_PLATFORM,
  WIN32_SEPARATOR,
} from "./permissionRules";

export type WorktreeRoots = readonly [string, ...string[]];

export interface PermissionContext {
  readonly worktreeRoots: WorktreeRoots;
  readonly homeDir: string;
  readonly protectedPaths: readonly string[];
}

interface SplitPath {
  readonly root: string;
  readonly segments: readonly string[];
}

const GLOB_CLASS_PATTERN = /\[[^\]]*\]/g;
const REGEX_SPECIAL_PATTERN = /[.+^${}()|[\]\\]/g;
const ESCAPED_MATCH = "\\$&";
const ANY_RUN = ".*";
const ANY_CHAR = ".";
const SINGLE_CHAR_GLOB = "?";
const HIDDEN_PREFIX = ".";
const PARENT_SEGMENT = "..";
const WIN32_SEPARATOR_PATTERN = /[\\/]+/;
const POSIX_SEPARATOR_PATTERN = /\/+/;
const NOT_FOUND = -1;
const SHORT_OPTION_PREFIX = "-";
const LONG_OPTION_PREFIX = "--";
const ATTACHED_VALUE_MIN_INDEX = 2;

function pathFlavor(platform: NodeJS.Platform): PlatformPath {
  return platform === WIN32_PLATFORM ? win32 : posix;
}

function foldCase(text: string, platform: NodeJS.Platform): string {
  return CASE_FOLDED_PLATFORMS.includes(platform) ? text.toLowerCase() : text;
}

function splitPath(path: string, platform: NodeJS.Platform): SplitPath {
  const flavor = pathFlavor(platform);
  const resolved = flavor.resolve(path);
  const { root } = flavor.parse(resolved);
  const separator =
    platform === WIN32_PLATFORM
      ? WIN32_SEPARATOR_PATTERN
      : POSIX_SEPARATOR_PATTERN;
  return {
    root: foldCase(root, platform),
    segments: resolved
      .slice(root.length)
      .split(separator)
      .filter((segment) => segment !== "")
      .map((segment) => foldCase(segment, platform)),
  };
}

function wildcardMatches(pattern: string, text: string): boolean {
  const [first = "", ...rest] = pattern.split(PATH_WILDCARD);
  const last = rest.pop();
  if (last === undefined) {
    return pattern === text;
  }
  const limit = text.length - last.length;
  if (limit < first.length || !text.startsWith(first) || !text.endsWith(last)) {
    return false;
  }
  let position = first.length;
  for (const part of rest) {
    const found = text.indexOf(part, position);
    if (found === NOT_FOUND || found + part.length > limit) {
      return false;
    }
    position = found + part.length;
  }
  return true;
}

function globMayMatch(glob: string, literal: string): boolean {
  if (
    GLOB_CHAR_PATTERN.test(glob.charAt(0)) &&
    literal.startsWith(HIDDEN_PREFIX)
  ) {
    return false;
  }
  const source = glob
    .replace(GLOB_CLASS_PATTERN, SINGLE_CHAR_GLOB)
    .replace(REGEX_SPECIAL_PATTERN, ESCAPED_MATCH)
    .replaceAll(PATH_WILDCARD, ANY_RUN)
    .replaceAll(SINGLE_CHAR_GLOB, ANY_CHAR);
  return new RegExp(`^${source}$`).test(literal);
}

function segmentMatches(pattern: string, target: string): boolean {
  return (
    wildcardMatches(pattern, target) ||
    (GLOB_CHAR_PATTERN.test(target) && globMayMatch(target, pattern))
  );
}

function sharesPrefix(target: SplitPath, pattern: SplitPath): boolean {
  const shared = Math.min(target.segments.length, pattern.segments.length);
  return (
    target.root === pattern.root &&
    pattern.segments
      .slice(0, shared)
      .every((segment, index) =>
        segmentMatches(segment, target.segments[index] ?? ""),
      )
  );
}

function absolutePatterns(
  patterns: readonly string[],
  platform: NodeJS.Platform,
): SplitPath[] {
  const flavor = pathFlavor(platform);
  return patterns
    .filter((pattern) => flavor.isAbsolute(pattern))
    .map((pattern) => splitPath(pattern, platform));
}

export function isProtectedPath(
  path: string,
  patterns: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const target = splitPath(path, platform);
  return absolutePatterns(patterns, platform).some(
    (pattern) =>
      pattern.segments.length <= target.segments.length &&
      sharesPrefix(target, pattern),
  );
}

export function isProtectedAncestor(
  path: string,
  patterns: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const target = splitPath(path, platform);
  return absolutePatterns(patterns, platform).some(
    (pattern) =>
      pattern.segments.length > target.segments.length &&
      sharesPrefix(target, pattern),
  );
}

function isHomeRelative(target: string, platform: NodeJS.Platform): boolean {
  return (
    target.startsWith(HOME_RELATIVE_PREFIX) ||
    (platform === WIN32_PLATFORM &&
      target.startsWith(HOME_RELATIVE_PREFIX_WIN32))
  );
}

export function resolveTarget(
  target: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const flavor = pathFlavor(platform);
  if (target.includes(VARIABLE_MARKER)) {
    return null;
  }
  if (target === UNRESOLVED_PATH_PREFIX) {
    return flavor.resolve(ctx.homeDir);
  }
  if (isHomeRelative(target, platform)) {
    return flavor.resolve(
      ctx.homeDir,
      target.slice(HOME_RELATIVE_PREFIX.length),
    );
  }
  if (target.startsWith(UNRESOLVED_PATH_PREFIX)) {
    return null;
  }
  if (flavor.isAbsolute(target)) {
    return flavor.resolve(target);
  }
  return cwd !== null && flavor.isAbsolute(cwd)
    ? flavor.resolve(cwd, target)
    : null;
}

function isBelow(
  resolved: string,
  root: string,
  flavor: PlatformPath,
): boolean {
  const relation = flavor.relative(root, resolved);
  return (
    relation !== "" &&
    relation !== PARENT_SEGMENT &&
    !relation.startsWith(`${PARENT_SEGMENT}${flavor.sep}`) &&
    !flavor.isAbsolute(relation)
  );
}

export function isBelowRoot(
  target: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flavor = pathFlavor(platform);
  return isBelow(flavor.resolve(root, target), root, flavor);
}

export function isInsideWorktree(
  target: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved = resolveTarget(target, ctx, cwd, platform);
  const flavor = pathFlavor(platform);
  return (
    resolved !== null &&
    ctx.worktreeRoots.some((root) => isBelow(resolved, root, flavor)) &&
    !isProtectedPath(resolved, ctx.protectedPaths, platform)
  );
}

export function isWithinRoot(
  target: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved = resolveTarget(target, ctx, cwd, platform);
  return (
    resolved !== null &&
    (ctx.worktreeRoots.some(
      (root) => pathFlavor(platform).relative(root, resolved) === "",
    ) ||
      isInsideWorktree(target, ctx, cwd, platform))
  );
}

export function isProtectedTarget(
  target: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved = resolveTarget(target, ctx, cwd, platform);
  return (
    resolved !== null && isProtectedPath(resolved, ctx.protectedPaths, platform)
  );
}

export function isProtectedOrAncestor(
  target: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved = resolveTarget(target, ctx, cwd, platform);
  return (
    resolved !== null &&
    (isProtectedPath(resolved, ctx.protectedPaths, platform) ||
      isProtectedAncestor(resolved, ctx.protectedPaths, platform))
  );
}

function fixedSegments(pattern: SplitPath): readonly string[] {
  const wildcard = pattern.segments.findIndex((segment) =>
    segment.includes(PATH_WILDCARD),
  );
  return wildcard === NOT_FOUND
    ? pattern.segments
    : pattern.segments.slice(0, wildcard);
}

function isFixedPrefixTarget(
  target: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform,
): boolean {
  const resolved = resolveTarget(target, ctx, cwd, platform);
  if (resolved === null) {
    return false;
  }
  const split = splitPath(resolved, platform);
  return absolutePatterns(ctx.protectedPaths, platform).some((pattern) => {
    const fixed = fixedSegments(pattern);
    return (
      pattern.root === split.root &&
      fixed.length >= split.segments.length &&
      split.segments.every((segment, index) =>
        segmentMatches(fixed[index] ?? "", segment),
      )
    );
  });
}

function tildeForms(
  fixed: readonly string[],
  pattern: SplitPath,
  home: SplitPath,
  platform: NodeJS.Platform,
): string[] {
  const below =
    home.root === pattern.root &&
    fixed.length > home.segments.length &&
    home.segments.every((segment, index) => segment === fixed[index]);
  if (!below) {
    return [];
  }
  const rest = fixed.slice(home.segments.length);
  return [
    `${HOME_RELATIVE_PREFIX}${rest.join(POSIX_SEPARATOR)}`,
    ...(platform === WIN32_PLATFORM
      ? [`${HOME_RELATIVE_PREFIX_WIN32}${rest.join(WIN32_SEPARATOR)}`]
      : []),
  ];
}

function protectedForms(
  ctx: PermissionContext,
  platform: NodeJS.Platform,
): string[] {
  const home = splitPath(ctx.homeDir, platform);
  return absolutePatterns(ctx.protectedPaths, platform).flatMap((pattern) => {
    const fixed = fixedSegments(pattern);
    if (fixed.length === 0) {
      return [];
    }
    const absolute = `${pattern.root}${fixed.join(pathFlavor(platform).sep)}`;
    return [
      absolute,
      ...(platform === WIN32_PLATFORM
        ? [absolute.replaceAll(WIN32_SEPARATOR, POSIX_SEPARATOR)]
        : []),
      ...tildeForms(fixed, pattern, home, platform),
    ];
  });
}

function attachedOperands(word: string): string[] {
  if (
    !word.startsWith(SHORT_OPTION_PREFIX) ||
    word.startsWith(LONG_OPTION_PREFIX)
  ) {
    return [];
  }
  return Array.from(
    { length: Math.max(word.length - ATTACHED_VALUE_MIN_INDEX, 0) },
    (_, offset) => word.slice(ATTACHED_VALUE_MIN_INDEX + offset),
  );
}

export function mentionsProtectedPath(
  word: string,
  ctx: PermissionContext,
  cwd: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const assigned = word.slice(word.indexOf(ASSIGNMENT_SEPARATOR) + 1);
  const folded = foldCase(word, platform);
  return (
    [word, assigned, ...attachedOperands(word)].some(
      (operand) =>
        isProtectedTarget(operand, ctx, cwd, platform) ||
        isFixedPrefixTarget(operand, ctx, cwd, platform),
    ) || protectedForms(ctx, platform).some((form) => folded.includes(form))
  );
}
