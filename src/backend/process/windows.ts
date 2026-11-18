import { setTimeout as delay } from "node:timers/promises";

import {
  EMPTY_POLL_INTERVAL_MS,
  JOB_ASSIGN_EXIT_GRACE_MS,
  RUN_ID_ENV,
  RUN_ID_PATTERN,
  RUN_MARKER_SEPARATOR,
} from "../constants";

import {
  spawnChild as defaultSpawnChild,
  spawnContained,
  type SpawnChild,
} from "./contained";
import {
  ContainerKind,
  type Contained,
  type ContainerOps,
  type Launched,
  type Launcher,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessContainer,
  type SpawnSpec,
} from "./container";
import { JobApiError, type JobApi, type JobHandle } from "./jobApi";

export interface JobObjectDeps {
  readonly api: JobApi;
  readonly instanceId: string;
  readonly spawnChild?: SpawnChild;
  readonly kill?: (pid: number) => void;
}

const UNASSIGNED_MESSAGE = "process could not be assigned to its job";

function launchOptions(spec: SpawnSpec, instanceId: string): LaunchOptions {
  const base = {
    env: {
      ...spec.env,
      [RUN_ID_ENV]: `${instanceId}${RUN_MARKER_SEPARATOR}${spec.runId}`,
    },
    cwd: spec.cwd,
  };
  return spec.windowsVerbatimArguments === undefined
    ? base
    : { ...base, windowsVerbatimArguments: spec.windowsVerbatimArguments };
}

function defaultKill(pid: number): void {
  process.kill(pid);
}

function killQuietly(kill: (pid: number) => void, pid: number): void {
  try {
    kill(pid);
  } catch (error) {
    console.warn(`could not kill unassigned process ${String(pid)}`, error);
  }
}

async function exitsWithinGrace(target: LaunchedProcess): Promise<boolean> {
  for (
    let waited = 0;
    waited < JOB_ASSIGN_EXIT_GRACE_MS && !target.hasExited();
    waited += EMPTY_POLL_INTERVAL_MS
  ) {
    await delay(EMPTY_POLL_INTERVAL_MS);
  }
  return target.hasExited();
}

function assignmentFailure(
  api: JobApi,
  job: JobHandle,
  pid: number,
): Error | null {
  try {
    return api.assignPid(job, pid) ? null : new JobApiError(UNASSIGNED_MESSAGE);
  } catch (error) {
    return error instanceof Error
      ? error
      : new JobApiError(UNASSIGNED_MESSAGE, { cause: error });
  }
}

class JobOps implements ContainerOps {
  private open = true;
  private readonly api: JobApi;
  private readonly job: JobHandle;

  constructor(api: JobApi, job: JobHandle) {
    this.api = api;
    this.job = job;
  }

  members(): Promise<readonly number[]> {
    if (!this.open) {
      return Promise.resolve([]);
    }
    const pids = this.api.pids(this.job);
    if (pids.length === 0) {
      this.open = false;
      this.api.close(this.job);
    }
    return Promise.resolve(pids);
  }

  killMembers(): Promise<void> {
    if (this.open) {
      this.api.terminate(this.job);
    }
    return Promise.resolve();
  }
}

class JobObjectContainer implements ProcessContainer {
  readonly kind = ContainerKind.jobObject;

  private readonly deps: JobObjectDeps;

  constructor(deps: JobObjectDeps) {
    this.deps = deps;
  }

  spawn(spec: SpawnSpec): Promise<Contained> {
    return spawnContained(
      this,
      spec,
      this.deps.spawnChild ?? defaultSpawnChild,
    );
  }

  async launch<T extends LaunchedProcess>(
    spec: SpawnSpec,
    launcher: Launcher<T>,
  ): Promise<Launched<T>> {
    if (!RUN_ID_PATTERN.test(spec.runId)) {
      throw new RangeError(`Invalid run id: ${spec.runId}`);
    }
    const { api, instanceId } = this.deps;
    const job = api.createJob();
    let launched: T;
    try {
      launched = await launcher(
        spec.command,
        spec.args,
        launchOptions(spec, instanceId),
      );
    } catch (error) {
      api.close(job);
      throw error;
    }
    const failure = assignmentFailure(api, job, launched.pid);
    if (failure !== null && !(await exitsWithinGrace(launched))) {
      killQuietly(this.deps.kill ?? defaultKill, launched.pid);
      api.close(job);
      throw failure;
    }
    return { process: launched, ops: new JobOps(api, job) };
  }

  sweepOrphans(): Promise<number> {
    return Promise.resolve(0);
  }
}

export function createJobObjectContainer(
  deps: JobObjectDeps,
): ProcessContainer {
  return new JobObjectContainer(deps);
}

export function enterAppJob(api: JobApi): JobHandle | null {
  try {
    const job = api.createJob();
    try {
      api.assignSelf(job);
    } catch (error) {
      api.close(job);
      throw error;
    }
    return job;
  } catch (error) {
    console.warn("backend could not enter its own job object", error);
    return null;
  }
}
