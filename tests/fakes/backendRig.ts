import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, vi } from "vitest";

import {
  startBackend,
  type Backend,
  type BackendDeps,
} from "../../src/backend/startup";
import { createJsonStore, type JsonStore } from "../../src/backend/storage";
import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
} from "../../src/backend/process/container";
import type { Account } from "../../src/domain/types";
import { SessionViewSchema, type SessionView } from "../../src/shared/views";
import type {
  EventName,
  ParamsMap,
  RequestMethod,
  ResultMap,
} from "../../src/shared/protocol";

import {
  RIG_ADAPTER_ENTRY,
  RIG_EXEC_PATH,
  ScriptedAcpContainer,
  type FakeAcpAgent,
} from "./fakeAcpAgent";
import type { ScheduledTask } from "./rotationHarness";

export const RIG_NOW_MS = 1_700_000_000_000;
export const RIG_NOW_SECONDS = 1_700_000_000;
export const RIG_CLAUDE_PATH = "/usr/bin/claude";

export const ACCOUNT_A: Account = {
  id: "acc-a",
  provider: "claude",
  label: "A",
  configDir: "/cfg/a",
  order: 0,
};
export const ACCOUNT_B: Account = {
  id: "acc-b",
  provider: "claude",
  label: "B",
  configDir: "/cfg/b",
  order: 1,
};

export interface RecordedBroadcast {
  readonly event: string;
  readonly payload: unknown;
}

export interface BackendRigOptions {
  readonly userData?: string;
  readonly accounts?: readonly Account[];
  readonly containerError?: Error;
  readonly stopResults?: ConstructorParameters<typeof ScriptedAcpContainer>[0];
  readonly platform?: NodeJS.Platform;
  readonly worktreeGate?: Promise<void>;
}

export interface BackendRig {
  readonly backend: Backend;
  readonly container: ScriptedAcpContainer;
  readonly store: JsonStore;
  readonly userData: string;
  readonly cwd: string;
  readonly order: string[];
  readonly sweeps: (readonly string[])[];
  readonly instanceIds: string[];
  readonly broadcasts: RecordedBroadcast[];
  readonly scheduled: ScheduledTask[];
  readonly contained: Contained[];
  call<M extends RequestMethod>(
    method: M,
    params: ParamsMap[M],
  ): Promise<ResultMap[M]>;
  broadcastsOf(event: EventName): unknown[];
  session(): Promise<SessionView>;
  dispose(): Promise<void>;
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function removeBackendRigDirs(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

function recordingContainer(
  inner: ScriptedAcpContainer,
  rig: Pick<BackendRig, "order" | "sweeps" | "contained">,
): ProcessContainer {
  return {
    kind: inner.kind,
    async spawn(spec: SpawnSpec): Promise<Contained> {
      rig.order.push(`spawn:${spec.runId}`);
      const contained = await inner.spawn(spec);
      rig.contained.push(contained);
      return {
        pid: contained.pid,
        runId: contained.runId,
        stdin: contained.stdin,
        stdout: contained.stdout,
        stderr: contained.stderr,
        isEmpty: () => contained.isEmpty(),
        onExit: (listener) => {
          contained.onExit(listener);
        },
        stop: async (graceMs) => {
          const result = await contained.stop(graceMs);
          rig.order.push(`stop-confirmed:${contained.runId}`);
          return result;
        },
      };
    },
    sweepOrphans(stale: readonly string[]): Promise<number> {
      rig.sweeps.push(stale);
      return inner.sweepOrphans();
    },
  };
}

function scheduler(
  scheduled: ScheduledTask[],
): (at: number, run: () => void) => () => void {
  return (at, run) => {
    const task: ScheduledTask = { at, run, cancelled: false };
    scheduled.push(task);
    return () => {
      task.cancelled = true;
    };
  };
}

function runIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `run-${String(counter)}`;
  };
}

