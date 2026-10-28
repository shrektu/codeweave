import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { EMPTY_POLL_INTERVAL_MS, STOP_CONFIRM_TIMEOUT_MS } from "../constants";

import {
  StopFailureReason,
  type Contained,
  type ExitListener,
  type StopResult,
} from "./container";

export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => Promise<ChildProcessWithoutNullStreams>;

export interface ContainerOps {
  members(): Promise<readonly number[]>;
  killMembers(): Promise<void>;
}

export const spawnChild: SpawnChild = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], options);
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      resolve(child);
    });
  });

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function notEmpty(survivors: readonly number[]): StopResult {
  return {
    ok: false,
    reason: StopFailureReason.notEmptyAfterTimeout,
    survivors,
  };
}

async function killQuietly(ops: ContainerOps): Promise<void> {
  try {
    await ops.killMembers();
  } catch (error) {
    console.error("killing container members failed", error);
  }
}

async function confirmEmpty(ops: ContainerOps): Promise<StopResult> {
  const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
  try {
    let survivors = await ops.members();
    while (survivors.length > 0 && Date.now() < deadline) {
      await killQuietly(ops);
      await delay(EMPTY_POLL_INTERVAL_MS);
      survivors = await ops.members();
    }
    return survivors.length === 0 ? { ok: true } : notEmpty(survivors);
  } catch (error) {
    console.error(
      "membership poll failed, container not confirmed empty",
      error,
    );
    return notEmpty([]);
  }
}

export function createContained(
  child: ChildProcessWithoutNullStreams,
  runId: string,
  ops: ContainerOps,
): Contained {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  return {
    pid: child.pid ?? 0,
    runId,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    async stop(graceMs: number): Promise<StopResult> {
      if (!hasExited(child)) {
        child.kill("SIGTERM");
        await Promise.race([exited, delay(graceMs)]);
      }
      await killQuietly(ops);
      return confirmEmpty(ops);
    },
    async isEmpty(): Promise<boolean> {
      return (await ops.members()).length === 0;
    },
    onExit(listener: ExitListener): void {
      child.once("exit", listener);
    },
  };
}
