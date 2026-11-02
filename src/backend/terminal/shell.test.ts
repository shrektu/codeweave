import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IpcError } from "../../shared/protocol";
import { makeTempDir } from "../../../tests/fakes/processHelpers";

import {
  createShellDetector,
  detectShell,
  type ShellDetectionInput,
  type ShellCommand,
} from "./shell";

interface FakeSystem {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly setting?: string | null;
  readonly executables?: readonly string[];
  readonly onPath?: Readonly<Record<string, string>>;
}

function detect(system: FakeSystem): Promise<ShellCommand> {
  const executables = new Set(system.executables ?? []);
  const input: ShellDetectionInput = {
    platform: system.platform ?? "linux",
    env: system.env ?? {},
    setting: system.setting ?? null,
    isExecutable: (path) => Promise.resolve(executables.has(path)),
    resolveOnPath: (name) => Promise.resolve(system.onPath?.[name] ?? null),
  };
  return detectShell(input);
}

async function rejectionOf(pending: Promise<unknown>): Promise<IpcError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof IpcError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describe("detectShell on linux", () => {
  it("uses_an_absolute_executable_SHELL", async () => {
    const shell = await detect({
      env: { SHELL: "/usr/bin/fish" },
      executables: ["/usr/bin/fish", "/bin/bash"],
    });

    expect(shell).toEqual({ command: "/usr/bin/fish", args: [] });
  });

  it("ignores_a_relative_SHELL", async () => {
    const shell = await detect({
      env: { SHELL: "fish" },
      executables: ["fish", "/bin/bash"],
    });

    expect(shell).toEqual({ command: "/bin/bash", args: [] });
  });

  it("ignores_a_SHELL_that_is_not_executable", async () => {
    const shell = await detect({
      env: { SHELL: "/usr/bin/gone" },
      executables: ["/bin/bash"],
    });

    expect(shell.command).toBe("/bin/bash");
  });

  it.each([
    [["/bin/bash", "/bin/zsh", "/bin/sh"], "/bin/bash"],
    [["/bin/zsh", "/bin/sh"], "/bin/zsh"],
    [["/bin/sh"], "/bin/sh"],
  ])("falls_back_in_order_with_%j", async (executables, expected) => {
    const shell = await detect({ executables });

    expect(shell.command).toBe(expected);
  });

  it("fails_with_unavailable_when_no_shell_exists", async () => {
    const error = await rejectionOf(detect({ env: { SHELL: "/bin/gone" } }));

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toBe("No usable shell was found");
  });
});

describe("detectShell on darwin", () => {
  it("starts_the_shell_as_a_login_shell", async () => {
    const shell = await detect({
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
      executables: ["/bin/zsh"],
    });

    expect(shell).toEqual({ command: "/bin/zsh", args: ["-l"] });
  });
});

describe("detectShell with a configured shell", () => {
  it("prefers_an_absolute_executable_setting_over_SHELL", async () => {
    const shell = await detect({
      setting: "/opt/nushell/bin/nu",
      env: { SHELL: "/bin/bash" },
      executables: ["/opt/nushell/bin/nu", "/bin/bash"],
    });

    expect(shell).toEqual({ command: "/opt/nushell/bin/nu", args: [] });
  });

  it("resolves_a_bare_name_on_PATH", async () => {
    const shell = await detect({
      setting: "fish",
      onPath: { fish: "/usr/local/bin/fish" },
    });

    expect(shell.command).toBe("/usr/local/bin/fish");
  });

  it("applies_the_login_argument_on_darwin_to_the_setting", async () => {
    const shell = await detect({
      platform: "darwin",
      setting: "/opt/homebrew/bin/fish",
      executables: ["/opt/homebrew/bin/fish"],
    });

    expect(shell.args).toEqual(["-l"]);
  });

  it.each([
    ["/opt/missing/shell", {}],
    ["missing-shell", { fish: "/usr/bin/fish" }],
  ])(
    "fails_naming_the_setting_when_%s_cannot_be_resolved",
    async (setting, onPath) => {
      const error = await rejectionOf(
        detect({ setting, onPath, executables: ["/bin/bash"] }),
      );

      expect(error.code).toBe("UNAVAILABLE");
      expect(error.message).toBe(
        `The terminal shell setting "${setting}" was not found or is not executable`,
      );
    },
  );
});

