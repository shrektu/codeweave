import { describe, expect, it } from "vitest";

import {
  AgentEnvOverridesRejectedError,
  buildAgentEnv,
} from "../../src/backend/env";
import { ProviderId, type Account } from "../../src/domain/types";

const account: Account = {
  id: "acc-1",
  provider: ProviderId.claude,
  label: "Work",
  configDir: "/home/jane/.claude-work",
  order: 0,
};

const parent: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  ANTHROPIC_BASE_URL: "http://localhost:9",
  CLAUDE_CODE_SESSION_ID: "parent-session",
  HTTPS_PROXY: "http://proxy.corp:3128",
  SSL_CERT_FILE: "/etc/ssl/corp.pem",
};

const codexAccount: Account = {
  id: "acc-2",
  provider: ProviderId.codex,
  label: "Codex",
  configDir: "/home/jane/.codex-work",
  order: 1,
};

function build(
  overrides?: Readonly<Record<string, string>>,
  testMode = false,
  target: Account = account,
): Record<string, string> {
  return buildAgentEnv({
    parent,
    platform: "linux",
    homeDir: "/home/jane",
    account: target,
    executable: "/usr/local/bin/claude",
    runMarker: "run-7",
    testMode,
    ...(overrides === undefined ? {} : { overrides }),
  });
}

describe("agent env", () => {
  it("env_strips_provider_variables_keeps_proxy_and_certs", () => {
    const env = build();

    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SESSION_ID");
    expect(env.HTTPS_PROXY).toBe("http://proxy.corp:3128");
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/corp.pem");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/jane/.claude-work");
    expect(env.CODEWEAVE_RUN_ID).toBe("run-7");
  });

  it("claude_env_carries_claude_variables", () => {
    const env = build();

    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/usr/local/bin/claude");
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe("1");
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
  });

  it("codex_env_has_no_claude_variables", () => {
    const env = build(undefined, false, codexAccount);

    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXECUTABLE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_CRON");
    expect(env).not.toHaveProperty("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR");
    expect(env.CODEWEAVE_RUN_ID).toBe("run-7");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env.HTTPS_PROXY).toBe("http://proxy.corp:3128");
  });

  it("gemini_env_strips_agy_and_google_endpoint_variables", () => {
    const env = buildAgentEnv({
      parent: {
        PATH: "/usr/bin",
        AGY_CLI_DISABLE_AUTO_UPDATE: "0",
        agy_token: "t",
        ANTIGRAVITY_HOME: "/elsewhere",
        GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_GENAI_USE_ENTERPRISE: "true",
        GOOGLE_CLOUD_PROJECT: "keeps-project",
        HTTPS_PROXY: "http://proxy.corp:3128",
      },
      platform: "linux",
      homeDir: "/home/jane",
      account: { ...codexAccount, provider: ProviderId.gemini },
      executable: "/home/jane/.local/bin/agy",
      runMarker: "run-8",
      testMode: false,
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      GOOGLE_CLOUD_PROJECT: "keeps-project",
      HTTPS_PROXY: "http://proxy.corp:3128",
      CODEWEAVE_RUN_ID: "run-8",
    });
  });

  it("agent_env_overrides_rejected_outside_test_mode", () => {
    expect(() => build({ ANTHROPIC_BASE_URL: "http://fake" })).toThrow(
      AgentEnvOverridesRejectedError,
    );
    expect(build({ ANTHROPIC_BASE_URL: "http://fake" }, true)).toHaveProperty(
      "ANTHROPIC_BASE_URL",
      "http://fake",
    );
  });
});
