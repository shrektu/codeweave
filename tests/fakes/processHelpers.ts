import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { STOP_CONFIRM_TIMEOUT_MS } from "../../src/backend/constants";

const execFileAsync = promisify(execFile);
const ZOMBIE_STATE = "Z";
const STAT_FIELDS_AFTER_COMM_OFFSET = 2;
const SYSTEMD_PROBE_ARGS = [
  "--user",
  "--scope",
  "--quiet",
  "--",
  "true",
] as const;

export const SLEEP_SECONDS = "300";
export const WAIT_TIMEOUT_MS = 10_000;
export const PROCESS_TEST_TIMEOUT_MS =
  WAIT_TIMEOUT_MS + STOP_CONFIRM_TIMEOUT_MS;

export function stringEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const afterComm = stat.slice(
      stat.lastIndexOf(")") + STAT_FIELDS_AFTER_COMM_OFFSET,
    );
    return !afterComm.startsWith(ZOMBIE_STATE);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) {
      throw error;
    }
  }
}

export function collectLines(stream: Readable): string[] {
  const lines: string[] = [];
  createInterface({ input: stream }).on("line", (line) => {
    lines.push(line);
  });
  return lines;
}

export async function systemdUserAvailable(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    await execFileAsync("systemd-run", SYSTEMD_PROBE_ARGS);
    return true;
  } catch (error) {
    console.warn("systemd user manager unavailable", error);
    return false;
  }
}

export async function makeTempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "codeweave-test-")));
}

export const HOST_EXECUTABLE_SUFFIX =
  process.platform === "win32" ? ".exe" : "";

export function hostExecutable(dir: string, name: string): string {
  return join(dir, `${name}${HOST_EXECUTABLE_SUFFIX}`);
}

export async function hostBinDirWith(...names: string[]): Promise<string> {
  const dir = await makeTempDir();
  await Promise.all(
    names.map((name) => writeFile(hostExecutable(dir, name), "")),
  );
  return dir;
}

export function hostResolverEnv(binDir: string): NodeJS.ProcessEnv {
  return { PATH: binDir, PATHEXT: HOST_EXECUTABLE_SUFFIX };
}

export async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

export function nodeArgs(script: string): string[] {
  return ["-e", script];
}

export const SPAWN_SETSID_SLEEPER_SCRIPT = `
const { spawn } = require("node:child_process");
const sleeper = spawn("sleep", ["${SLEEP_SECONDS}"], { detached: true, stdio: "ignore" });
sleeper.unref();
console.log(sleeper.pid);
`;

export const KEEP_ALIVE_SCRIPT = "setInterval(() => {}, 1000);";
