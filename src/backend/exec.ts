import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  EXEC_KILL_SIGNAL,
  EXEC_TIMEOUT_MS,
  GIT_MAX_BUFFER_BYTES,
} from "./constants";

const execFileAsync = promisify(execFile);

export interface ExecOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly windowsVerbatimArguments?: boolean;
  readonly cwd?: string;
}

export type ExecText = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<string>;

export const execText: ExecText = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: options?.timeoutMs ?? EXEC_TIMEOUT_MS,
    killSignal: EXEC_KILL_SIGNAL,
    ...(options?.env === undefined
      ? {}
      : { env: { ...process.env, ...options.env } }),
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
  });
  return stdout;
};
