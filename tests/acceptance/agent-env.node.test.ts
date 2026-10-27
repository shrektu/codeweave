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

function build(
  overrides?: Readonly<Record<string, string>>,
  testMode = false,
): Record<string, string> {
  return buildAgentEnv({
    parent,
    platform: "linux",
    homeDir: "/home/jane",
    account,
    claudeExecutable: "/usr/local/bin/claude",
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
