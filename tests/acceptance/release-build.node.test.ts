import { describe, expect, it } from "vitest";

import { build } from "../../scripts/release/build";

interface RecordedRun {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

const WORKFLOW_ENV = {
  PATH: "/usr/bin",
  RUNNER_ARCH: "ARM64",
  CSC_LINK: "",
  CSC_KEY_PASSWORD: "",
  APPLE_ID: "",
  APPLE_APP_SPECIFIC_PASSWORD: "",
  APPLE_TEAM_ID: "",
  AZURE_TENANT_ID: "",
  AZURE_CLIENT_ID: "",
  AZURE_CLIENT_SECRET: "",
};

describe("release build", () => {
  it("unsigned_mac_build_does_not_pass_empty_signing_secrets_to_electron_builder", () => {
    const runs: RecordedRun[] = [];

    const exitCode = build("mac", [], {
      env: WORKFLOW_ENV,
      run: (_command, args, env) => {
        runs.push({ args, env });
      },
      verify: () => 0,
    });

    expect(exitCode).toBe(0);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.args).toContain("-c.mac.identity=-");
    expect(run?.env).toEqual({
      PATH: "/usr/bin",
      RUNNER_ARCH: "ARM64",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_FOR_PULL_REQUEST: "true",
    });
  });
});
