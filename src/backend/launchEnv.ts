import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { posix } from "node:path";

import {
  ABSENT_PROCESS_ERRNO_CODE,
  EXEC_KILL_SIGNAL,
  LINUX_SYSTEM_BIN_DIRS,
  LINUX_USER_BIN_DIRS,
  LOGIN_SHELL_PATH_ARGS,
  LOGIN_SHELL_PATH_COMMAND,
  LOGIN_SHELL_PATH_MARKER,
  MACOS_SYSTEM_BIN_DIRS,
  MACOS_USER_BIN_DIRS,
  USER_BIN_DIRS,
} from "./constants";
import { isDirectoryOrThrow } from "./directory";
import { inheritedEnv } from "./env";

export interface LaunchEnvDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly userShell: string | null;
  readonly readShellPath: (shell: string) => Promise<string | null>;
  readonly isDirectory: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
}

export interface ShellPathRead {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
}

function usableShell(
  deps: LaunchEnvDeps,
  candidate: string | null | undefined,
): candidate is string {
  return (
    candidate !== null &&
    candidate !== undefined &&
    posix.isAbsolute(candidate) &&
    deps.isExecutable(candidate)
  );
}

function pickShell(deps: LaunchEnvDeps): string | null {
  const { SHELL: fromEnv } = deps.env;
  if (usableShell(deps, fromEnv)) {
    return fromEnv;
  }
  return usableShell(deps, deps.userShell) ? deps.userShell : null;
}

async function loginShellEntries(deps: LaunchEnvDeps): Promise<string[]> {
  const shell = pickShell(deps);
  if (shell === null) {
    return [];
  }
  try {
    const shellPath = await deps.readShellPath(shell);
    return (shellPath ?? "")
      .split(posix.delimiter)
      .filter((entry) => posix.isAbsolute(entry));
  } catch (error) {
    console.warn("the login shell PATH could not be read", error);
    return [];
  }
}

function knownDirs(deps: LaunchEnvDeps): string[] {
  const macos = deps.platform === "darwin";
  const userDirs = [
    ...USER_BIN_DIRS,
    ...(macos ? MACOS_USER_BIN_DIRS : LINUX_USER_BIN_DIRS),
  ].map((dir) => posix.join(deps.homeDir, dir));
  const systemDirs = macos ? MACOS_SYSTEM_BIN_DIRS : LINUX_SYSTEM_BIN_DIRS;
  return [...userDirs, ...systemDirs].filter((dir) => deps.isDirectory(dir));
}

export async function resolveLaunchEnv(
  deps: LaunchEnvDeps,
): Promise<NodeJS.ProcessEnv> {
  if (deps.platform === "win32") {
    return deps.env;
  }
  const appEntries = (deps.env.PATH ?? "")
    .split(posix.delimiter)
    .filter((entry) => entry !== "");
  const merged = new Set([
    ...(await loginShellEntries(deps)),
    ...appEntries,
    ...knownDirs(deps),
  ]);
  if (merged.size === 0) {
    return deps.env;
  }
  return { ...deps.env, PATH: [...merged].join(posix.delimiter) };
}

export function parseShellPath(stdout: string): string | null {
  const end = stdout.lastIndexOf(LOGIN_SHELL_PATH_MARKER);
  if (end < LOGIN_SHELL_PATH_MARKER.length) {
    return null;
  }
  const start = stdout.lastIndexOf(
    LOGIN_SHELL_PATH_MARKER,
    end - LOGIN_SHELL_PATH_MARKER.length,
  );
  return start < 0
    ? null
    : stdout.slice(start + LOGIN_SHELL_PATH_MARKER.length, end);
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, EXEC_KILL_SIGNAL);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error) ||
      error.code !== ABSENT_PROCESS_ERRNO_CODE
    ) {
      console.warn("the login shell process group could not be killed", error);
    }
  }
}

export function readLoginShellPath(
  shell: string,
  options: ShellPathRead,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      shell,
      [...LOGIN_SHELL_PATH_ARGS, LOGIN_SHELL_PATH_COMMAND],
      {
        env: inheritedEnv(options.env),
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let settled = false;
    let stdout = "";
    const timer = setTimeout(() => {
      finish(null);
    }, options.timeoutMs);
    function finish(result: string | null): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child.pid);
      child.stdout.destroy();
      resolve(result);
    }
    child.on("error", () => {
      finish(null);
    });
    child.once("close", () => {
      finish(null);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const parsed = parseShellPath(stdout);
      if (parsed !== null) {
        finish(parsed);
      }
    });
  });
}

export function passwdShell(): string | null {
  try {
    const { shell } = userInfo();
    return shell === "" ? null : shell;
  } catch (error) {
    console.warn("the account shell could not be read", error);
    return null;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return isDirectoryOrThrow(path);
  } catch (error) {
    console.warn(`directory could not be inspected: ${path}`, error);
    return false;
  }
}
