import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  accountDirs,
  buildOpencodeCommand,
  buildOpencodeLaunch,
} from "./launch";
import { OpencodeGeneration } from "./constants";

const SERVER_SECRET = randomUUID();

const BASE = {
  generation: OpencodeGeneration.v1,
  configDir: "/home/jane/.oc-main",
  configFile: "/run/user/1000/codeweave-opencode-x/opencode.json",
  password: SERVER_SECRET,
  port: 4567,
  env: { PATH: "/usr/bin", HOME: "/home/jane", XDG_DATA_HOME: "/stale" },
};

const ISOLATION_ENV = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
};

describe("buildOpencodeLaunch", () => {
  it("posix_serves_on_loopback_with_isolated_account_dirs", () => {
    expect(
      buildOpencodeLaunch({
        ...BASE,
        executable: "/usr/local/bin/opencode",
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4567", "--pure"],
      env: {
        PATH: "/usr/bin",
        HOME: join(BASE.configDir, "home"),
        XDG_CONFIG_HOME: join(BASE.configDir, "config"),
        XDG_DATA_HOME: join(BASE.configDir, "data"),
        XDG_CACHE_HOME: join(BASE.configDir, "cache"),
        XDG_STATE_HOME: join(BASE.configDir, "state"),
        OPENCODE_CONFIG: BASE.configFile,
        OPENCODE_SERVER_PASSWORD: SERVER_SECRET,
        ...ISOLATION_ENV,
      },
    });
  });

  it("v2_launch_has_no_pure_flag_and_uses_opencode_password", () => {
    expect(
      buildOpencodeLaunch({
        ...BASE,
        generation: OpencodeGeneration.v2,
        executable: "/usr/local/bin/opencode",
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4567"],
      env: {
        PATH: "/usr/bin",
        HOME: join(BASE.configDir, "home"),
        XDG_CONFIG_HOME: join(BASE.configDir, "config"),
        XDG_DATA_HOME: join(BASE.configDir, "data"),
        XDG_CACHE_HOME: join(BASE.configDir, "cache"),
        XDG_STATE_HOME: join(BASE.configDir, "state"),
        OPENCODE_CONFIG: BASE.configFile,
        OPENCODE_PASSWORD: SERVER_SECRET,
        ...ISOLATION_ENV,
      },
    });
  });

  it("windows_shim_runs_through_comspec_with_verbatim_arguments", () => {
    const launch = buildOpencodeLaunch({
      ...BASE,
      executable: "C:\\Program Files\\nodejs\\opencode.cmd",
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\nodejs\\opencode.cmd" serve --hostname 127.0.0.1 --port 4567 --pure"',
    ]);
    expect(launch.windowsVerbatimArguments).toBe(true);
  });

  it("windows_shim_without_comspec_falls_back_to_cmd_exe", () => {
    const launch = buildOpencodeLaunch({
      ...BASE,
      executable: "C:\\bin\\opencode.bat",
      platform: "win32",
    });

    expect(launch.command).toBe("cmd.exe");
  });
});

describe("buildOpencodeLaunch direct execution", () => {
  it("windows_exe_and_posix_shim_names_run_directly", () => {
    const exe = buildOpencodeLaunch({
      ...BASE,
      executable: "C:\\bin\\opencode.exe",
      platform: "win32",
    });
    const shimOnLinux = buildOpencodeLaunch({
      ...BASE,
      executable: "/opt/opencode.cmd",
      platform: "linux",
    });

    expect(exe.command).toBe("C:\\bin\\opencode.exe");
    expect(shimOnLinux.command).toBe("/opt/opencode.cmd");
    expect(exe).not.toHaveProperty("windowsVerbatimArguments");
    expect(shimOnLinux).not.toHaveProperty("windowsVerbatimArguments");
  });
});

describe("buildOpencodeCommand", () => {
  it("windows_shim_is_wrapped_in_comspec_with_verbatim_arguments", () => {
    expect(
      buildOpencodeCommand({
        executable: "C:\\tools\\opencode.cmd",
        args: ["--version"],
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\tools\\opencode.cmd" --version"'],
      windowsVerbatimArguments: true,
    });
  });

  it("windows_shim_without_comspec_falls_back_to_cmd_exe", () => {
    expect(
      buildOpencodeCommand({
        executable: "C:\\tools\\opencode.bat",
        args: ["--version"],
        platform: "win32",
      }).command,
    ).toBe("cmd.exe");
  });

  it("other_executables_run_directly_without_the_verbatim_flag", () => {
    const exe = buildOpencodeCommand({
      executable: "C:\\bin\\opencode.exe",
      args: ["--version"],
      platform: "win32",
    });
    const posix = buildOpencodeCommand({
      executable: "/opt/opencode.cmd",
      args: ["--version"],
      platform: "linux",
    });

    expect(exe).toEqual({
      command: "C:\\bin\\opencode.exe",
      args: ["--version"],
    });
    expect(posix).toEqual({
      command: "/opt/opencode.cmd",
      args: ["--version"],
    });
  });
});

describe("accountDirs", () => {
  it("lists_every_directory_the_server_writes_to", () => {
    expect(Object.values(accountDirs("/a"))).toEqual(
      ["home", "config", "data", "cache", "state"].map((dir) =>
        join("/a", dir),
      ),
    );
  });
});
