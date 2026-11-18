import { access, readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  killQuietly,
  makeTempDir,
  PROCESS_TEST_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
} from "../../tests/fakes/processHelpers";

import { LOGIN_SHELL_PATH_COMMAND, LOGIN_SHELL_PATH_MARKER } from "./constants";
import {
  parseShellPath,
  readLoginShellPath,
  resolveLaunchEnv,
  type LaunchEnvDeps,
} from "./launchEnv";

const HOME = "/home/jane";
const MARKER = "__CODEWEAVE_PATH__";
const EXECUTABLE_MODE = 0o755;
const READ_TIMEOUT_MS = 2000;

function depsWith(overrides: Partial<LaunchEnvDeps> = {}): LaunchEnvDeps {
  return {
    env: { PATH: "/usr/bin:/bin" },
    platform: "linux",
    homeDir: HOME,
    userShell: null,
    readShellPath: () => Promise.resolve(null),
    isDirectory: () => false,
    isExecutable: () => false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveLaunchEnv", () => {
  it("win32_returns_the_same_env_object_without_probing", async () => {
    const env = { PATH: "C:\\Windows", SHELL: "/bin/zsh" };
    const readShellPath = vi.fn(() => Promise.resolve("/x"));
    const isDirectory = vi.fn(() => true);
    const isExecutable = vi.fn(() => true);

    const result = await resolveLaunchEnv(
      depsWith({
        env,
        platform: "win32",
        userShell: "/bin/zsh",
        readShellPath,
        isDirectory,
        isExecutable,
      }),
    );

    expect(result).toBe(env);
    expect(readShellPath).not.toHaveBeenCalled();
    expect(isDirectory).not.toHaveBeenCalled();
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it("merges_shell_then_app_then_known_dirs_without_duplicates", async () => {
    const known = new Set([`${HOME}/.local/bin`, `${HOME}/.cargo/bin`]);

    const result = await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin:/opt/app:/usr/bin", SHELL: "/bin/zsh" },
        readShellPath: () => Promise.resolve("/shell/a:/usr/bin:/shell/b"),
        isExecutable: () => true,
        isDirectory: (path) => known.has(path),
      }),
    );

    expect(result.PATH).toBe(
      "/shell/a:/usr/bin:/shell/b:/opt/app:/home/jane/.local/bin:/home/jane/.cargo/bin",
    );
  });

  it("keeps_every_other_variable_of_the_input", async () => {
    const result = await resolveLaunchEnv(
      depsWith({ env: { PATH: "/usr/bin", HOME: HOME, LANG: "pl_PL.UTF-8" } }),
    );

    expect(result).toEqual({
      PATH: "/usr/bin",
      HOME: HOME,
      LANG: "pl_PL.UTF-8",
    });
  });
});

describe("resolveLaunchEnv entries", () => {
  it("drops_relative_and_empty_shell_entries", async () => {
    const result = await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        readShellPath: () => Promise.resolve("bin::/abs/a:./rel:/abs/b"),
        isExecutable: () => true,
      }),
    );

    expect(result.PATH).toBe("/abs/a:/abs/b:/usr/bin");
  });

  it("keeps_relative_app_entries_and_drops_empty_ones", async () => {
    const result = await resolveLaunchEnv(
      depsWith({ env: { PATH: "rel/dir::/usr/bin:" } }),
    );

    expect(result.PATH).toBe("rel/dir:/usr/bin");
  });

  it.each([
    ["unset", undefined],
    ["relative", "zsh"],
  ])("uses_the_passwd_shell_when_SHELL_is_%s", async (_name, shellVariable) => {
    const readShellPath = vi.fn(() => Promise.resolve("/shell/a"));

    const result = await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin", SHELL: shellVariable },
        userShell: "/bin/passwd-shell",
        readShellPath,
        isExecutable: () => true,
      }),
    );

    expect(readShellPath).toHaveBeenCalledExactlyOnceWith("/bin/passwd-shell");
    expect(result.PATH).toBe("/shell/a:/usr/bin");
  });
});

