import { CODEX_HOME_ENV } from "../constants";

import {
  APP_SERVER_ARG,
  WINDOWS_CMD_ARGS,
  WINDOWS_CMD_FALLBACK,
  WINDOWS_PLATFORM,
  WINDOWS_SHIM_PATTERN,
} from "./constants";

export interface CodexLaunchInput {
  readonly executable: string;
  readonly configDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string | undefined;
}

export interface CodexLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly windowsVerbatimArguments?: boolean;
}

function quoted(value: string): string {
  return `"${value}"`;
}

export function buildCodexLaunch(input: CodexLaunchInput): CodexLaunch {
  const env = { ...input.env, [CODEX_HOME_ENV]: input.configDir };
  if (
    input.platform === WINDOWS_PLATFORM &&
    WINDOWS_SHIM_PATTERN.test(input.executable)
  ) {
    return {
      command: input.comSpec ?? WINDOWS_CMD_FALLBACK,
      args: [
        ...WINDOWS_CMD_ARGS,
        `"${quoted(input.executable)} ${APP_SERVER_ARG}"`,
      ],
      env,
      windowsVerbatimArguments: true,
    };
  }
  return { command: input.executable, args: [APP_SERVER_ARG], env };
}
