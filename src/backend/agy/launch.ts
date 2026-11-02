import { resolve } from "node:path";

import type { PermissionProfile } from "../../domain/types";

import {
  AGY_PROFILE_ENV,
  AGY_WORKTREE_ENV,
  AgyFlag,
  EMPTY_PROMPT_ARG,
  GEMINI_DIR_FLAG_PREFIX,
  OUTPUT_FORMAT_JSON,
  OUTPUT_FORMAT_STREAM_JSON,
  STDIN_USER_EVENT,
  STDIN_USER_ROLE,
  USAGE_COMMAND,
} from "./constants";
import type { AgyLaunchPermissions } from "./permissions";

export interface AgyLaunchInput {
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly permissions: AgyLaunchPermissions;
  readonly conversationId: string | null;
  readonly configDir: string;
  readonly profile: PermissionProfile;
  readonly worktreeRoot: string;
}

export interface AgyUsageLaunchInput {
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly configDir: string;
}

export interface AgyLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

function geminiDirArg(configDir: string): string {
  return `${GEMINI_DIR_FLAG_PREFIX}${resolve(configDir)}`;
}

export function buildAgyLaunch(input: AgyLaunchInput): AgyLaunch {
  const { settings, mode } = input.permissions;
  return {
    command: input.executable,
    args: [
      AgyFlag.inputFormat,
      OUTPUT_FORMAT_STREAM_JSON,
      AgyFlag.outputFormat,
      OUTPUT_FORMAT_STREAM_JSON,
      AgyFlag.settings,
      JSON.stringify(settings),
      ...(mode === null ? [] : [AgyFlag.mode, mode]),
      ...(input.conversationId === null
        ? []
        : [AgyFlag.conversation, input.conversationId]),
      geminiDirArg(input.configDir),
      EMPTY_PROMPT_ARG,
    ],
    env: {
      ...input.env,
      [AGY_PROFILE_ENV]: input.profile,
      [AGY_WORKTREE_ENV]: input.worktreeRoot,
    },
  };
}

export function buildAgyUsageLaunch(input: AgyUsageLaunchInput): AgyLaunch {
  return {
    command: input.executable,
    args: [
      AgyFlag.prompt,
      USAGE_COMMAND,
      AgyFlag.outputFormat,
      OUTPUT_FORMAT_JSON,
      geminiDirArg(input.configDir),
    ],
    env: { ...input.env },
  };
}

export function agyTurnLine(text: string): string {
  return `${JSON.stringify({
    event: STDIN_USER_EVENT,
    message: { role: STDIN_USER_ROLE, content: text },
  })}\n`;
}