interface RigLog {
  readonly order: string[];
  readonly sweeps: (readonly string[])[];
  readonly contained: Contained[];
  readonly broadcasts: RecordedBroadcast[];
  readonly scheduled: ScheduledTask[];
  readonly instanceIds: string[];
}

function rigDeps(
  options: BackendRigOptions,
  userData: string,
  container: ScriptedAcpContainer,
  log: RigLog,
): BackendDeps {
  return {
    args: { userData, testAgentEnv: null },
    broadcast: (event, payload) => {
      log.broadcasts.push({ event, payload });
    },
    createContainer: (instanceId) => {
      log.instanceIds.push(instanceId);
      return options.containerError === undefined
        ? Promise.resolve(recordingContainer(container, log))
        : Promise.reject(options.containerError);
    },
    execPath: RIG_EXEC_PATH,
    adapterEntry: RIG_ADAPTER_ENTRY,
    parentEnv: { PATH: "/usr/bin" },
    homeDir: "/home/jane",
    platform: options.platform ?? "linux",
    now: () => RIG_NOW_MS,
    schedule: scheduler(log.scheduled),
    newRunId: runIds(),
    resolveClaudeExecutable: () => RIG_CLAUDE_PATH,
    inspectWorktree: async (dir) => {
      await options.worktreeGate;
      return { isRepo: false, cwd: dir };
    },
  };
}

export async function createBackendRig(
  options: BackendRigOptions = {},
): Promise<BackendRig> {
  const userData = options.userData ?? (await tempDir("codeweave-user-"));
  const cwd = await tempDir("codeweave-cwd-");
  await mkdir(userData, { recursive: true });
  const store = createJsonStore(userData);
  if (options.accounts !== undefined) {
    await store.writeAccounts(options.accounts);
  }
  const container = new ScriptedAcpContainer(options.stopResults);
  const broadcasts: RecordedBroadcast[] = [];
  const scheduled: ScheduledTask[] = [];
  const instanceIds: string[] = [];
  const parts = {
    order: [] as string[],
    sweeps: [] as (readonly string[])[],
    contained: [] as Contained[],
  };
  const backend = await startBackend(
    rigDeps(options, userData, container, {
      ...parts,
      broadcasts,
      scheduled,
      instanceIds,
    }),
  );
  const call = async <M extends RequestMethod>(
    method: M,
    params: ParamsMap[M],
  ): Promise<ResultMap[M]> => backend.handlers[method](params);
  return {
    backend,
    container,
    store,
    userData,
    cwd,
    ...parts,
    instanceIds,
    broadcasts,
    scheduled,
    call,
    broadcastsOf: (event) =>
      broadcasts
        .filter((entry) => entry.event === event)
        .map((entry) => entry.payload),
    session: async () => {
      const { session } = await call("sessions/snapshot", {});
      if (session === null) {
        throw new Error("no session in snapshot");
      }
      return SessionViewSchema.parse(session);
    },
    dispose: () => backend.shutdown(),
  };
}

const openRigs: BackendRig[] = [];

export async function openRig(
  options: BackendRigOptions = { accounts: [ACCOUNT_A, ACCOUNT_B] },
): Promise<BackendRig> {
  const rig = await createBackendRig(options);
  openRigs.push(rig);
  return rig;
}

export async function closeRigs(): Promise<void> {
  await Promise.all(openRigs.splice(0).map((rig) => rig.dispose()));
  await removeBackendRigDirs();
}

export function startParams(
  rig: BackendRig,
  profile?: ParamsMap["session/start"]["profile"],
): ParamsMap["session/start"] {
  return profile === undefined ? { cwd: rig.cwd } : { cwd: rig.cwd, profile };
}

export function agentOf(rig: BackendRig, index = 0): FakeAcpAgent {
  const agent = rig.container.agents[index];
  if (agent === undefined) {
    throw new Error(`agent ${String(index)} was not spawned`);
  }
  return agent;
}

export async function turnEnded(rig: BackendRig): Promise<void> {
  await vi.waitFor(async () => {
    const view = await rig.session();
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).not.toBeNull();
  });
}
