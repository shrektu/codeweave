import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";

import type { ConnectionRegistry } from "../../src/backend/connections";
import {
  createBackendRegistry,
  startBackend,
  type Backend,
} from "../../src/backend/startup";
import { ContainerKind } from "../../src/backend/process/container";
import type {
  ContainerOps,
  Launched,
  LaunchedProcess,
  Launcher,
  LaunchOptions,
  ProcessContainer,
  SpawnSpec,
} from "../../src/backend/process/container";
import type {
  PtyExit,
  PtyLauncherFactory,
  PtyProcess,
  PtySize,
} from "../../src/backend/terminal/pty";
import {
  createTerminalService,
  type TerminalService,
} from "../../src/backend/terminal/service";
import type { CancelTimer } from "../../src/backend/terminal/session";
import type { ShellCommand } from "../../src/backend/terminal/shell";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import { fromNodePort } from "../../src/shared/port";
import {
  EventSchema,
  ResponseSchema,
  type EventName,
  type IpcEvent,
  type IpcResponse,
  type ParamsMap,
  type RequestMethod,
} from "../../src/shared/protocol";

import { unsupportedLaunch } from "./fakeContainer";
import { createFakeVault } from "./fakeVault";
import { makeTempDir } from "./processHelpers";

export const FAKE_SHELL: ShellCommand = {
  command: "/bin/fake-shell",
  args: ["-l"],
};
export const FAKE_SHELL_EXIT_ON_HUP = 129;
const FAKE_PTY_FIRST_PID = 7000;

export interface RecordedEvent {
  readonly event: EventName;
  readonly payload: unknown;
}

export class FakePty implements PtyProcess {
  readonly pid: number;
  readonly written: string[] = [];
  readonly resizes: PtySize[] = [];
  readonly kills: (NodeJS.Signals | undefined)[] = [];
  pauseCalls = 0;
  resumeCalls = 0;
  paused = false;
  echoInput = false;
  exitOnKill = true;
  private exited = false;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((exit: PtyExit) => void)[] = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  hasExited(): boolean {
    return this.exited;
  }

  write(data: string): void {
    this.written.push(data);
    if (this.echoInput) {
      this.emitData(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  resume(): void {
    this.resumeCalls += 1;
    this.paused = false;
  }

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal);
    if (this.exitOnKill && !this.exited) {
      queueMicrotask(() => {
        this.emitExit(FAKE_SHELL_EXIT_ON_HUP);
      });
    }
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListeners.push(listener);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    this.exited = true;
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal: null });
    }
  }
}

export interface FakeSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: LaunchOptions;
  readonly size: PtySize;
  readonly pty: FakePty;
}

export class FakeLaunchContainer implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  readonly spawn = unsupportedLaunch;
  readonly specs: SpawnSpec[] = [];
  readonly strayChildren: number[] = [];
  killMembersCalls = 0;
  onKillMembers: () => void = () => undefined;

  async launch<T extends LaunchedProcess>(
    spec: SpawnSpec,
    launcher: Launcher<T>,
  ): Promise<Launched<T>> {
    this.specs.push(spec);
    const launched = await launcher(spec.command, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
    });
    const ops: ContainerOps = {
      members: () =>
        Promise.resolve([
          ...(launched.hasExited() ? [] : [launched.pid]),
          ...this.strayChildren,
        ]),
      killMembers: () => {
        this.killMembersCalls += 1;
        this.strayChildren.splice(0);
        this.onKillMembers();
        return Promise.resolve();
      },
    };
    return { process: launched, ops };
  }

  sweepOrphans(): Promise<number> {
    return Promise.resolve(0);
  }
}

export interface ScheduledTimer {
  readonly delayMs: number;
  readonly run: () => void;
  active: boolean;
}

export class ManualTimers {
  readonly timers: ScheduledTimer[] = [];

  readonly schedule = (run: () => void, delayMs: number): CancelTimer => {
    const timer: ScheduledTimer = { delayMs, run, active: true };
    this.timers.push(timer);
    return () => {
      timer.active = false;
    };
  };

  activeCount(): number {
    return this.timers.filter((timer) => timer.active).length;
  }

  fireAll(): void {
    for (const timer of this.timers.filter((candidate) => candidate.active)) {
      timer.active = false;
      timer.run();
    }
  }
}

export interface TerminalRigOptions {
  readonly contained?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: NodeJS.ProcessEnv;
  readonly setting?: string | null;
  readonly detectShell?: (setting: string | null) => Promise<ShellCommand>;
  readonly launchFailure?: Error;
}

export interface TerminalRig {
  readonly service: TerminalService;
  readonly container: FakeLaunchContainer;
  readonly timers: ManualTimers;
  readonly spawns: FakeSpawn[];
  readonly events: RecordedEvent[];
  readonly settingReads: (string | null)[];
  spawnAt(index: number): FakeSpawn;
  folder(name?: string): Promise<string>;
  dispose(): Promise<void>;
}

export function fakeLauncherFactory(
  spawns: FakeSpawn[],
  failure: Error | undefined,
): PtyLauncherFactory {
  return (size) => (command, args, options) => {
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const pty = new FakePty(FAKE_PTY_FIRST_PID + spawns.length);
    spawns.push({ command, args, options, size, pty });
    return Promise.resolve(pty);
  };
}

