import { describe, expect, it } from "vitest";

import { ProviderId, type Account } from "../domain/types";

import { buildAgentEnv, inheritedEnv, type AgentEnvInput } from "./env";

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
    executable: "/usr/bin/claude",
    runMarker: "run-1",
    testMode: false,
    ...overrides,
  };
}

describe("inheritedEnv", () => {
  it("drops_provider_keys_and_agent_variables_but_keeps_the_rest", () => {
    const env = inheritedEnv({
      PATH: "/usr/bin",
      HOME: "/home/jane",
      ANTHROPIC_API_KEY: "sk-test-fake",
      claude_config_dir: "/home/jane/.claude",
      CODEX_HOME: "/home/jane/.codex",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
      EMPTY_BUT_DEFINED: "",
      UNSET: undefined,
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/jane",
      EMPTY_BUT_DEFINED: "",
    });
  });
});

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
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
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

  it.each([
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MISTRAL_API_KEY",
    "ZHIPU_API_KEY",
    "DEEPSEEK_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENCODE_API_KEY",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "opencode_permission",
  ])("parent_%s_never_reaches_an_agent", (name) => {
    const env = buildAgentEnv(
      input({ parent: { PATH: "/usr/bin", [name]: "secret-value" } }),
    );

    expect(env).not.toHaveProperty(name);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("env_sets_bash_maintain_project_dir", () => {
    const env = buildAgentEnv(
      input({
        parent: {
          PATH: "/usr/bin",
          CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "0",
        },
      }),
    );

    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
  });
});
