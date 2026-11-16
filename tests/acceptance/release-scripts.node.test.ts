import { describe, expect, it } from "vitest";

import {
  builderInvocation,
  childEnvironment,
} from "../../scripts/release/builderInvocation";
import { releaseInfo } from "../../scripts/release/tagVersion";

const FAKE_AZURE_SECRET = "fake-azure-secret";
const FAKE_TENANT = "fake-tenant-id";
const FAKE_CSC_LINK = "fake-csc-link";
const FAKE_CSC_PASSWORD = "fake-csc-password";
const FAKE_APPLE_ID = "fake-apple-id@example.invalid";
const FAKE_APPLE_PASSWORD = "fake-apple-password";
const FAKE_APPLE_TEAM = "FAKETEAM01";

const FULL_AZURE_ENV = {
  AZURE_TENANT_ID: FAKE_TENANT,
  AZURE_CLIENT_ID: "fake-client-id",
  AZURE_CLIENT_SECRET: FAKE_AZURE_SECRET,
  AZURE_SIGNING_ENDPOINT: "https://fake.codesigning.invalid",
  AZURE_SIGNING_ACCOUNT: "fake-account",
  AZURE_SIGNING_PROFILE: "fake-profile",
  AZURE_SIGNING_PUBLISHER: "CN=Fake Publisher",
};

const FULL_MAC_ENV = {
  CSC_LINK: FAKE_CSC_LINK,
  CSC_KEY_PASSWORD: FAKE_CSC_PASSWORD,
  APPLE_ID: FAKE_APPLE_ID,
  APPLE_APP_SPECIFIC_PASSWORD: FAKE_APPLE_PASSWORD,
  APPLE_TEAM_ID: FAKE_APPLE_TEAM,
};

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

describe("releaseInfo", () => {
  it("accepts_a_tag_matching_the_package_version", () => {
    expect(releaseInfo("v1.2.3", "1.2.3")).toEqual({
      version: "1.2.3",
      prerelease: false,
    });
  });

  it("marks_a_version_with_a_dash_suffix_as_prerelease", () => {
    expect(releaseInfo("v0.2.0-beta.1", "0.2.0-beta.1")).toEqual({
      version: "0.2.0-beta.1",
      prerelease: true,
    });
  });

  it("build_metadata_containing_a_hyphen_is_not_a_prerelease", () => {
    expect(releaseInfo("v1.2.3+build-1", "1.2.3+build-1").prerelease).toBe(
      false,
    );
    expect(
      releaseInfo("v1.2.3-rc.1+build-1", "1.2.3-rc.1+build-1").prerelease,
    ).toBe(true);
  });

  it("rejects_tag_with_v_less_or_different_version", () => {
    expect(() => releaseInfo("1.2.3", "1.2.3")).toThrow("1.2.3");
    expect(() => releaseInfo("v1.2.4", "1.2.3")).toThrow("v1.2.4");
    expect(() => releaseInfo("v1.2.3", "1.2.3-beta.1")).toThrow("v1.2.3");
  });

  it("rejects_a_version_that_is_not_semver", () => {
    expect(() => releaseInfo("v1.2", "1.2")).toThrow("1.2");
    expect(() => releaseInfo("vlatest", "latest")).toThrow("latest");
  });
});

describe("builderInvocation linux", () => {
  it("builds_for_the_runner_architecture_without_publishing", () => {
    expect(builderInvocation("linux", { RUNNER_ARCH: "X64" })).toEqual({
      args: ["--linux", "--publish", "never", "--x64"],
      env: {},
      signed: false,
      warnings: [],
    });
    expect(builderInvocation("linux", { RUNNER_ARCH: "ARM64" }).args).toEqual([
      "--linux",
      "--publish",
      "never",
      "--arm64",
    ]);
  });

  it("leaves_the_architecture_to_electron_builder_when_the_runner_is_unknown", () => {
    expect(builderInvocation("linux", {}).args).toEqual([
      "--linux",
      "--publish",
      "never",
    ]);
  });

  it("rejects_an_unsupported_runner_architecture", () => {
    expect(() => builderInvocation("linux", { RUNNER_ARCH: "ARM" })).toThrow(
      "ARM",
    );
  });
});

