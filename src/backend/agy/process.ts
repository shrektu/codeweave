import { createInterface } from "node:readline";

import type { PermissionProfile } from "../../domain/types";
import type { AgentProcess } from "../agentProcesses";

export interface LiveProcess {
  readonly agentProcess: AgentProcess;
  readonly profile: PermissionProfile;
  readonly model: string | null;
  readonly stdoutClosed: Promise<void>;
  readonly stderrClosed: Promise<void>;
  readonly snapshotDir: string;
  diffWork: Promise<void>;
  exited: boolean;
  planned: boolean;
  initCheck: Promise<void> | null;
}

export interface ProcessHandlers {
  readonly onStdoutLine: (live: LiveProcess, line: string) => void;
  readonly onStderrLine: (live: LiveProcess, line: string) => void;
  readonly onExit: (live: LiveProcess) => void;
}

export function attachProcess(
  agentProcess: AgentProcess,
  profile: PermissionProfile,
  model: string | null,
  runId: string,
  snapshotDir: string,
  handlers: ProcessHandlers,
): LiveProcess {
  const { contained } = agentProcess;
  const closed = Promise.withResolvers<undefined>();
  const stderrEnded = Promise.withResolvers<undefined>();
  const live: LiveProcess = {
    agentProcess,
    profile,
    model,
    stdoutClosed: closed.promise.then(() => undefined),
    stderrClosed: stderrEnded.promise.then(() => undefined),
    snapshotDir,
    diffWork: Promise.resolve(),
    exited: false,
    planned: false,
    initCheck: null,
  };
  contained.stdin.on("error", (error: Error) => {
    console.warn(`agy stdin error: ${runId}`, error);
  });
  const stdout = createInterface({ input: contained.stdout });
  stdout.on("line", (line) => {
    handlers.onStdoutLine(live, line);
  });
  stdout.on("close", () => {
    closed.resolve(undefined);
  });
  const stderr = createInterface({ input: contained.stderr });
  stderr.on("line", (line) => {
    handlers.onStderrLine(live, line);
  });
  stderr.on("close", () => {
    stderrEnded.resolve(undefined);
  });
  contained.onExit(() => {
    live.exited = true;
    handlers.onExit(live);
  });
  return live;
}
