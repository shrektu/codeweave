import { posix, win32 } from "node:path";

import type { Account } from "../domain/types";

import {
  CLAUDE_BASH_MAINTAIN_DIR_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_DISABLE_CRON_ENV,
  CLAUDE_EXECUTABLE_ENV,
  DEFAULT_CLAUDE_DIR_NAME,
  ENV_DENY_EXACT,
  ENV_DENY_PREFIXES,
  FLAG_ENABLED,
  RUN_ID_ENV,
} from "./constants";

export class AgentEnvOverridesRejectedError extends Error {
  constructor() {
    super("Environment overrides are only allowed in test mode");
    this.name = "AgentEnvOverridesRejectedError";
  }
}

export interface AgentEnvInput {
  readonly parent: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly account: Account;
  readonly claudeExecutable: string;
  readonly runMarker: string;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly testMode: boolean;
}

function isDenied(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    ENV_DENY_EXACT.includes(upper) ||
    ENV_DENY_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

function isDefaultConfigDir(input: AgentEnvInput): boolean {
  const pathApi = input.platform === "win32" ? win32 : posix;
  const normalize = (path: string): string => {
    const resolved = pathApi.resolve(path);
    return input.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return (
    normalize(input.account.configDir) ===
    normalize(pathApi.join(input.homeDir, DEFAULT_CLAUDE_DIR_NAME))
  );
}

export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  if (input.overrides !== undefined && !input.testMode) {
    throw new AgentEnvOverridesRejectedError();
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.parent)) {
    if (value !== undefined && !isDenied(key)) {
      env[key] = value;
    }
  }
  if (!isDefaultConfigDir(input)) {
    env[CLAUDE_CONFIG_DIR_ENV] = input.account.configDir;
  }
  env[CLAUDE_EXECUTABLE_ENV] = input.claudeExecutable;
  env[CLAUDE_DISABLE_CRON_ENV] = FLAG_ENABLED;
  env[CLAUDE_BASH_MAINTAIN_DIR_ENV] = FLAG_ENABLED;
  env[RUN_ID_ENV] = input.runMarker;
  return { ...env, ...input.overrides };
}