describe("builderInvocation windows", () => {
  it("builds_unsigned_when_no_azure_variable_is_set", () => {
    expect(builderInvocation("windows", {})).toEqual({
      args: ["--win", "--x64", "--arm64", "--publish", "never"],
      env: {},
      signed: false,
      warnings: [],
    });
  });

  it("fork_pull_request_with_variables_but_no_secrets_builds_unsigned_with_a_warning", () => {
    const result = builderInvocation("windows", {
      AZURE_SIGNING_ENDPOINT: FULL_AZURE_ENV.AZURE_SIGNING_ENDPOINT,
      AZURE_SIGNING_ACCOUNT: FULL_AZURE_ENV.AZURE_SIGNING_ACCOUNT,
      AZURE_SIGNING_PROFILE: "",
    });

    expect(result.signed).toBe(false);
    expect(result.args).toEqual([
      "--win",
      "--x64",
      "--arm64",
      "--publish",
      "never",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("AZURE_SIGNING_ENDPOINT");
    expect(result.warnings[0]).toContain("AZURE_SIGNING_ACCOUNT");
    expect(result.warnings[0]).not.toContain("AZURE_SIGNING_PROFILE");
    expect(result.warnings[0]).not.toContain(
      FULL_AZURE_ENV.AZURE_SIGNING_ENDPOINT,
    );
  });

  it("all_azure_secrets_with_missing_variables_throw_naming_the_variables", () => {
    const message = thrownMessage(() =>
      builderInvocation("windows", {
        AZURE_TENANT_ID: FAKE_TENANT,
        AZURE_CLIENT_ID: "fake-client-id",
        AZURE_CLIENT_SECRET: FAKE_AZURE_SECRET,
        AZURE_SIGNING_ACCOUNT: "fake-account",
      }),
    );

    for (const missing of [
      "AZURE_SIGNING_ENDPOINT",
      "AZURE_SIGNING_PROFILE",
      "AZURE_SIGNING_PUBLISHER",
    ]) {
      expect(message).toContain(missing);
    }
    expect(message).not.toContain("AZURE_SIGNING_ACCOUNT");
    expect(message).not.toContain(FAKE_AZURE_SECRET);
  });

  it("treats_empty_azure_variables_as_unset", () => {
    const empty = Object.fromEntries(
      Object.keys(FULL_AZURE_ENV).map((name) => [name, ""]),
    );

    expect(builderInvocation("windows", empty).signed).toBe(false);
  });

  it("signs_with_azure_trusted_signing_when_every_variable_is_set", () => {
    expect(builderInvocation("windows", FULL_AZURE_ENV)).toEqual({
      args: [
        "--win",
        "--x64",
        "--arm64",
        "--publish",
        "never",
        "-c.win.azureSignOptions.endpoint=https://fake.codesigning.invalid",
        "-c.win.azureSignOptions.codeSigningAccountName=fake-account",
        "-c.win.azureSignOptions.certificateProfileName=fake-profile",
        "-c.win.azureSignOptions.publisherName=CN=Fake Publisher",
      ],
      env: {
        AZURE_TENANT_ID: FAKE_TENANT,
        AZURE_CLIENT_ID: "fake-client-id",
        AZURE_CLIENT_SECRET: FAKE_AZURE_SECRET,
      },
      signed: true,
      warnings: [],
    });
  });

  it("partial_azure_variables_throw_naming_only_variable_names", () => {
    const message = thrownMessage(() =>
      builderInvocation("windows", {
        AZURE_TENANT_ID: FAKE_TENANT,
        AZURE_CLIENT_SECRET: FAKE_AZURE_SECRET,
        AZURE_SIGNING_ENDPOINT: "",
      }),
    );

    for (const missing of [
      "AZURE_CLIENT_ID",
      "AZURE_SIGNING_ENDPOINT",
      "AZURE_SIGNING_ACCOUNT",
      "AZURE_SIGNING_PROFILE",
      "AZURE_SIGNING_PUBLISHER",
    ]) {
      expect(message).toContain(missing);
    }
    expect(message).not.toContain("AZURE_TENANT_ID");
    expect(message).not.toContain(FAKE_AZURE_SECRET);
    expect(message).not.toContain(FAKE_TENANT);
  });
});

describe("builderInvocation mac", () => {
  it("builds_unsigned_and_skips_notarization_without_a_certificate", () => {
    const expected = {
      args: [
        "--mac",
        "--x64",
        "--arm64",
        "--publish",
        "never",
        "-c.mac.identity=-",
        "-c.mac.notarize=false",
      ],
      env: {
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        CSC_FOR_PULL_REQUEST: "true",
      },
      signed: false,
      warnings: [],
    };

    expect(builderInvocation("mac", {})).toEqual(expected);
    expect(builderInvocation("mac", { CSC_LINK: "" })).toEqual(expected);
  });

  it("unsigned_mac_build_is_ad_hoc_signed_so_apple_silicon_does_not_report_it_damaged", () => {
    const { args, env } = builderInvocation("mac", {});

    expect(args).toContain("-c.mac.identity=-");
    expect(env.CSC_FOR_PULL_REQUEST).toBe("true");
  });

  it("mac_without_a_certificate_is_unsigned_whatever_the_apple_credentials_say", () => {
    const result = builderInvocation("mac", {
      APPLE_ID: FAKE_APPLE_ID,
      APPLE_TEAM_ID: FAKE_APPLE_TEAM,
    });

    expect(result.signed).toBe(false);
    expect(result.args).toContain("-c.mac.notarize=false");
    expect(result.env).not.toHaveProperty("APPLE_ID");
  });

  it("signs_and_passes_notarization_credentials_through_when_all_are_set", () => {
    expect(builderInvocation("mac", FULL_MAC_ENV)).toEqual({
      args: ["--mac", "--x64", "--arm64", "--publish", "never"],
      env: FULL_MAC_ENV,
      signed: true,
      warnings: [],
    });
  });

  it("signs_without_notarizing_when_no_apple_credential_is_set", () => {
    expect(
      builderInvocation("mac", {
        CSC_LINK: FAKE_CSC_LINK,
        CSC_KEY_PASSWORD: FAKE_CSC_PASSWORD,
      }),
    ).toEqual({
      args: ["--mac", "--x64", "--arm64", "--publish", "never"],
      env: { CSC_LINK: FAKE_CSC_LINK, CSC_KEY_PASSWORD: FAKE_CSC_PASSWORD },
      signed: true,
      warnings: [],
    });
  });

  it("partial_notarization_credentials_throw_naming_only_variable_names", () => {
    const message = thrownMessage(() =>
      builderInvocation("mac", {
        CSC_LINK: FAKE_CSC_LINK,
        CSC_KEY_PASSWORD: FAKE_CSC_PASSWORD,
        APPLE_ID: FAKE_APPLE_ID,
      }),
    );

    expect(message).toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(message).toContain("APPLE_TEAM_ID");
    expect(message).not.toContain("APPLE_ID");
    for (const secret of [FAKE_APPLE_ID, FAKE_CSC_LINK, FAKE_CSC_PASSWORD]) {
      expect(message).not.toContain(secret);
    }
  });
});

describe("childEnvironment", () => {
  it("empty_signing_secrets_from_the_workflow_do_not_reach_electron_builder", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: undefined,
      CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
    };

    expect(childEnvironment(env, builderInvocation("mac", env))).toEqual({
      PATH: "/usr/bin",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_FOR_PULL_REQUEST: "true",
    });
  });

  it("signed_mac_child_environment_keeps_the_certificate_and_notarization_credentials", () => {
    const env = { PATH: "/usr/bin", ...FULL_MAC_ENV };

    expect(childEnvironment(env, builderInvocation("mac", env))).toEqual({
      PATH: "/usr/bin",
      ...FULL_MAC_ENV,
    });
  });

  it("empty_azure_secrets_do_not_reach_electron_builder", () => {
    const env = {
      PATH: "/usr/bin",
      AZURE_TENANT_ID: "",
      AZURE_CLIENT_ID: "",
      AZURE_CLIENT_SECRET: "",
      AZURE_SIGNING_ENDPOINT: "",
    };

    expect(childEnvironment(env, builderInvocation("windows", env))).toEqual({
      PATH: "/usr/bin",
      AZURE_SIGNING_ENDPOINT: "",
    });
  });

  it("workflow_env_with_absent_secrets_builds_an_unsigned_mac_child_env", () => {
    const env = {
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
    const invocation = builderInvocation("mac", env);
    const child = childEnvironment(env, invocation);

    expect(invocation.signed).toBe(false);
    expect(child).toEqual({
      PATH: "/usr/bin",
      RUNNER_ARCH: "ARM64",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_FOR_PULL_REQUEST: "true",
    });
    expect(child).not.toHaveProperty("CSC_LINK");
  });
});
