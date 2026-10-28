import { describe, expect, it } from "vitest";

import { resolveExecutable } from "./executable";

function filesystem(...files: string[]): (path: string) => boolean {
  return (path) => files.includes(path);
}

describe("resolveExecutable", () => {
  it("executable_resolves_cmd_shim_with_spaces", () => {
    const shim = String.raw`C:\Users\Jane Doe\AppData\Roaming\npm\claude.CMD`;

    expect(
      resolveExecutable("claude", {
        pathEnv: String.raw`C:\Program Files\nodejs;C:\Users\Jane Doe\AppData\Roaming\npm`,
        pathExt: ".COM;.EXE;.BAT;.CMD",
        platform: "win32",
        isFile: filesystem(shim),
      }),
    ).toBe(shim);
  });

  it("windows_prefers_earlier_pathext_and_defaults_when_unset", () => {
    const exe = String.raw`C:\bin\tool.EXE`;
    const cmd = String.raw`C:\bin\tool.CMD`;

    expect(
      resolveExecutable("tool", {
        pathEnv: String.raw`C:\bin`,
        pathExt: undefined,
        platform: "win32",
        isFile: filesystem(cmd, exe),
      }),
    ).toBe(exe);
  });

  it("windows_name_with_known_extension_is_tried_as_is", () => {
    const direct = String.raw`C:\bin\claude.exe`;

    expect(
      resolveExecutable("claude.exe", {
        pathEnv: String.raw`C:\bin`,
        pathExt: ".EXE;.CMD",
        platform: "win32",
        isFile: filesystem(direct),
      }),
    ).toBe(direct);
  });
});

describe("resolveExecutable without windows", () => {
  it("posix_uses_colon_path_and_no_extensions", () => {
    expect(
      resolveExecutable("claude", {
        pathEnv: "/usr/local/bin:/home/jane/.local/bin",
        pathExt: ".EXE",
        platform: "linux",
        isFile: filesystem(
          "/home/jane/.local/bin/claude",
          "/usr/local/bin/claude.EXE",
        ),
      }),
    ).toBe("/home/jane/.local/bin/claude");
  });

  it("missing_executable_resolves_to_null", () => {
    expect(
      resolveExecutable("claude", {
        pathEnv: "/usr/bin:",
        pathExt: undefined,
        platform: "darwin",
        isFile: filesystem(),
      }),
    ).toBeNull();
  });

  it("absolute_name_is_checked_without_searching_path", () => {
    expect(
      resolveExecutable("/opt/claude", {
        pathEnv: "/usr/bin",
        pathExt: undefined,
        platform: "linux",
        isFile: filesystem("/opt/claude", "/usr/bin//opt/claude"),
      }),
    ).toBe("/opt/claude");
  });
});
