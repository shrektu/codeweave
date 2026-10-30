import { join } from "node:path";

import { FLAG_ENABLED } from "../constants";
import {
  WINDOWS_CMD_ARGS,
  WINDOWS_CMD_FALLBACK,
  WINDOWS_PLATFORM,
  WINDOWS_SHIM_PATTERN,
} from "../codex/constants";

import {
  ACCOUNT_CACHE_DIR,
  ACCOUNT_CONFIG_DIR,
  ACCOUNT_DATA_DIR,
  ACCOUNT_HOME_DIR,
  ACCOUNT_STATE_DIR,
  HOSTNAME_ARG,
  LOOPBACK_HOST,
  OPENCODE_ISOLATION_FLAGS,
  OpencodeEnv,
  PORT_ARG,
  PURE_ARG,
  SERVE_ARG,
} from "./constants";

export interface OpencodeLaunchInput {
  readonly executable: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly password: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string | undefined;
}

export interface OpencodeLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly windowsVerbatimArguments?: boolean;
}

export function accountDirs(configDir: string): Record<string, string> {
  return {
    [OpencodeEnv.home]: join(configDir, ACCOUNT_HOME_DIR),
    [OpencodeEnv.configHome]: join(configDir, ACCOUNT_CONFIG_DIR),
    [OpencodeEnv.dataHome]: join(configDir, ACCOUNT_DATA_DIR),
    [OpencodeEnv.cacheHome]: join(configDir, ACCOUNT_CACHE_DIR),
    [OpencodeEnv.stateHome]: join(configDir, ACCOUNT_STATE_DIR),
  };
}

function quoted(value: string): string {
  return `"${value}"`;
}

function launchEnv(input: OpencodeLaunchInput): Record<string, string> {
  return {
    ...input.env,
    ...accountDirs(input.configDir),
    [OpencodeEnv.config]: input.configFile,
    [OpencodeEnv.serverPassword]: input.password,
    ...Object.fromEntries(
      OPENCODE_ISOLATION_FLAGS.map((flag) => [flag, FLAG_ENABLED]),
    ),
  };
}

export function buildOpencodeLaunch(
  input: OpencodeLaunchInput,
): OpencodeLaunch {
  const env = launchEnv(input);
  const args = [
    SERVE_ARG,
    HOSTNAME_ARG,
    LOOPBACK_HOST,
    PORT_ARG,
    String(input.port),
    PURE_ARG,
  ];
  if (
    input.platform === WINDOWS_PLATFORM &&
    WINDOWS_SHIM_PATTERN.test(input.executable)
  ) {
    return {
      command: input.comSpec ?? WINDOWS_CMD_FALLBACK,
      args: [
        ...WINDOWS_CMD_ARGS,
        `"${quoted(input.executable)} ${args.join(" ")}"`,
      ],
      env,
      windowsVerbatimArguments: true,
    };
  }
  return { command: input.executable, args, env };
}
