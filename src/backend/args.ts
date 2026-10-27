import { z } from "zod";

import { TEST_AGENT_ENV_ARG, USER_DATA_ARG } from "../shared/constants";

const TestAgentEnvSchema = z.record(z.string(), z.string());

export interface BackendArgs {
  userData: string;
  testAgentEnv: Readonly<Record<string, string>> | null;
}

function argValue(argv: readonly string[], flag: string): string | null {
  const prefix = `${flag}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match === undefined ? null : match.slice(prefix.length);
}

export function parseBackendArgs(argv: readonly string[]): BackendArgs {
  const userData = argValue(argv, USER_DATA_ARG);
  if (userData === null || userData === "") {
    throw new Error(`Missing backend argument ${USER_DATA_ARG} (user data)`);
  }
  const rawTestEnv = argValue(argv, TEST_AGENT_ENV_ARG);
  return {
    userData,
    testAgentEnv:
      rawTestEnv === null
        ? null
        : TestAgentEnvSchema.parse(JSON.parse(rawTestEnv)),
  };
}
