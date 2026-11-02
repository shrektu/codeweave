import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { posixQuote } from "./shellQuote";

const NASTY = "/tmp/a b'c\"d$e`f\\g";

describe("posixQuote", () => {
  it("hook_command_quotes_shell_metacharacters_wraps_plain_text", () => {
    expect(posixQuote("/opt/codeweave")).toBe("'/opt/codeweave'");
  });

  it("hook_command_quotes_shell_metacharacters_escapes_single_quotes", () => {
    expect(posixQuote("it's")).toBe("'it'\\''s'");
  });

  it.skipIf(process.platform === "win32")(
    "hook_command_quotes_shell_metacharacters_survives_sh",
    () => {
      const printed = execFileSync("sh", [
        "-c",
        `printf %s ${posixQuote(NASTY)}`,
      ]).toString();

      expect(printed).toBe(NASTY);
    },
  );
});
