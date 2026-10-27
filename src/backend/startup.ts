import { statSync } from "node:fs";

import type { RotationPorts } from "../domain/rotation";
import type { EpochMillis, WorktreeState } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartSpec,
} from "./agentAdapter";
import { createAgentProcesses } from "./agentProcesses";
import type { BackendArgs } from "./args";
import { createClaudeAcpAdapter } from "./claude/acpAdapter";
import type { ConnectionRegistry } from "./connections";
import {
  AGENT_STOP_GRACE_MS,
  CLAUDE_BINARY,
  CONTAINER_UNAVAILABLE_MESSAGE,
} from "./constants";
import { buildAgentEnv } from "./env";
import { resolveExecutable } from "./executable";
import { createHandlers } from "./handlers";
import { recordInstance } from "./instance";
import type { IpcHandlers } from "./ipcServer";
import { WorktreeLocks } from "./locks";
import {
  ContainerUnavailableError,
  type ProcessContainer,
} from "./process/container";
import {
  createSessionService,
  type ContainerStatus,
  type SessionService,
} from "./session";
import { createJsonStore } from "./storage";

export interface BackendDeps {
  readonly args: BackendArgs;
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly createContainer: (instanceId: string) => Promise<ProcessContainer>;
  readonly execPath: string;
  readonly adapterEntry: string;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly now: () => EpochMillis;
  readonly schedule: RotationPorts["schedule"];
  readonly newRunId: () => string;
  readonly resolveClaudeExecutable: (configured: string | null) => string;
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
}

export interface Backend {
  readonly handlers: IpcHandlers;
  shutdown(): Promise<void>;
}

interface OpenedContainer {
  readonly container: ProcessContainer | null;
  readonly status: ContainerStatus;
}

const UNAVAILABLE_ADAPTER: AgentAdapter = {
  start: () =>
    Promise.resolve({
      ok: false,
      reason: AgentStartFailure.error,
      message: CONTAINER_UNAVAILABLE_MESSAGE,
    }),
};

async function openContainer(
  deps: BackendDeps,
  instanceId: string,
  stale: readonly string[],
): Promise<OpenedContainer> {
  try {
    const container = await deps.createContainer(instanceId);
    await container.sweepOrphans(stale).catch((error: unknown) => {
      console.error("sweeping orphaned agent processes failed", error);
    });
    return { container, status: { available: true, message: null } };
  } catch (error) {
    if (error instanceof ContainerUnavailableError) {
      console.warn("process container is unavailable", error);
      return {
        container: null,
        status: { available: false, message: error.message },
      };
    }
    throw error;
  }
}

function createAdapter(
  deps: BackendDeps,
  container: ProcessContainer | null,
): AgentAdapter {
  if (container === null) {
    return UNAVAILABLE_ADAPTER;
  }
  const { testAgentEnv } = deps.args;
  return createClaudeAcpAdapter({
    processes: createAgentProcesses({
      container,
      locks: new WorktreeLocks(),
      onFailure: (failure) => {
        console.error(
          `agent ${failure.runId} left processes behind: ${failure.survivors.join(",")}`,
        );
      },
    }),
    envFor: (spec: AgentStartSpec) =>
      buildAgentEnv({
        parent: deps.parentEnv,
        platform: deps.platform,
        homeDir: deps.homeDir,
        account: spec.account,
        claudeExecutable: spec.claudeExecutable,
        runMarker: spec.runId,
        ...(testAgentEnv === null ? {} : { overrides: testAgentEnv }),
        testMode: testAgentEnv !== null,
      }),
    execPath: deps.execPath,
    adapterEntry: deps.adapterEntry,
  });
}

export function createClaudeExecutableResolver(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): (configured: string | null) => string {
  return (configured) => {
    const found = resolveExecutable(configured ?? CLAUDE_BINARY, {
      pathEnv: env.PATH ?? "",
      pathExt: env.PATHEXT,
      platform,
      isFile: (path) =>
        statSync(path, { throwIfNoEntry: false })?.isFile() === true,
    });
    if (found === null) {
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        "The Claude executable was not found",
      );
    }
    return found;
  };
}

export async function startBackend(deps: BackendDeps): Promise<Backend> {
  const { userData } = deps.args;
  const store = createJsonStore(userData);
  const instance = await recordInstance(userData);
  const { container, status } = await openContainer(
    deps,
    instance.current,
    instance.previous,
  );
  const sessions: SessionService = createSessionService({
    adapter: createAdapter(deps, container),
    store,
    broadcast: deps.broadcast,
    now: deps.now,
    schedule: deps.schedule,
    inspectWorktree: deps.inspectWorktree,
    newRunId: deps.newRunId,
    resolveClaudeExecutable: deps.resolveClaudeExecutable,
    stopGraceMs: AGENT_STOP_GRACE_MS,
    containerStatus: status,
  });
  return {
    handlers: createHandlers({
      store,
      userData,
      broadcast: deps.broadcast,
      sessions,
      containerStatus: status,
    }),
    shutdown: () => sessions.shutdown(),
  };
}