describe("resolveLaunchEnv shell choice", () => {
  it("prefers_an_executable_SHELL_over_the_passwd_shell", async () => {
    const readShellPath = vi.fn(() => Promise.resolve("/shell/a"));

    await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        userShell: "/bin/passwd-shell",
        readShellPath,
        isExecutable: () => true,
      }),
    );

    expect(readShellPath).toHaveBeenCalledExactlyOnceWith("/bin/zsh");
  });

  it("skips_the_shell_when_none_is_executable", async () => {
    const readShellPath = vi.fn(() => Promise.resolve("/shell/a"));

    const result = await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        userShell: "/bin/passwd-shell",
        readShellPath,
        isExecutable: () => false,
      }),
    );

    expect(readShellPath).not.toHaveBeenCalled();
    expect(result.PATH).toBe("/usr/bin");
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("boom"))],
    ["returns_null", () => Promise.resolve(null)],
  ])("falls_back_when_the_shell_read_%s", async (_name, readShellPath) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        readShellPath,
        isExecutable: () => true,
        isDirectory: (path) => path === `${HOME}/.local/bin`,
      }),
    );

    expect(result.PATH).toBe("/usr/bin:/home/jane/.local/bin");
  });
});

describe("resolveLaunchEnv known dirs", () => {
  it("adds_only_existing_known_dirs", async () => {
    const result = await resolveLaunchEnv(
      depsWith({
        isDirectory: (path) => path === `${HOME}/.bun/bin`,
      }),
    );

    expect(result.PATH).toBe("/usr/bin:/bin:/home/jane/.bun/bin");
  });

  it("macos_adds_homebrew_and_library_dirs", async () => {
    const result = await resolveLaunchEnv(
      depsWith({
        env: { PATH: "/usr/bin" },
        platform: "darwin",
        isDirectory: () => true,
      }),
    );

    expect(result.PATH).toBe(
      [
        "/usr/bin",
        "/home/jane/.local/bin",
        "/home/jane/.opencode/bin",
        "/home/jane/.cargo/bin",
        "/home/jane/.bun/bin",
        "/home/jane/.npm-global/bin",
        "/home/jane/.volta/bin",
        "/home/jane/Library/pnpm",
        "/home/jane/Library/Application Support/fnm/aliases/default/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ].join(":"),
    );
  });
});

describe("resolveLaunchEnv linux dirs", () => {
  it("linux_adds_pnpm_and_fnm_dirs", async () => {
    const result = await resolveLaunchEnv(
      depsWith({ env: { PATH: "/usr/bin" }, isDirectory: () => true }),
    );

    expect(result.PATH).toBe(
      [
        "/usr/bin",
        "/home/jane/.local/bin",
        "/home/jane/.opencode/bin",
        "/home/jane/.cargo/bin",
        "/home/jane/.bun/bin",
        "/home/jane/.npm-global/bin",
        "/home/jane/.volta/bin",
        "/home/jane/.local/share/pnpm",
        "/home/jane/.local/share/fnm/aliases/default/bin",
        "/home/linuxbrew/.linuxbrew/bin",
      ].join(":"),
    );
  });

  it("keeps_an_unset_path_unset_when_nothing_is_found", async () => {
    const env = { HOME: HOME };

    const result = await resolveLaunchEnv(depsWith({ env }));

    expect(result).toBe(env);
  });

  it("handles_an_unset_app_path", async () => {
    const result = await resolveLaunchEnv(
      depsWith({
        env: {},
        isDirectory: (path) => path === `${HOME}/.local/bin`,
      }),
    );

    expect(result.PATH).toBe("/home/jane/.local/bin");
  });
});

describe("parseShellPath", () => {
  it("takes_the_last_marker_pair", () => {
    const stdout = `noise${MARKER}/old${MARKER}banner${MARKER}/a:/b${MARKER}`;

    expect(parseShellPath(stdout)).toBe("/a:/b");
  });

  it.each([
    ["empty_output", ""],
    ["no_marker", "/usr/bin:/bin"],
    ["only_an_opening_marker", `banner${MARKER}/usr/bin`],
  ])("returns_null_without_a_complete_pair_for_%s", (_name, stdout) => {
    expect(parseShellPath(stdout)).toBeNull();
  });

  it("command_text_does_not_contain_the_marker", () => {
    expect(LOGIN_SHELL_PATH_COMMAND).not.toContain(LOGIN_SHELL_PATH_MARKER);
  });
});

const GRANDCHILD_PID_FILE = "grandchild.pid";
const PIPE_BROKEN_FILE = "pipe-broken";

async function writeLeakingShell(dir: string): Promise<string> {
  const grandchild = posix.join(dir, "grandchild.js");
  const launcher = posix.join(dir, "launcher.js");
  const shell = posix.join(dir, "fake-shell");
  await writeFile(
    grandchild,
    [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(posix.join(dir, GRANDCHILD_PID_FILE))}, String(process.pid));`,
      'process.stdout.on("error", () => {',
      `  fs.writeFileSync(${JSON.stringify(posix.join(dir, PIPE_BROKEN_FILE))}, "broken");`,
      "  process.exit(0);",
      "});",
      'setInterval(() => { process.stdout.write("tick\\n"); }, 50);',
    ].join("\n"),
  );
  await writeFile(
    launcher,
    [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: "inherit" }).unref();`,
    ].join("\n"),
  );
  await writeFile(
    shell,
    [
      "#!/bin/sh",
      `"${process.execPath}" "${launcher}" &`,
      `while [ ! -f "${posix.join(dir, GRANDCHILD_PID_FILE)}" ]; do sleep 0.05; done`,
      'eval "$2"',
      "",
    ].join("\n"),
    { mode: EXECUTABLE_MODE },
  );
  return shell;
}

