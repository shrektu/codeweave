import { expect, it } from "vitest";

import { parseBackendArgs } from "../../src/backend/args";
import { buildBackendArgs } from "../../src/main/backendArgs";

const USER_DATA = "/home/jane/.config/codeweave";
const TEST_ENV_JSON = '{"CLAUDE_CODE_EXECUTABLE":"/opt/fake-claude"}';

it("backend_args_test_env_only_when_unpackaged", () => {
  const unpacked = buildBackendArgs({
    userData: USER_DATA,
    isPackaged: false,
    testAgentEnv: TEST_ENV_JSON,
  });
  const packaged = buildBackendArgs({
    userData: USER_DATA,
    isPackaged: true,
    testAgentEnv: TEST_ENV_JSON,
  });
  const unset = buildBackendArgs({
    userData: USER_DATA,
    isPackaged: false,
    testAgentEnv: undefined,
  });

  expect(parseBackendArgs(unpacked)).toEqual({
    userData: USER_DATA,
    testAgentEnv: { CLAUDE_CODE_EXECUTABLE: "/opt/fake-claude" },
  });
  expect(parseBackendArgs(packaged)).toEqual({
    userData: USER_DATA,
    testAgentEnv: null,
  });
  expect(parseBackendArgs(unset)).toEqual({
    userData: USER_DATA,
    testAgentEnv: null,
  });
});

it("backend_args_require_user_data", () => {
  expect(() => parseBackendArgs([])).toThrow(/user data/i);
});
