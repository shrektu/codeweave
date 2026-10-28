import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, vi } from "vitest";

import {
  startBackend,
  type Backend,
  type BackendDeps,
} from "../../src/backend/startup";
import {
  PROBE_INTERVAL_MS,
  PROBE_RUN_ID_PREFIX,
} from "../../src/backend/constants";
import { createJsonStore, type JsonStore } from "../../src/backend/storage";
import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
  StopResult,
} from "../../src/backend/process/container";
import { ProviderId, type Account } from "../../src/domain/types";
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
import {
  CODEX_RIG_EXECUTABLE,
  ScriptedCodexContainer,
  type FakeCodexConfig,
} from "./fakeCodexAppServer";
import type { ScheduledTask } from "./rotationHarness";


export const RIG_NOW_MS = 1_700_000_000_000;
export const RIG_NOW_SECONDS = 1_700_000_000;
export const RIG_CLAUDE_PATH = "/usr/bin/claude";
export const RIG_CODEX_PATH = CODEX_RIG_EXECUTABLE;

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
export const ACCOUNT_CODEX_A: Account = {
  id: "codex-a",
  provider: "codex",
  label: "Codex A",
  configDir: "/cfg/codex-a",
  order: 0,
};
export const ACCOUNT_CODEX_B: Account = {
  id: "codex-b",
  provider: "codex",
  label: "Codex B",
  configDir: "/cfg/codex-b",
  order: 1,
};
export const ACCOUNT_CLAUDE_C: Account = {
  id: "claude-c",
  provider: "claude",
  label: "Claude C",
  configDir: "/cfg/claude-c",
  order: 2,
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
  readonly resolveExecutable?: BackendDeps["resolveExecutable"];
  readonly probeConfig?: FakeCodexConfig;
  readonly probeConfigByHome?: Readonly<Record<string, FakeCodexConfig>>;
  readonly now?: () => number;
  readonly probeStopResults?: ConstructorParameters<
    typeof ScriptedCodexContainer
  >[0];
  readonly probeStopResultsByHome?: Readonly<
    Record<string, readonly StopResult[]>
  >;
  readonly codexStopResultsByHome?: Readonly<
    Record<string, readonly StopResult[]>
  >;
}

export interface ProbeStats {
  alive: number;
  peak: number;
}

export interface BackendRig {
  readonly backend: Backend;
  readonly container: ScriptedAcpContainer;
  readonly codexContainer: ScriptedCodexContainer;
  readonly probeContainer: ScriptedCodexContainer;
  readonly probeTasks: ScheduledTask[];
  readonly probeStats: ProbeStats;
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

async function spawnProbe(
  probe: ScriptedCodexContainer,
  stats: ProbeStats,
  spec: SpawnSpec,
): Promise<Contained> {
  const contained = await probe.spawn(spec);
  stats.alive += 1;
  stats.peak = Math.max(stats.peak, stats.alive);
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
      stats.alive -= 1;
      return result;
    },
  };
}

function recordingContainer(
  claude: ScriptedAcpContainer,
  codex: ScriptedCodexContainer,
  probe: { container: ScriptedCodexContainer; stats: ProbeStats },
  rig: Pick<BackendRig, "order" | "sweeps" | "contained">,
): ProcessContainer {
  return {
    kind: claude.kind,
    async spawn(spec: SpawnSpec): Promise<Contained> {
      if (spec.runId.startsWith(PROBE_RUN_ID_PREFIX)) {
        return spawnProbe(probe.container, probe.stats, spec);
      }
      rig.order.push(`spawn:${spec.runId}`);
      const target = spec.command === RIG_CODEX_PATH ? codex : claude;
      const contained = await target.spawn(spec);
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
      return claude.sweepOrphans();
    },
  };
}

function scheduler(
  scheduled: ScheduledTask[],
  probeTasks: ScheduledTask[],
): (at: number, run: () => void) => () => void {
  return (at, run) => {
    const task: ScheduledTask = { at, run, cancelled: false };
    (at === RIG_NOW_MS + PROBE_INTERVAL_MS ? probeTasks : scheduled).push(task);
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
  readonly probeTasks: ScheduledTask[];
  readonly probeStats: ProbeStats;
  readonly instanceIds: string[];
}

function rigDeps(
  options: BackendRigOptions,
  userData: string,
  containers: {
    readonly claude: ScriptedAcpContainer;
    readonly codex: ScriptedCodexContainer;
    readonly probe: ScriptedCodexContainer;
  },
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
        ? Promise.resolve(
            recordingContainer(
              containers.claude,
              containers.codex,
              { container: containers.probe, stats: log.probeStats },
              log,
            ),
          )
        : Promise.reject(options.containerError);
    },
    execPath: RIG_EXEC_PATH,
    adapterEntry: RIG_ADAPTER_ENTRY,
    parentEnv: { PATH: "/usr/bin" },
    homeDir: "/home/jane",
    platform: options.platform ?? "linux",
    now: options.now ?? (() => RIG_NOW_MS),
    schedule: scheduler(log.scheduled, log.probeTasks),
    newRunId: runIds(),
    resolveExecutable:
      options.resolveExecutable ??
      ((provider) =>
        provider === ProviderId.codex ? RIG_CODEX_PATH : RIG_CLAUDE_PATH),
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
  const codexContainer = new ScriptedCodexContainer();
  const probeContainer = new ScriptedCodexContainer(options.probeStopResults);
  for (const [home, results] of Object.entries(
    options.probeStopResultsByHome ?? {},
  )) {
    probeContainer.stopResultsByHome.set(home, [...results]);
  }
  for (const [home, results] of Object.entries(
    options.codexStopResultsByHome ?? {},
  )) {
    codexContainer.stopResultsByHome.set(home, [...results]);
  }
  Object.assign(probeContainer.config, options.probeConfig);
  for (const [home, config] of Object.entries(
    options.probeConfigByHome ?? {},
  )) {
    probeContainer.configByHome.set(home, config);
  }
  const broadcasts: RecordedBroadcast[] = [];
  const scheduled: ScheduledTask[] = [];
  const probeTasks: ScheduledTask[] = [];
  const probeStats: ProbeStats = { alive: 0, peak: 0 };
  const instanceIds: string[] = [];
  const parts = {
    order: [] as string[],
    sweeps: [] as (readonly string[])[],
    contained: [] as Contained[],
  };
  const backend = await startBackend(
    rigDeps(
      options,
      userData,
      { claude: container, codex: codexContainer, probe: probeContainer },
      {
        ...parts,
        broadcasts,
        scheduled,
        probeTasks,
        probeStats,
        instanceIds,
      },
    ),
  );
  const call = async <M extends RequestMethod>(
    method: M,
    params: ParamsMap[M],
  ): Promise<ResultMap[M]> => backend.handlers[method](params);
  return {
    backend,
    container,
    codexContainer,
    probeContainer,
    probeStats,
    probeTasks,
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
