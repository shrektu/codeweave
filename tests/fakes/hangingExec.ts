import type { ExecText } from "../../src/backend/exec";

export interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number | undefined;
}

export interface HangingExec {
  readonly exec: ExecText;
  readonly calls: RecordedCall[];
}

export function createHangingExec(
  hangingArgs: readonly string[],
  fallbackStdout = "",
): HangingExec {
  const calls: RecordedCall[] = [];
  const exec: ExecText = (file, args, options) => {
    calls.push({ file, args, timeoutMs: options?.timeoutMs });
    if (!args.some((arg) => hangingArgs.includes(arg))) {
      return Promise.resolve(fallbackStdout);
    }
    if (options?.timeoutMs === undefined) {
      return new Promise<string>(() => undefined);
    }
    return Promise.reject(
      Object.assign(new Error(`${file} timed out`), { killed: true }),
    );
  };
  return { exec, calls };
}

export function raceAgainstHang<T>(
  work: Promise<T>,
  hangMs: number,
): Promise<T | "hung"> {
  return Promise.race([
    work,
    new Promise<"hung">((resolve) => {
      setTimeout(() => {
        resolve("hung");
      }, hangMs);
    }),
  ]);
}
