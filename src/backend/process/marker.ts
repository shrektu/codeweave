import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  EMPTY_POLL_INTERVAL_MS,
  MARKER_KILL_MAX_ROUNDS,
  PROC_MISSING_ERRNO_CODES,
  PROC_ROOT,
  RUN_ID_ENV,
  RUN_MARKER_SEPARATOR,
} from "../constants";

import {
  ContainerKind,
  type Contained,
  type ContainerOps,
  type Launched,
  type LaunchedProcess,
  type Launcher,
  type ProcessContainer,
  type SpawnSpec,
} from "./container";
import { spawnChild, spawnContained, type SpawnChild } from "./contained";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly marker: string | null;
}

export interface ProcessTable {
  list(): Promise<readonly ProcessEntry[]>;
}

export interface EnvMarkerDeps {
  readonly processTable: ProcessTable;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly spawnChild?: SpawnChild;
  readonly instanceId?: string;
  readonly selfPid?: number;
  readonly parentPid?: number;
}

const PID_DIRECTORY_PATTERN = /^\d+$/;
const STAT_FIELDS_AFTER_COMM_OFFSET = 2;
const STAT_PPID_INDEX = 1;
const ENV_ENTRY_SEPARATOR = "\0";
const ABSENT_PROCESS_CODE = "ESRCH";
const INIT_PID = 1;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function isIgnorableProcError(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && PROC_MISSING_ERRNO_CODES.includes(code);
}

function parseMarker(environ: string): string | null {
  const prefix = `${RUN_ID_ENV}=`;
  const entry = environ
    .split(ENV_ENTRY_SEPARATOR)
    .find((candidate) => candidate.startsWith(prefix));
  return entry === undefined ? null : entry.slice(prefix.length);
}

function instanceOf(marker: string): string {
  const separator = marker.indexOf(RUN_MARKER_SEPARATOR);
  return separator < 0 ? "" : marker.slice(0, separator);
}

function parseParentPid(stat: string): number {
  const fields = stat
    .slice(stat.lastIndexOf(")") + STAT_FIELDS_AFTER_COMM_OFFSET)
    .split(" ");
  return Number(fields[STAT_PPID_INDEX]);
}

async function readEntry(
  procRoot: string,
  pid: number,
): Promise<ProcessEntry | null> {
  const directory = join(procRoot, String(pid));
  try {
    const [stat, environ] = await Promise.all([
      readFile(join(directory, "stat"), "utf8"),
      readFile(join(directory, "environ"), "utf8"),
    ]);
    return { pid, ppid: parseParentPid(stat), marker: parseMarker(environ) };
  } catch (error) {
    if (isIgnorableProcError(error)) {
      return null;
    }
    throw error;
  }
}

export function createProcProcessTable(
  procRoot: string = PROC_ROOT,
): ProcessTable {
  return {
    async list(): Promise<readonly ProcessEntry[]> {
      const names = await readdir(procRoot);
      const entries = await Promise.all(
        names
          .filter((name) => PID_DIRECTORY_PATTERN.test(name))
          .map((name) => readEntry(procRoot, Number(name))),
      );
      return entries.filter((entry) => entry !== null);
    },
  };
}

class EnvMarkerContainer implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  private readonly liveMarkers = new Set<string>();
  private readonly instanceId: string;
  private readonly spawnChild: SpawnChild;
  private readonly selfPid: number;
  private readonly parentPid: number;

  private readonly deps: EnvMarkerDeps;

  constructor(deps: EnvMarkerDeps) {
    this.deps = deps;
    this.instanceId = deps.instanceId ?? randomUUID();
    this.spawnChild = deps.spawnChild ?? spawnChild;
    this.selfPid = deps.selfPid ?? process.pid;
    this.parentPid = deps.parentPid ?? process.ppid;
  }

  spawn(spec: SpawnSpec): Promise<Contained> {
    return spawnContained(this, spec, this.spawnChild);
  }

  async launch<T extends LaunchedProcess>(
    spec: SpawnSpec,
    launcher: Launcher<T>,
  ): Promise<Launched<T>> {
    const marker = `${this.instanceId}${RUN_MARKER_SEPARATOR}${spec.runId}`;
    const launched = await launcher(spec.command, spec.args, {
      env: { ...spec.env, [RUN_ID_ENV]: marker },
      cwd: spec.cwd,
      ...(spec.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: spec.windowsVerbatimArguments }),
    });
    this.liveMarkers.add(marker);
    return { process: launched, ops: this.opsFor(marker, launched) };
  }

  async sweepOrphans(staleInstanceIds: readonly string[]): Promise<number> {
    const stale = new Set(
      staleInstanceIds.filter((id) => id !== "" && id !== this.instanceId),
    );
    if (stale.size === 0) {
      return 0;
    }
    const table = await this.deps.processTable.list();
    const protectedPids = new Set([
      ...this.selfAndAncestors(table),
      ...this.parentTree(table),
    ]);
    const orphans = table.filter(
      (entry) =>
        entry.marker !== null &&
        stale.has(instanceOf(entry.marker)) &&
        !this.liveMarkers.has(entry.marker) &&
        !protectedPids.has(entry.pid),
    );
    for (const orphan of orphans) {
      this.killQuietly(orphan.pid);
    }
    return orphans.length;
  }

  private selfAndAncestors(table: readonly ProcessEntry[]): Set<number> {
    const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
    const chain = new Set<number>();
    let pid: number | undefined = this.selfPid;
    while (pid !== undefined && pid > 0 && !chain.has(pid)) {
      chain.add(pid);
      pid = parents.get(pid);
    }
    return chain;
  }

  private parentTree(table: readonly ProcessEntry[]): Set<number> {
    const tree = new Set<number>();
    if (this.parentPid <= INIT_PID) {
      return tree;
    }
    const pending = [this.parentPid];
    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
      if (!tree.has(pid)) {
        tree.add(pid);
        pending.push(
          ...table.filter((entry) => entry.ppid === pid).map((e) => e.pid),
        );
      }
    }
    return tree;
  }

  private opsFor(marker: string, launched: LaunchedProcess): ContainerOps {
    const members = async (): Promise<readonly number[]> => {
      const table = await this.deps.processTable.list();
      const pids = new Set(
        table.filter((entry) => entry.marker === marker).map((e) => e.pid),
      );
      if (launched.pid > 0 && !launched.hasExited()) {
        pids.add(launched.pid);
      }
      return [...pids];
    };
    return {
      members,
      killMembers: async () => {
        for (let round = 0; round < MARKER_KILL_MAX_ROUNDS; round += 1) {
          const pids = await members();
          if (pids.length === 0) {
            return;
          }
          pids.forEach((pid) => {
            this.killQuietly(pid);
          });
          await delay(EMPTY_POLL_INTERVAL_MS);
        }
      },
    };
  }

  private killQuietly(pid: number): void {
    try {
      this.deps.kill(pid, "SIGKILL");
    } catch (error) {
      if (errnoCode(error) !== ABSENT_PROCESS_CODE) {
        throw error;
      }
    }
  }
}

export function createEnvMarkerContainer(
  deps: EnvMarkerDeps,
): ProcessContainer {
  return new EnvMarkerContainer(deps);
}
