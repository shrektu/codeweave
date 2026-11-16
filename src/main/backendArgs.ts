import { TEST_AGENT_ENV_ARG, USER_DATA_ARG } from "../shared/constants";

export const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";

export const TEST_UPDATE_FEED_ENV_VAR = "CODEWEAVE_TEST_UPDATE_FEED";

export interface BackendArgsInput {
  userData: string;
  isPackaged: boolean;
  testAgentEnv: string | undefined;
}

export function buildBackendArgs({
  userData,
  isPackaged,
  testAgentEnv,
}: BackendArgsInput): string[] {
  const args = [`${USER_DATA_ARG}=${userData}`];
  if (!isPackaged && testAgentEnv !== undefined) {
    args.push(`${TEST_AGENT_ENV_ARG}=${testAgentEnv}`);
  }
  return args;
}