class TempFolders {
  private readonly roots: string[] = [];

  async create(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "cw-terminal-"));
    this.roots.push(root);
    const folder = join(root, name);
    await mkdir(folder);
    return folder;
  }

  async removeAll(): Promise<void> {
    await Promise.all(
      this.roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }
}

export function createTerminalRig(
  options: TerminalRigOptions = {},
): TerminalRig {
  const container = new FakeLaunchContainer();
  const timers = new ManualTimers();
  const spawns: FakeSpawn[] = [];
  const events: RecordedEvent[] = [];
  const settingReads: (string | null)[] = [];
  const folders = new TempFolders();
  let runCounter = 0;
  const broadcast: ConnectionRegistry["broadcast"] = (event, payload) => {
    events.push({ event, payload });
  };
  const service = createTerminalService({
    container: options.contained === false ? null : container,
    launcher: fakeLauncherFactory(spawns, options.launchFailure),
    broadcast,
    readShellSetting: () => {
      const setting = options.setting ?? null;
      settingReads.push(setting);
      return Promise.resolve(setting);
    },
    detectShell: options.detectShell ?? (() => Promise.resolve(FAKE_SHELL)),
    platform: options.platform ?? "linux",
    parentEnv: options.parentEnv ?? {},
    newRunId: () => {
      runCounter += 1;
      return `term-${String(runCounter)}`;
    },
    schedule: timers.schedule,
  });
  return {
    service,
    container,
    timers,
    spawns,
    events,
    settingReads,
    spawnAt(index: number): FakeSpawn {
      const spawn = spawns[index];
      if (spawn === undefined) {
        throw new Error(`no shell was spawned at index ${String(index)}`);
      }
      return spawn;
    },
    folder: (name = "work") => folders.create(name),
    async dispose(): Promise<void> {
      await service.shutdown();
      await folders.removeAll();
    },
  };
}

export interface TerminalClient {
  readonly events: IpcEvent[];
  request<M extends RequestMethod>(
    method: M,
    params: ParamsMap[M],
  ): Promise<IpcResponse>;
  close(): void;
}

export interface BackendTerminalRig {
  readonly backend: Backend;
  readonly registry: ConnectionRegistry;
  readonly spawns: FakeSpawn[];
  readonly cwd: string;
  connect(): TerminalClient;
  dispose(): Promise<void>;
}

const BACKEND_RIG_SHELL = "/bin/sh";
const WINDOWS_SHELL_ENV_KEYS = ["SystemRoot", "ComSpec"] as const;

function rigParentEnv(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return { PATH: "/usr/bin", SHELL: BACKEND_RIG_SHELL };
  }
  return Object.fromEntries(
    WINDOWS_SHELL_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function connectClient(
  registry: ConnectionRegistry,
  openPorts: MessagePort[],
): TerminalClient {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  registry.connect(fromNodePort(port1));
  const events: IpcEvent[] = [];
  const responses = new Map<string, (response: IpcResponse) => void>();
  port2.on("message", (message: unknown) => {
    const event = EventSchema.safeParse(message);
    if (event.success) {
      events.push(event.data);
      return;
    }
    const response = ResponseSchema.parse(message);
    if (response.id !== null) {
      responses.get(response.id)?.(response);
    }
  });
  let requestCounter = 0;
  return {
    events,
    request: (method, params) => {
      requestCounter += 1;
      const id = `client-${String(requestCounter)}`;
      return new Promise<IpcResponse>((resolve) => {
        responses.set(id, resolve);
        port2.postMessage({ v: PROTOCOL_VERSION, id, method, params });
      });
    },
    close: () => {
      port2.close();
    },
  };
}

export async function createBackendTerminalRig(
  parentEnv: NodeJS.ProcessEnv = rigParentEnv(process.platform),
): Promise<BackendTerminalRig> {
  const userData = await makeTempDir();
  const cwd = await makeTempDir();
  const container = new FakeLaunchContainer();
  const spawns: FakeSpawn[] = [];
  const openPorts: MessagePort[] = [];
  let registry: ConnectionRegistry | null = null;
  const backend = await startBackend({
    args: { userData, testAgentEnv: null },
    vault: createFakeVault(),
    broadcast: (event, payload) => {
      registry?.broadcast(event, payload);
    },
    createContainer: () => Promise.resolve(container),
    execPath: "/usr/bin/node",
    adapterEntry: "/opt/adapter/entry.js",
    parentEnv,
    homeDir: "/home/jane",
    platform: process.platform,
    now: () => 0,
    schedule: () => () => undefined,
    newRunId: () => `run-${String(spawns.length + 1)}`,
    resolveExecutable: () => "/usr/bin/claude",
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    ptyLauncher: fakeLauncherFactory(spawns, undefined),
  });
  const wired = createBackendRegistry(backend);
  registry = wired;
  return {
    backend,
    registry: wired,
    spawns,
    cwd,
    connect: () => connectClient(wired, openPorts),
    async dispose(): Promise<void> {
      for (const port of openPorts.splice(0)) {
        port.close();
      }
      await backend.shutdown();
    },
  };
}
