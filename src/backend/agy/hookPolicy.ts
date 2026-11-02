import { isAbsolute, join, relative, sep } from "node:path";

import { parse } from "shell-quote";

import {
  decidePermission,
  type PermissionQuery,
} from "../../domain/permissionPolicy";
import { PermissionProfile } from "../../domain/types";
import { absolutePath } from "../permissionQuery";

import {
  AGENTS_DIR_COMMAND_MAX_NESTING,
  AGENTS_DIR_COMMAND_PATTERN,
  AGENTS_DIR_NAME,
  AgyHookDecisionKind,
  AgyToolKind,
  AgyToolName,
  HOOK_AGENTS_DIR_REASON,
  HOOK_NEEDS_APPROVAL_REASON,
  HOOK_SUBAGENT_DENIED_REASON,
  SUBAGENT_TOOL_NAMES,
  TOOL_KIND_BY_NAME,
  TOOL_PARAM_COMMAND_LINE,
  TOOL_PARAM_CWD_KEYS,
  TOOL_PARAM_PATH_KEYS,
} from "./constants";
import type { AgyHookPayload } from "./protocol";
import { posixQuote } from "./shellQuote";

export interface AgyHookDecision {
  readonly decision: AgyHookDecisionKind;
  readonly reason?: string;
}

const ALLOW: AgyHookDecision = { decision: AgyHookDecisionKind.allow };

export function denyWith(reason: string): AgyHookDecision {
  return { decision: AgyHookDecisionKind.deny, reason };
}

function pathsOf(
  args: Readonly<Record<string, unknown>>,
  worktreeRoot: string,
): string[] {
  const raw = TOOL_PARAM_PATH_KEYS.map((key) => args[key]).filter(
    (value): value is string => typeof value === "string",
  );
  return [...new Set(raw.map((path) => absolutePath(path, worktreeRoot)))];
}

function foreignWorkingDirectory(
  args: Readonly<Record<string, unknown>>,
  worktreeRoot: string,
): string | null {
  const raw = TOOL_PARAM_CWD_KEYS.map((key) => args[key]).find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (raw === undefined) {
    return null;
  }
  const resolved = absolutePath(raw, worktreeRoot);
  return isAbsolute(resolved) && relative(worktreeRoot, resolved) === ""
    ? null
    : resolved;
}

function commandOf(
  args: Readonly<Record<string, unknown>>,
  worktreeRoot: string,
): string | undefined {
  const command = args[TOOL_PARAM_COMMAND_LINE];
  if (typeof command !== "string") {
    return undefined;
  }
  const cwd = foreignWorkingDirectory(args, worktreeRoot);
  return cwd === null ? command : `cd ${posixQuote(cwd)} && ${command}`;
}

function queryOf(
  payload: AgyHookPayload,
  worktreeRoot: string,
): PermissionQuery {
  const { name, args } = payload.toolCall;
  switch (TOOL_KIND_BY_NAME.get(name)) {
    case AgyToolKind.execute: {
      const command =
        name === AgyToolName.runCommand
          ? commandOf(args, worktreeRoot)
          : undefined;
      return command === undefined
        ? { kind: "execute" }
        : { kind: "execute", command };
    }
    case AgyToolKind.edit:
      return { kind: "edit", paths: pathsOf(args, worktreeRoot) };
    case AgyToolKind.read:
      return { kind: "read" };
    default:
      return { kind: "other" };
  }
}

function isInsideAgentsDir(path: string, worktreeRoot: string): boolean {
  const rel = relative(
    join(worktreeRoot, AGENTS_DIR_NAME).toLowerCase(),
    path.toLowerCase(),
  );
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function mentionsAgentsDir(text: string, nesting: number): boolean {
  if (AGENTS_DIR_COMMAND_PATTERN.test(text)) {
    return true;
  }
  if (nesting <= 0) {
    return false;
  }
  return parse(text).some(
    (entry) =>
      typeof entry === "string" && mentionsAgentsDir(entry, nesting - 1),
  );
}

function touchesAgentsDir(
  query: PermissionQuery,
  worktreeRoot: string,
): boolean {
  if (query.kind === "edit") {
    return (query.paths ?? []).some((path) =>
      isInsideAgentsDir(path, worktreeRoot),
    );
  }
  return (
    query.kind === "execute" &&
    query.command !== undefined &&
    mentionsAgentsDir(query.command, AGENTS_DIR_COMMAND_MAX_NESTING)
  );
}

export function decideAgyTool(
  payload: AgyHookPayload,
  profile: PermissionProfile,
  worktreeRoot: string,
): AgyHookDecision {
  if (
    profile !== PermissionProfile.bypass &&
    SUBAGENT_TOOL_NAMES.has(payload.toolCall.name)
  ) {
    return denyWith(HOOK_SUBAGENT_DENIED_REASON);
  }
  const query = queryOf(payload, worktreeRoot);
  if (
    profile !== PermissionProfile.bypass &&
    touchesAgentsDir(query, worktreeRoot)
  ) {
    return denyWith(HOOK_AGENTS_DIR_REASON);
  }
  const decision = decidePermission(query, profile, { worktreeRoot });
  switch (decision.action) {
    case "allow":
      return ALLOW;
    case "deny":
      return denyWith(decision.reason);
    case "ask":
      return denyWith(HOOK_NEEDS_APPROVAL_REASON);
  }
}
