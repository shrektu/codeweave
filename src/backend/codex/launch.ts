import type { AgentToolAccess } from "../agentAdapter";
import { CODEX_HOME_ENV } from "../constants";

import {
  APP_SERVER_ARG,
  CONFIG_OVERRIDE_FLAG,
  MCP_APPROVE_MODE,
  MCP_APPROVAL_MODE_KEY,
  MCP_BEARER_ENV_KEY,
  MCP_ENABLED_TOOLS_KEY,
  MCP_SERVERS_KEY,
  MCP_TOKEN_ENV,
  MCP_URL_KEY,
  TOML_BARE_KEY_PATTERN,
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
  readonly tools?: AgentToolAccess | undefined;
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return TOML_BARE_KEY_PATTERN.test(key) ? key : tomlString(key);
}

function toolOverrides(tools: AgentToolAccess): string[] {
  const prefix = `${MCP_SERVERS_KEY}.${tomlKey(tools.server)}`;
  return [
    `${prefix}.${MCP_URL_KEY}=${tomlString(tools.url)}`,
    `${prefix}.${MCP_BEARER_ENV_KEY}=${tomlString(MCP_TOKEN_ENV)}`,
    `${prefix}.${MCP_APPROVAL_MODE_KEY}=${tomlString(MCP_APPROVE_MODE)}`,
    `${prefix}.${MCP_ENABLED_TOOLS_KEY}=[${tools.toolNames
      .map(tomlString)
      .join(",")}]`,
  ];
}

function overrideArgs(tools: AgentToolAccess | undefined): string[] {
  if (tools === undefined) {
    return [];
  }
  return toolOverrides(tools).flatMap((override) => [
    CONFIG_OVERRIDE_FLAG,
    override,
  ]);
}

function windowsArg(value: string): string {
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return quoted(escaped);
}

export function buildCodexLaunch(input: CodexLaunchInput): CodexLaunch {
  const env = {
    ...input.env,
    [CODEX_HOME_ENV]: input.configDir,
    ...(input.tools === undefined
      ? {}
      : { [MCP_TOKEN_ENV]: input.tools.token }),
  };
  const overrides = overrideArgs(input.tools);
  if (
    input.platform === WINDOWS_PLATFORM &&
    WINDOWS_SHIM_PATTERN.test(input.executable)
  ) {
    const inner = [
      quoted(input.executable),
      ...overrides.map(windowsArg),
      APP_SERVER_ARG,
    ].join(" ");
    return {
      command: input.comSpec ?? WINDOWS_CMD_FALLBACK,
      args: [...WINDOWS_CMD_ARGS, quoted(inner)],
      env,
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: input.executable,
    args: [...overrides, APP_SERVER_ARG],
    env,
  };
}
