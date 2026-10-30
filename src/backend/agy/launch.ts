import { FLAG_ENABLED } from "../constants";

import {
  AGY_DISABLE_AUTO_UPDATE_ENV,
  AgyFlag,
  EMPTY_PROMPT_ARG,
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
}

export interface AgyUsageLaunchInput {
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface AgyLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

function launchEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...env, [AGY_DISABLE_AUTO_UPDATE_ENV]: FLAG_ENABLED };
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
      EMPTY_PROMPT_ARG,
    ],
    env: launchEnv(input.env),
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
    ],
    env: launchEnv(input.env),
  };
}

export function agyTurnLine(text: string): string {
  return `${JSON.stringify({
    event: STDIN_USER_EVENT,
    message: { role: STDIN_USER_ROLE, content: text },
  })}\n`;
}
