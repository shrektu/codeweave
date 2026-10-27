import { describe, expect, it } from "vitest";

import { findExecCommands, shellScript } from "./commandParse";

describe("shellScript", () => {
  it("returns_the_first_operand_after_the_command_flag", () => {
    expect(shellScript(["-c", "ls -la"])).toBe("ls -la");
    expect(shellScript(["-lc", "ls"])).toBe("ls");
    expect(shellScript(["-e", "-u", "-c", "ls", "name", "arg"])).toBe("ls");
    expect(shellScript(["-o", "pipefail", "--login", "-c", "ls"])).toBe("ls");
    expect(shellScript(["--norc", "--noprofile", "-c", "ls"])).toBe("ls");
  });

  it("skips_option_words_and_end_of_options_after_the_command_flag", () => {
    expect(shellScript(["-c", "--", "sudo ls"])).toBe("sudo ls");
    expect(shellScript(["-c", "-", "rm -rf /"])).toBe("rm -rf /");
    expect(shellScript(["-c", "-e", "git push"])).toBe("git push");
    expect(shellScript(["-c", "--", "-x"])).toBe("-x");
  });

  it("rejects_anything_that_is_not_a_plain_command_invocation", () => {
    for (const args of [
      [],
      ["./deploy.sh", "-c", "ls"],
      ["-c"],
      ["-c", "--"],
      ["-s"],
      ["--", "-c", "ls"],
      ["--rcfile", "x", "-c", "ls"],
      ["+e", "-c", "ls"],
      ["-c", "+e", "ls"],
      ["-o"],
      ["-o", "-c", "ls"],
      ["-l"],
    ]) {
      expect(shellScript(args), args.join(" ")).toBeUndefined();
    }
  });
});

describe("findExecCommands", () => {
  it("returns_each_exec_command_up_to_its_terminator", () => {
    expect(
      findExecCommands([".", "-exec", "sudo", "ls", ";", "-name", "x"]),
    ).toEqual([["sudo", "ls"]]);
    expect(
      findExecCommands([
        ".",
        "-exec",
        "ls",
        "{}",
        "+",
        "-name",
        "x",
        "-execdir",
        "cat",
        ";",
        "-ok",
        "id",
      ]),
    ).toEqual([["ls", "{}"], ["cat"], ["id"]]);
  });

  it("find_plus_ends_exec_only_after_placeholder", () => {
    expect(
      findExecCommands([".", "-exec", "rm", "+", "-rf", "/home/u"]),
    ).toEqual([["rm", "+", "-rf", "/home/u"]]);
    expect(
      findExecCommands([".", "-exec", "git", "+", "push", "--force", "main"]),
    ).toEqual([["git", "+", "push", "--force", "main"]]);
    expect(
      findExecCommands([".", "-exec", "rm", "{}", "+", "-name", "x"]),
    ).toEqual([["rm", "{}"]]);
  });

  it("find_exec_flag_inside_exec_is_an_argument", () => {
    expect(
      findExecCommands([
        ".",
        "-name",
        "*.sh",
        "-exec",
        "rg",
        "-e",
        "",
        "-exec",
        "ls",
        "--pre=sh",
        "{}",
        "+",
      ]),
    ).toEqual([["rg", "-e", "", "-exec", "ls", "--pre=sh", "{}"]]);
    expect(
      findExecCommands([".", "-exec", "rg", "x", "-okdir", "ls", "{}", ";"]),
    ).toEqual([["rg", "x", "-okdir", "ls", "{}"]]);
    expect(
      findExecCommands([".", "-exec", "ls", ";", "-execdir", "cat", ";"]),
    ).toEqual([["ls"], ["cat"]]);
  });

  it("keeps_the_placeholder_opaque_and_returns_empty_commands", () => {
    expect(findExecCommands(["/etc", "-exec", "rm", "-rf", "{}/x"])).toEqual([
      ["rm", "-rf", "{}/x"],
    ]);
    expect(findExecCommands([".", "-exec", "{}", "x"])).toEqual([["{}", "x"]]);
    expect(findExecCommands([".", "-exec"])).toEqual([[]]);
    expect(findExecCommands([".", "-name", "x"])).toEqual([]);
  });
});
