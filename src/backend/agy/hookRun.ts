import { isAbsolute } from "node:path";

import { z } from "zod";

import { PermissionProfile } from "../../domain/types";

import {
  AGY_PROFILE_ENV,
  AGY_SNAPSHOT_DIR_ENV,
  AGY_WORKTREE_ENV,
  AgyHookDecisionKind,
  AgyToolKind,
  HOOK_INTERNAL_ERROR_REASON,
  HOOK_INVALID_INPUT_REASON,
  HOOK_INVALID_PROFILE_REASON,
  TOOL_KIND_BY_NAME,
} from "./constants";
import {
  decideAgyTool,
  denyWith,
  pathsOf,
  type AgyHookDecision,
} from "./hookPolicy";
import { HookPayloadSchema, parseJson, type AgyHookPayload } from "./protocol";
import { writeStepSnapshot, type StepSnapshotRequest } from "./snapshots";

export interface HookRunDeps {
  readonly readInput: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write: (line: string) => void;
}

interface HookOutcome {
  readonly decision: AgyHookDecision;
  readonly payload: AgyHookPayload | null;
  readonly worktreeRoot: string;
}

const ProfileSchema = z.enum(PermissionProfile);

function rejected(reason: string): HookOutcome {
  return { decision: denyWith(reason), payload: null, worktreeRoot: "" };
}

async function decide(deps: HookRunDeps): Promise<HookOutcome> {
  const input = await deps.readInput();
  const profile = ProfileSchema.safeParse(deps.env[AGY_PROFILE_ENV]);
  const worktreeRoot = deps.env[AGY_WORKTREE_ENV];
  if (!profile.success || worktreeRoot === undefined || worktreeRoot === "") {
    return rejected(HOOK_INVALID_PROFILE_REASON);
  }
  const payload = HookPayloadSchema.safeParse(parseJson(input));
  return payload.success
    ? {
        decision: decideAgyTool(payload.data, profile.data, worktreeRoot),
        payload: payload.data,
        worktreeRoot,
      }
    : rejected(HOOK_INVALID_INPUT_REASON);
}

async function decideOrDeny(deps: HookRunDeps): Promise<HookOutcome> {
  try {
    return await decide(deps);
  } catch (error) {
    console.error("agy policy hook failed", error);
    return rejected(HOOK_INTERNAL_ERROR_REASON);
  }
}

function snapshotRequestOf(
  deps: HookRunDeps,
  outcome: HookOutcome,
): StepSnapshotRequest | null {
  const { payload, worktreeRoot } = outcome;
  const dir = deps.env[AGY_SNAPSHOT_DIR_ENV];
  if (
    payload === null ||
    outcome.decision.decision !== AgyHookDecisionKind.allow ||
    TOOL_KIND_BY_NAME.get(payload.toolCall.name) !== AgyToolKind.edit ||
    dir === undefined ||
    !isAbsolute(dir) ||
    payload.conversationId === undefined ||
    payload.stepIdx === undefined
  ) {
    return null;
  }
  return {
    dir,
    conversationId: payload.conversationId,
    stepIdx: payload.stepIdx,
    paths: pathsOf(payload.toolCall.args, worktreeRoot),
    worktreeRoot,
  };
}

async function recordBefore(
  deps: HookRunDeps,
  outcome: HookOutcome,
): Promise<void> {
  try {
    const request = snapshotRequestOf(deps, outcome);
    if (request !== null) {
      await writeStepSnapshot(request);
    }
  } catch (error) {
    console.error("agy diff snapshot failed", error);
  }
}

export async function runHook(deps: HookRunDeps): Promise<void> {
  const outcome = await decideOrDeny(deps);
  await recordBefore(deps, outcome);
  deps.write(`${JSON.stringify(outcome.decision)}\n`);
}
