import { describe, expect, it } from "vitest";

import { parseBackendArgs } from "./args";

const USER_DATA_FLAG = "--codeweave-user-data=/data";
const TEST_ENV_FLAG = "--codeweave-test-agent-env=";

describe("parseBackendArgs", () => {
  it("ignores_unrelated_arguments", () => {
    const args = parseBackendArgs(["node", "backend.js", USER_DATA_FLAG]);

    expect(args).toEqual({ userData: "/data", testAgentEnv: null });
  });

  it("keeps_equals_signs_inside_the_user_data_path", () => {
    const args = parseBackendArgs(["--codeweave-user-data=/a=b"]);

    expect(args.userData).toBe("/a=b");
  });

  it("rejects_an_empty_user_data_value", () => {
    expect(() => parseBackendArgs(["--codeweave-user-data="])).toThrow(
      /user data/,
    );
  });

  it("rejects_test_env_that_is_not_json", () => {
    expect(() =>
      parseBackendArgs([USER_DATA_FLAG, `${TEST_ENV_FLAG}{x`]),
    ).toThrow(SyntaxError);
  });

  it.each([
    ["a non-string value", '{"A":1}'],
    ["an array", '["A"]'],
    ["null", "null"],
  ])("rejects_test_env_with_%s", (_label, json) => {
    expect(() =>
      parseBackendArgs([USER_DATA_FLAG, `${TEST_ENV_FLAG}${json}`]),
    ).toThrow();
  });

  it("accepts_an_empty_test_env_object", () => {
    const args = parseBackendArgs([USER_DATA_FLAG, `${TEST_ENV_FLAG}{}`]);

    expect(args.testAgentEnv).toEqual({});
  });
});
