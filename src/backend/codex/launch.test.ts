import { describe, expect, it } from "vitest";

import { buildCodexLaunch } from "./launch";

const BASE = {
  configDir: "/home/jane/.codex-main",
  env: { PATH: "/usr/bin", CODEX_HOME: "/stale" },
};

describe("buildCodexLaunch", () => {
  it("posix_runs_the_executable_directly_with_codex_home", () => {
    expect(
      buildCodexLaunch({
        ...BASE,
        executable: "/usr/local/bin/codex",
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/codex",
      args: ["app-server"],
      env: { PATH: "/usr/bin", CODEX_HOME: "/home/jane/.codex-main" },
    });
  });

  it("windows_shim_path_with_special_chars_survives_cmd_quoting", () => {
    const launch = buildCodexLaunch({
      ...BASE,
      executable: "C:\\Program Files (x86)\\nodejs\\codex.cmd",
      platform: "win32",
    });

    expect(launch.windowsVerbatimArguments).toBe(true);
    expect([launch.command, ...launch.args].join(" ")).toBe(
      'cmd.exe /d /s /c ""C:\\Program Files (x86)\\nodejs\\codex.cmd" app-server"',
    );
  });

  it("non_shim_and_posix_launches_carry_no_verbatim_flag", () => {
    const exe = buildCodexLaunch({
      ...BASE,
      executable: "C:\\codex\\codex.exe",
      platform: "win32",
    });
    const posix = buildCodexLaunch({
      ...BASE,
      executable: "/usr/bin/codex",
      platform: "linux",
    });

    expect(exe).not.toHaveProperty("windowsVerbatimArguments");
    expect(posix).not.toHaveProperty("windowsVerbatimArguments");
  });

  it("windows_cmd_shim_uses_comspec_with_one_quoted_command", () => {
    const launch = buildCodexLaunch({
      ...BASE,
      executable: "C:\\Users\\Jane\\AppData\\npm\\codex.CMD",
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Users\\Jane\\AppData\\npm\\codex.CMD" app-server"',
    ]);
  });

  it("windows_bat_without_comspec_falls_back_to_cmd_exe", () => {
    const launch = buildCodexLaunch({
      ...BASE,
      executable: "D:\\tools\\codex.bat",
      platform: "win32",
    });

    expect(launch.command).toBe("cmd.exe");
    expect(launch.args.at(-1)).toBe('""D:\\tools\\codex.bat" app-server"');
  });

  it("windows_exe_runs_directly", () => {
    expect(
      buildCodexLaunch({
        ...BASE,
        executable: "C:\\codex\\codex.exe",
        platform: "win32",
        comSpec: "cmd.exe",
      }),
    ).toMatchObject({ command: "C:\\codex\\codex.exe", args: ["app-server"] });
  });

  it("cmd_suffix_on_posix_is_not_wrapped", () => {
    expect(
      buildCodexLaunch({
        ...BASE,
        executable: "/opt/codex.cmd",
        platform: "linux",
        comSpec: "cmd.exe",
      }).command,
    ).toBe("/opt/codex.cmd");
  });
});