describe.skipIf(process.platform === "win32")("readLoginShellPath", () => {
  it("returns_null_when_the_shell_exits_without_a_marker", async () => {
    const dir = await makeTempDir();
    const shell = posix.join(dir, "silent-shell");
    await writeFile(shell, "#!/bin/sh\necho no marker here\n", {
      mode: EXECUTABLE_MODE,
    });

    const result = await readLoginShellPath(shell, {
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      timeoutMs: READ_TIMEOUT_MS,
    });

    expect(result).toBeNull();
  });

  it(
    "stops_reading_stdout_once_the_path_is_known",
    async () => {
      const dir = await makeTempDir();
      const pidFile = posix.join(dir, GRANDCHILD_PID_FILE);
      const brokenFile = posix.join(dir, PIPE_BROKEN_FILE);
      const shell = await writeLeakingShell(dir);
      let pid = 0;
      try {
        const result = await readLoginShellPath(shell, {
          env: { PATH: "/usr/bin:/bin" },
          cwd: dir,
          timeoutMs: WAIT_TIMEOUT_MS,
        });

        expect(result).toBe("/usr/bin:/bin");
        await vi.waitFor(
          async () => {
            pid = Number(await readFile(pidFile, "utf8"));
            expect(pid).toBeGreaterThan(0);
          },
          { timeout: WAIT_TIMEOUT_MS },
        );
        await vi.waitFor(
          async () => {
            await access(brokenFile);
          },
          { timeout: WAIT_TIMEOUT_MS },
        );
      } finally {
        if (pid > 0) {
          killQuietly(pid);
        }
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it("returns_null_when_the_shell_cannot_be_spawned", async () => {
    const dir = await makeTempDir();

    const result = await readLoginShellPath(posix.join(dir, "missing-shell"), {
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      timeoutMs: READ_TIMEOUT_MS,
    });

    expect(result).toBeNull();
  });
});
