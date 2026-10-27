import { describe, expect, it } from "vitest";

import { ProviderId, type Account } from "../domain/types";

import { buildAgentEnv, type AgentEnvInput } from "./env";

const account: Account = {
  id: "acc-1",
  provider: ProviderId.claude,
  label: "Main",
  configDir: "/home/jane/.claude",
  order: 0,
};

function input(overrides: Partial<AgentEnvInput> = {}): AgentEnvInput {
  return {
    parent: { PATH: "/usr/bin" },
    platform: "linux",
    homeDir: "/home/jane",
    account,
    claudeExecutable: "/usr/bin/claude",
    runMarker: "run-1",
    testMode: false,
    ...overrides,
  };
}

describe("buildAgentEnv", () => {
  it("default_claude_dir_leaves_config_dir_unset", () => {
    const env = buildAgentEnv(input());

    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/usr/bin/claude");
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe("1");
  });

  it("denylist_is_case_insensitive_and_covers_prefixes", () => {
    const env = buildAgentEnv(
      input({
        parent: {
          Claude_Config_Dir: "/stale",
          claudecode: "1",
          OPENAI_API_KEY: "k",
          Gemini_Key: "k",
          CODEX_HOME: "/c",
          ELECTRON_RUN_AS_NODE: "1",
          GOOGLE_API_KEY: "k",
          node_options: "--inspect",
          ProgramData: "C:\\ProgramData",
          XDG_CONFIG_HOME: "/x",
          SHELL: "/bin/zsh",
        },
        account: { ...account, configDir: "/home/jane/.claude-work" },
      }),
    );

    expect(env).toEqual({
      ProgramData: "C:\\ProgramData",
      XDG_CONFIG_HOME: "/x",
      SHELL: "/bin/zsh",
      CLAUDE_CONFIG_DIR: "/home/jane/.claude-work",
      CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude",
      CLAUDE_CODE_DISABLE_CRON: "1",
      CODEWEAVE_RUN_ID: "run-1",
    });
  });

  it("windows_default_dir_comparison_ignores_case", () => {
    const env = buildAgentEnv(
      input({
        platform: "win32",
        homeDir: "C:\\Users\\Jane",
        account: { ...account, configDir: "c:\\users\\jane\\.CLAUDE" },
      }),
    );

    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("test_mode_overrides_win_over_computed_values", () => {
    const env = buildAgentEnv(
      input({
        testMode: true,
        overrides: {
          CODEWEAVE_RUN_ID: "forced",
          ANTHROPIC_BASE_URL: "http://f",
        },
      }),
    );

    expect(env.CODEWEAVE_RUN_ID).toBe("forced");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://f");
  });
});
