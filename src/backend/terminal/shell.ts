import { accessSync, constants, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { IpcError, IpcErrorCode } from "../../shared/protocol";
import {
  LOGIN_SHELL_ARGS,
  POSIX_SHELL_FALLBACKS,
  POWERSHELL_ARGS,
  POWERSHELL_CORE_BINARY,
  POWERSHELL_NAME_PATTERN,
  WINDOWS_COMMAND_INTERPRETER,
  WINDOWS_DEFAULT_SYSTEM_ROOT,
  WINDOWS_POWERSHELL_RELATIVE_PATH,
} from "../constants";
import { resolveExecutable } from "../executable";

export interface ShellCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ShellDetectionInput {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly setting: string | null;
  isExecutable(path: string): Promise<boolean>;
  resolveOnPath(name: string): Promise<string | null>;
}

export type ShellDetector = (setting: string | null) => Promise<ShellCommand>;

function argsFor(command: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return POWERSHELL_NAME_PATTERN.test(win32.basename(command))
      ? [...POWERSHELL_ARGS]
      : [];
  }
  return platform === "darwin" ? [...LOGIN_SHELL_ARGS] : [];
}

async function resolveSetting(
  input: ShellDetectionInput,
  setting: string,
): Promise<string> {
  const pathApi = input.platform === "win32" ? win32 : posix;
  const found = pathApi.isAbsolute(setting)
    ? (await input.isExecutable(setting))
      ? setting
      : null
    : await input.resolveOnPath(setting);
  if (found === null) {
    throw new IpcError(
      IpcErrorCode.UNAVAILABLE,
      `The terminal shell setting "${setting}" was not found or is not executable`,
    );
  }
  return found;
}

async function firstExecutable(
  input: ShellDetectionInput,
  candidates: readonly (string | null | undefined)[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if (
      candidate !== null &&
      candidate !== undefined &&
      (await input.isExecutable(candidate))
    ) {
      return candidate;
    }
  }
  return null;
}

async function detectUnix(input: ShellDetectionInput): Promise<string | null> {
  const fromEnv = input.env.SHELL;
  return firstExecutable(input, [
    fromEnv !== undefined && posix.isAbsolute(fromEnv) ? fromEnv : null,
    ...POSIX_SHELL_FALLBACKS,
  ]);
}

async function detectWindows(
  input: ShellDetectionInput,
): Promise<string | null> {
  const core = await input.resolveOnPath(POWERSHELL_CORE_BINARY);
  if (core !== null) {
    return core;
  }
  const systemRoot = input.env.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT;
  const resolvedComSpec =
    input.env.ComSpec ??
    (await input.resolveOnPath(WINDOWS_COMMAND_INTERPRETER));
  return firstExecutable(input, [
    win32.join(systemRoot, WINDOWS_POWERSHELL_RELATIVE_PATH),
    resolvedComSpec,
  ]);
}

export async function detectShell(
  input: ShellDetectionInput,
): Promise<ShellCommand> {
  const command =
    input.setting === null
      ? await (input.platform === "win32"
          ? detectWindows(input)
          : detectUnix(input))
      : await resolveSetting(input, input.setting);
  if (command === null) {
    throw new IpcError(IpcErrorCode.UNAVAILABLE, "No usable shell was found");
  }
  return { command, args: argsFor(command, input.platform) };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    console.warn(`shell candidate is not usable: ${path}`, error);
    return false;
  }
}

function isRunnableFileSync(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
      return false;
    }
    if (platform !== "win32") {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch (error) {
    console.warn(`shell candidate is not usable: ${path}`, error);
    return false;
  }
}

export function createShellDetector(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellDetector {
  return (setting) =>
    detectShell({
      platform,
      env,
      setting,
      isExecutable: isExecutableFile,
      resolveOnPath: (name) =>
        Promise.resolve(
          resolveExecutable(name, {
            pathEnv: env.PATH ?? "",
            pathExt: env.PATHEXT,
            platform,
            isFile: (path) => isRunnableFileSync(path, platform),
          }),
        ),
    });
}
