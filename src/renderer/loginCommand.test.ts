import { expect, it } from "vitest";

import { loginCommands } from "./loginCommand";

it("login_command_wraps_plain_path", () => {
  expect(loginCommands("claude", "/home/user/.claude-work")).toEqual({
    bash: "CLAUDE_CONFIG_DIR='/home/user/.claude-work' claude",
    powershell: "$env:CLAUDE_CONFIG_DIR='/home/user/.claude-work'; claude",
    hint: "Run this in a terminal, then type /login:",
  });
});

it("codex_login_command_wraps_plain_path", () => {
  expect(loginCommands("codex", "/home/user/.codex-work")).toEqual({
    bash: "CODEX_HOME='/home/user/.codex-work' codex login",
    powershell: "$env:CODEX_HOME='/home/user/.codex-work'; codex login",
    hint: "Run this in a terminal:",
  });
});

it("gemini_login_command_is_plain_agy_for_any_path", () => {
  const expected = {
    bash: "agy",
    powershell: "agy",
    hint: "Run this in a terminal, then sign in with Google:",
  };

  expect(loginCommands("gemini", "/home/user/accounts/g1")).toEqual(expected);
  expect(loginCommands("gemini", "/home/us er/it's")).toEqual(expected);
});

it("login_command_is_absent_for_unsupported_provider", () => {
  expect(loginCommands("opencode", "/home/user/.opencode")).toBeNull();
});

it("login_command_quotes_special_paths", () => {
  expect(loginCommands("claude", "/home/us er/it's")).toMatchObject({
    bash: "CLAUDE_CONFIG_DIR='/home/us er/it'\\''s' claude",
    powershell: "$env:CLAUDE_CONFIG_DIR='/home/us er/it''s'; claude",
  });
  expect(
    loginCommands("claude", "C:\\Users\\O'Neil's dir\\.claude"),
  ).toMatchObject({
    bash: "CLAUDE_CONFIG_DIR='C:\\Users\\O'\\''Neil'\\''s dir\\.claude' claude",
    powershell:
      "$env:CLAUDE_CONFIG_DIR='C:\\Users\\O''Neil''s dir\\.claude'; claude",
  });
});

it("codex_login_command_quotes_special_paths", () => {
  expect(loginCommands("codex", "/home/us er/it's")).toMatchObject({
    bash: "CODEX_HOME='/home/us er/it'\\''s' codex login",
    powershell: "$env:CODEX_HOME='/home/us er/it''s'; codex login",
  });
});

it.each(["'", "\u2018", "\u2019", "\u201A", "\u201B"])(
  "powershell_command_escapes_typographic_quotes_%#",
  (quote) => {
    const dir = `C:\\Users\\Ann${quote}s\\x`;
    const doubled = `C:\\Users\\Ann${quote}${quote}s\\x`;
    expect(loginCommands("claude", dir)?.powershell).toBe(
      `$env:CLAUDE_CONFIG_DIR='${doubled}'; claude`,
    );
    expect(loginCommands("codex", dir)?.powershell).toBe(
      `$env:CODEX_HOME='${doubled}'; codex login`,
    );
  },
);

it("powershell_command_keeps_injection_attempt_inside_literal", () => {
  expect(loginCommands("claude", "x\u2019; calc; \u2019")?.powershell).toBe(
    "$env:CLAUDE_CONFIG_DIR='x\u2019\u2019; calc; \u2019\u2019'; claude",
  );
});
