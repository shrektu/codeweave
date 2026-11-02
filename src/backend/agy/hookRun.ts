import { z } from "zod";

import { PermissionProfile } from "../../domain/types";

import {
  AGY_PROFILE_ENV,
  AGY_WORKTREE_ENV,
  HOOK_INTERNAL_ERROR_REASON,
  HOOK_INVALID_INPUT_REASON,
  HOOK_INVALID_PROFILE_REASON,
} from "./constants";
import { decideAgyTool, denyWith, type AgyHookDecision } from "./hookPolicy";
import { HookPayloadSchema, parseJson } from "./protocol";

export interface HookRunDeps {
  readonly readInput: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write: (line: string) => void;
}

const ProfileSchema = z.enum(PermissionProfile);

async function decide(deps: HookRunDeps): Promise<AgyHookDecision> {
  const input = await deps.readInput();
  const profile = ProfileSchema.safeParse(deps.env[AGY_PROFILE_ENV]);
  const worktreeRoot = deps.env[AGY_WORKTREE_ENV];
  if (!profile.success || worktreeRoot === undefined || worktreeRoot === "") {
    return denyWith(HOOK_INVALID_PROFILE_REASON);
  }
  const payload = HookPayloadSchema.safeParse(parseJson(input));
  return payload.success
    ? decideAgyTool(payload.data, profile.data, worktreeRoot)
    : denyWith(HOOK_INVALID_INPUT_REASON);
}

async function decideOrDeny(deps: HookRunDeps): Promise<AgyHookDecision> {
  try {
    return await decide(deps);
  } catch (error) {
    console.error("agy policy hook failed", error);
    return denyWith(HOOK_INTERNAL_ERROR_REASON);
  }
}

export async function runHook(deps: HookRunDeps): Promise<void> {
  deps.write(`${JSON.stringify(await decideOrDeny(deps))}\n`);
}
