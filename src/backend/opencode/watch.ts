import { createInterface } from "node:readline";

import { PROCESS_EXITED_MESSAGE, STDERR_TAIL_CHARS } from "../constants";
import { withTimeout } from "../codex/handshake";
import type { Contained } from "../process/container";

import { LISTENING_LINE_PREFIX, READY_TIMEOUT_MESSAGE } from "./constants";

export class ProcessExitedError extends Error {
  constructor() {
    super(PROCESS_EXITED_MESSAGE);
    this.name = "ProcessExitedError";
  }
}

export interface ProcessWatch {
  readonly exited: Promise<undefined>;
  listening(timeoutMs: number): Promise<string>;
  untilExit<T>(work: Promise<T>): Promise<T>;
  stderrTail(): string;
}

export function watchProcess(contained: Contained): ProcessWatch {
  const exited = Promise.withResolvers<undefined>();
  const url = Promise.withResolvers<string>();
  let stderrText = "";
  createInterface({ input: contained.stdout }).on("line", (line) => {
    if (line.startsWith(LISTENING_LINE_PREFIX)) {
      url.resolve(line.slice(LISTENING_LINE_PREFIX.length).trim());
    }
  });
  contained.stderr.on("data", (chunk: Buffer) => {
    stderrText = `${stderrText}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS);
  });
  contained.onExit(() => {
    exited.resolve(undefined);
  });

  function untilExit<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      exited.promise.then((): never => {
        throw new ProcessExitedError();
      }),
    ]);
  }

  return {
    exited: exited.promise,
    untilExit,
    stderrTail: () => stderrText,
    listening: (timeoutMs) =>
      untilExit(
        withTimeout(url.promise, timeoutMs).catch((error: unknown) => {
          throw new Error(READY_TIMEOUT_MESSAGE, { cause: error });
        }),
      ),
  };
}
