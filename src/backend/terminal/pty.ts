import { spawn, type IPty } from "node-pty";

import { TERMINAL_TYPE } from "../constants";
import type { Launcher, LaunchedProcess } from "../process/container";

export interface PtySize {
  readonly cols: number;
  readonly rows: number;
}

export interface PtyExit {
  readonly exitCode: number;
  readonly signal: number | null;
}

export interface PtyProcess extends LaunchedProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
}

export type PtyLauncherFactory = (size: PtySize) => Launcher<PtyProcess>;

function adapt(pty: IPty): PtyProcess {
  let exited = false;
  pty.onExit(() => {
    exited = true;
  });
  return {
    pid: pty.pid,
    hasExited: () => exited,
    write: (data) => {
      pty.write(data);
    },
    resize: (cols, rows) => {
      pty.resize(cols, rows);
    },
    pause: () => {
      pty.pause();
    },
    resume: () => {
      pty.resume();
    },
    kill: (signal) => {
      pty.kill(signal);
    },
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(({ exitCode, signal }) => {
        listener({ exitCode, signal: signal ?? null });
      });
    },
  };
}

export const createPtyLauncher: PtyLauncherFactory =
  (size) => (command, args, options) =>
    new Promise((resolve) => {
      resolve(
        adapt(
          spawn(command, [...args], {
            name: TERMINAL_TYPE,
            cols: size.cols,
            rows: size.rows,
            cwd: options.cwd,
            env: { ...options.env },
          }),
        ),
      );
    });
