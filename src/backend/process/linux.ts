import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import {
  CGROUP_PROCS_FILE,
  CGROUP_ROOT,
  INSTANCE_ID_PATTERN,
  KILL_SIGNAL_ARG,
  RUN_ID_PATTERN,
  SCOPE_UNIT_GLOB,
  SCOPE_UNIT_PREFIX,
  SCOPE_UNIT_SUFFIX,
  SELF_CGROUP_FILE,
  SYSTEMCTL_BINARY,
  SYSTEMD_CALL_TIMEOUT_MS,
  SYSTEMD_RUN_BINARY,
  UNIT_NAME_SEPARATOR,
} from "../constants";
import { execText, type ExecText } from "../exec";
import { newInstanceId } from "../instance";

import {
  ContainerKind,
  type Contained,
  type ProcessContainer,
  type SpawnSpec,
} from "./container";
import {
  createContained,
  spawnChild,
  type ContainerOps,
  type SpawnChild,
} from "./contained";

export interface SystemdScopeDeps {
  readonly exec: ExecText;
  readonly spawnChild: SpawnChild;
  readonly readFile: (path: string) => Promise<string>;
  readonly instanceId: string;
}

const SYSTEMCTL_USER_ARGS = ["--user"] as const;

function unitFor(instanceId: string, runId: string): string {
  return `${SCOPE_UNIT_PREFIX}${instanceId}${UNIT_NAME_SEPARATOR}${runId}${SCOPE_UNIT_SUFFIX}`;
}

function instanceOfUnit(unit: string): string {
  return (
    unit.slice(SCOPE_UNIT_PREFIX.length).split(UNIT_NAME_SEPARATOR)[0] ?? ""
  );
}

export function buildSystemdRunArgs(
  spec: SpawnSpec,
  instanceId: string,
): string[] {
  return [
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    "-p",
    "KillMode=control-group",
    `--unit=${SCOPE_UNIT_PREFIX}${instanceId}${UNIT_NAME_SEPARATOR}${spec.runId}`,
    "--",
    spec.command,
    ...spec.args,
  ];
}

export function parseScopeUnits(listOutput: string): string[] {
  return listOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter(
      (name) =>
        name.startsWith(SCOPE_UNIT_PREFIX) && name.endsWith(SCOPE_UNIT_SUFFIX),
    );
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

class SystemdScopeContainer implements ProcessContainer {
  readonly kind = ContainerKind.systemdScope;

  private readonly deps: SystemdScopeDeps;

  constructor(deps: SystemdScopeDeps) {
    if (!INSTANCE_ID_PATTERN.test(deps.instanceId)) {
      throw new RangeError(`Invalid instance id: ${deps.instanceId}`);
    }
    this.deps = deps;
  }

  async spawn(spec: SpawnSpec): Promise<Contained> {
    if (!RUN_ID_PATTERN.test(spec.runId)) {
      throw new RangeError(`Invalid run id: ${spec.runId}`);
    }
    const child = await this.deps.spawnChild(
      SYSTEMD_RUN_BINARY,
      buildSystemdRunArgs(spec, this.deps.instanceId),
      { env: { ...spec.env }, cwd: spec.cwd },
    );
    return createContained(
      child,
      spec.runId,
      this.opsFor(unitFor(this.deps.instanceId, spec.runId)),
    );
  }

  async sweepOrphans(staleInstanceIds: readonly string[]): Promise<number> {
    const stale = new Set(
      staleInstanceIds.filter(
        (id) => INSTANCE_ID_PATTERN.test(id) && id !== this.deps.instanceId,
      ),
    );
    if (stale.size === 0) {
      return 0;
    }
    const [listing, selfCgroup] = await Promise.all([
      this.systemctl([
        "list-units",
        "--plain",
        "--no-legend",
        "--all",
        SCOPE_UNIT_GLOB,
      ]),
      this.deps.readFile(SELF_CGROUP_FILE),
    ]);
    const units = parseScopeUnits(listing).filter(
      (unit) => stale.has(instanceOfUnit(unit)) && !selfCgroup.includes(unit),
    );
    await Promise.all(units.map((unit) => this.killUnit(unit)));
    return units.length;
  }

  private systemctl(args: readonly string[]): Promise<string> {
    return this.deps.exec(SYSTEMCTL_BINARY, [...SYSTEMCTL_USER_ARGS, ...args], {
      timeoutMs: SYSTEMD_CALL_TIMEOUT_MS,
    });
  }

  private opsFor(unit: string): ContainerOps {
    return {
      members: () => this.membersOf(unit),
      killMembers: async () => {
        if ((await this.membersOf(unit)).length > 0) {
          await this.killUnit(unit);
        }
      },
    };
  }

  private async killUnit(unit: string): Promise<void> {
    await this.systemctl(["kill", KILL_SIGNAL_ARG, unit]).catch(
      (error: unknown) => {
        console.warn(`systemctl kill failed for ${unit}`, error);
      },
    );
  }

  private async membersOf(unit: string): Promise<readonly number[]> {
    const controlGroup = (
      await this.systemctl(["show", "-p", "ControlGroup", "--value", unit])
    ).trim();
    if (controlGroup === "") {
      return [];
    }
    try {
      const procs = await this.deps.readFile(
        posix.join(CGROUP_ROOT, controlGroup, CGROUP_PROCS_FILE),
      );
      return procs.split("\n").filter(Boolean).map(Number);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }
}

export function createSystemdScopeContainer(
  overrides: Partial<SystemdScopeDeps> = {},
): ProcessContainer {
  return new SystemdScopeContainer({
    exec: execText,
    spawnChild,
    readFile: (path) => readFile(path, "utf8"),
    instanceId: newInstanceId(),
    ...overrides,
  });
}
