import { expect, it } from "vitest";

import { loginCommands } from "./loginCommand";

it("login_command_wraps_plain_path", () => {
  expect(loginCommands("/home/user/.claude-work")).toEqual({
    bash: "CLAUDE_CONFIG_DIR='/home/user/.claude-work' claude",
    powershell: "$env:CLAUDE_CONFIG_DIR='/home/user/.claude-work'; claude",
  });
});

it("login_command_quotes_special_paths", () => {
  expect(loginCommands("/home/us er/it's")).toEqual({
    bash: "CLAUDE_CONFIG_DIR='/home/us er/it'\\''s' claude",
    powershell: "$env:CLAUDE_CONFIG_DIR='/home/us er/it''s'; claude",
  });
  expect(loginCommands("C:\\Users\\O'Neil's dir\\.claude")).toEqual({
    bash: "CLAUDE_CONFIG_DIR='C:\\Users\\O'\\''Neil'\\''s dir\\.claude' claude",
    powershell:
      "$env:CLAUDE_CONFIG_DIR='C:\\Users\\O''Neil''s dir\\.claude'; claude",
  });
});

it.each(["'", "\u2018", "\u2019", "\u201A", "\u201B"])(
  "powershell_command_escapes_typographic_quotes_%#",
  (quote) => {
    expect(loginCommands(`C:\\Users\\Ann${quote}s\\x`).powershell).toBe(
      `$env:CLAUDE_CONFIG_DIR='C:\\Users\\Ann${quote}${quote}s\\x'; claude`,
    );
  },
);

it("powershell_command_keeps_injection_attempt_inside_literal", () => {
  expect(loginCommands("x\u2019; calc; \u2019").powershell).toBe(
    "$env:CLAUDE_CONFIG_DIR='x\u2019\u2019; calc; \u2019\u2019'; claude",
  );
});