const POWERSHELL_CORE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const WINDOWS_POWERSHELL =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const COMSPEC = "C:\\Windows\\System32\\cmd.exe";

describe("detectShell on win32", () => {
  it("prefers_pwsh_on_PATH_with_no_logo", async () => {
    const shell = await detect({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", ComSpec: COMSPEC },
      onPath: { "pwsh.exe": POWERSHELL_CORE },
      executables: [WINDOWS_POWERSHELL, COMSPEC],
    });

    expect(shell).toEqual({ command: POWERSHELL_CORE, args: ["-NoLogo"] });
  });

  it("falls_back_to_windows_powershell_under_SystemRoot", async () => {
    const shell = await detect({
      platform: "win32",
      env: { SystemRoot: "D:\\Win", ComSpec: COMSPEC },
      executables: [
        "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        COMSPEC,
      ],
    });

    expect(shell).toEqual({
      command: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo"],
    });
  });

  it("assumes_the_default_SystemRoot_when_it_is_unset", async () => {
    const shell = await detect({
      platform: "win32",
      executables: [WINDOWS_POWERSHELL],
    });

    expect(shell.command).toBe(WINDOWS_POWERSHELL);
  });
});

describe("detectShell on win32 without PowerShell", () => {
  it("falls_back_to_ComSpec_without_arguments", async () => {
    const shell = await detect({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", ComSpec: COMSPEC },
      executables: [COMSPEC],
    });

    expect(shell).toEqual({ command: COMSPEC, args: [] });
  });

  it("finds_cmd_on_PATH_when_ComSpec_is_unset", async () => {
    const shell = await detect({
      platform: "win32",
      onPath: { "cmd.exe": COMSPEC },
      executables: [COMSPEC],
    });

    expect(shell.command).toBe(COMSPEC);
  });

  it("fails_when_nothing_is_available", async () => {
    const error = await rejectionOf(detect({ platform: "win32" }));

    expect(error.code).toBe("UNAVAILABLE");
  });

  it.each([
    ["C:\\Tools\\nu.exe", []],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoLogo"]],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoLogo"],
    ],
  ])("passes_arguments_for_the_configured_%s", async (setting, args) => {
    const shell = await detect({
      platform: "win32",
      setting,
      executables: [setting],
    });

    expect(shell).toEqual({ command: setting, args });
  });
});

describe("createShellDetector PATH lookup", () => {
  it.skipIf(process.platform === "win32")(
    "path_lookup_skips_non_executable_shell",
    async () => {
      const blocked = await makeTempDir();
      const usable = await makeTempDir();
      await writeFile(join(blocked, "fakesh"), "");
      await chmod(join(blocked, "fakesh"), 0o644);
      await writeFile(join(usable, "fakesh"), "");
      await chmod(join(usable, "fakesh"), 0o755);
      const detect = createShellDetector("linux", {
        PATH: `${blocked}:${usable}`,
      });

      const shell = await detect("fakesh");

      expect(shell).toEqual({ command: join(usable, "fakesh"), args: [] });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "path_lookup_skips_unsearchable_path_entry",
    async () => {
      const locked = await makeTempDir();
      const usable = await makeTempDir();
      await writeFile(join(usable, "fakesh"), "");
      await chmod(join(usable, "fakesh"), 0o755);
      await chmod(locked, 0o000);
      const detect = createShellDetector("linux", {
        PATH: `${join(locked, "bin")}:${usable}`,
      });

      try {
        const shell = await detect("fakesh");

        expect(shell).toEqual({ command: join(usable, "fakesh"), args: [] });
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );
});
