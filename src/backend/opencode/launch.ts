import { join } from "node:path";

import { FLAG_ENABLED } from "../constants";
import {
  OPENCODE_ACCOUNT_DATA_DIR,
  OPENCODE_DATA_SUBDIR,
  OPENCODE_DB_FILE_NAME,
} from "../../shared/constants";
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
  OpencodeGeneration,
} from "./constants";

export interface OpencodeLaunchInput {
  readonly generation: OpencodeGeneration;
  readonly executable: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly password: string;
  readonly consoleLogin: boolean;
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

export function consoleLoginDbPath(configDir: string): string {
  return join(
    configDir,
    OPENCODE_ACCOUNT_DATA_DIR,
    OPENCODE_DATA_SUBDIR,
    OPENCODE_DB_FILE_NAME,
  );
}

function quoted(value: string): string {
  return `"${value}"`;
}

function passwordVariable(generation: OpencodeGeneration): string {
  return generation === OpencodeGeneration.v2
    ? OpencodeEnv.password
    : OpencodeEnv.serverPassword;
}

function launchArgs(input: OpencodeLaunchInput): string[] {
  const args = [
    SERVE_ARG,
    HOSTNAME_ARG,
    LOOPBACK_HOST,
    PORT_ARG,
    String(input.port),
  ];
  return input.generation === OpencodeGeneration.v2
    ? args
    : [...args, PURE_ARG];
}

export function isolationEnv(): Record<string, string> {
  return Object.fromEntries(
    OPENCODE_ISOLATION_FLAGS.map((flag) => [flag, FLAG_ENABLED]),
  );
}

function launchEnv(input: OpencodeLaunchInput): Record<string, string> {
  return {
    ...input.env,
    ...accountDirs(input.configDir),
    ...(input.consoleLogin
      ? { [OpencodeEnv.db]: consoleLoginDbPath(input.configDir) }
      : {}),
    [OpencodeEnv.config]: input.configFile,
    [passwordVariable(input.generation)]: input.password,
    ...isolationEnv(),
  };
}

export interface OpencodeCommandInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string | undefined;
}

export interface OpencodeCommand {
  readonly command: string;
  readonly args: string[];
  readonly windowsVerbatimArguments?: boolean;
}

export function buildOpencodeCommand(
  input: OpencodeCommandInput,
): OpencodeCommand {
  if (
    input.platform === WINDOWS_PLATFORM &&
    WINDOWS_SHIM_PATTERN.test(input.executable)
  ) {
    return {
      command: input.comSpec ?? WINDOWS_CMD_FALLBACK,
      args: [
        ...WINDOWS_CMD_ARGS,
        `"${quoted(input.executable)} ${input.args.join(" ")}"`,
      ],
      windowsVerbatimArguments: true,
    };
  }
  return { command: input.executable, args: [...input.args] };
}

export function buildOpencodeLaunch(
  input: OpencodeLaunchInput,
): OpencodeLaunch {
  return {
    ...buildOpencodeCommand({
      executable: input.executable,
      args: launchArgs(input),
      platform: input.platform,
      comSpec: input.comSpec,
    }),
    env: launchEnv(input),
  };
}
