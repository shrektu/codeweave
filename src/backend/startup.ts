import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

import type { RotationPorts } from "../domain/rotation";
import {
  ProviderId,
  type EpochMillis,
  type WorktreeState,
} from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartSpec,
} from "./agentAdapter";
import { createAgentProcesses } from "./agentProcesses";
import type { BackendArgs } from "./args";
import { createClaudeAcpAdapter } from "./claude/acpAdapter";
import { createCodexAdapter } from "./codex/adapter";
import { createCodexLimitProbe } from "./codex/probe";
import type { ConnectionRegistry } from "./connections";
import {
  AGENT_STOP_GRACE_MS,
  CLAUDE_BINARY,
  CODEX_BINARY,
  CONTAINER_UNAVAILABLE_MESSAGE,
  PROBE_RUN_ID_PREFIX,
  PROBE_TIMEOUT_MS,
} from "./constants";
import { buildAgentEnv } from "./env";
import { resolveExecutable } from "./executable";
import { createHandlers } from "./handlers";
import { recordInstance } from "./instance";
import type { IpcHandlers } from "./ipcServer";
import { createLimitProbeService, type LimitProbeService } from "./limitProbe";
import { WorktreeLocks } from "./locks";
import {
  ContainerUnavailableError,
  type ProcessContainer,
} from "./process/container";
import { createProviderAdapter } from "./providerAdapter";
import {
  createSessionService,
  type ContainerStatus,
  type SessionService,
} from "./session";
import { createJsonStore, type JsonStore } from "./storage";

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
  readonly resolveExecutable: (
    provider: ProviderId,
    configured: string | null,
  ) => string;
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

const NO_PROBES: LimitProbeService = {
  start: () => undefined,
  trigger: () => undefined,
  release: () => Promise.resolve(),
  isBlocked: () => false,
  limitOf: () => null,
  runtimeOf: () => null,
  onChanged: () => () => undefined,
  dispose: () => Promise.resolve(),
};

function createEnvFor(
  deps: BackendDeps,
): (spec: AgentStartSpec) => Record<string, string> {
  const { testAgentEnv } = deps.args;
  return (spec) =>
    buildAgentEnv({
      parent: deps.parentEnv,
      platform: deps.platform,
      homeDir: deps.homeDir,
      account: spec.account,
      executable: spec.executable,
      runMarker: spec.runId,
      ...(testAgentEnv === null ? {} : { overrides: testAgentEnv }),
      testMode: testAgentEnv !== null,
    });
}

function createProbes(
  deps: BackendDeps,
  container: ProcessContainer | null,
  store: JsonStore,
  isInUse: (accountId: string) => boolean,
): LimitProbeService {
  if (container === null) {
    return NO_PROBES;
  }
  return createLimitProbeService({
    readAccounts: () => store.readAccounts(),
    probe: createCodexLimitProbe({
      container,
      envFor: createEnvFor(deps),
      executable: async () =>
        deps.resolveExecutable(
          ProviderId.codex,
          (await store.readSettings()).codexExecutable,
        ),
      platform: deps.platform,
      comSpec: deps.parentEnv.ComSpec,
      timeoutMs: PROBE_TIMEOUT_MS,
      stopGraceMs: AGENT_STOP_GRACE_MS,
      newRunId: () => `${PROBE_RUN_ID_PREFIX}${randomUUID()}`,
    }),
    isInUse,
    now: deps.now,
    schedule: deps.schedule,
  });
}

function createAdapter(
  deps: BackendDeps,
  container: ProcessContainer | null,
): AgentAdapter {
  if (container === null) {
    return UNAVAILABLE_ADAPTER;
  }
  const processes = createAgentProcesses({
    container,
    locks: new WorktreeLocks(),
    onFailure: (failure) => {
      console.error(
        `agent ${failure.runId} left processes behind: ${failure.survivors.join(",")}`,
      );
    },
  });
  const envFor = createEnvFor(deps);
  return createProviderAdapter({
    [ProviderId.claude]: createClaudeAcpAdapter({
      processes,
      envFor,
      execPath: deps.execPath,
      adapterEntry: deps.adapterEntry,
    }),
    [ProviderId.codex]: createCodexAdapter({
      processes,
      envFor,
      executableFor: (spec) => spec.executable,
      platform: deps.platform,
      ...(deps.parentEnv.ComSpec === undefined
        ? {}
        : { comSpec: deps.parentEnv.ComSpec }),
    }),
  });
}

interface ExecutableSpec {
  readonly binary: string;
  readonly notFoundMessage: string;
}

const EXECUTABLE_SPECS: Readonly<Partial<Record<ProviderId, ExecutableSpec>>> =
  {
    [ProviderId.claude]: {
      binary: CLAUDE_BINARY,
      notFoundMessage: "The Claude executable was not found",
    },
    [ProviderId.codex]: {
      binary: CODEX_BINARY,
      notFoundMessage: "The Codex executable was not found",
    },
  };

export function createExecutableResolver(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): (provider: ProviderId, configured: string | null) => string {
  return (provider, configured) => {
    const spec = EXECUTABLE_SPECS[provider];
    if (spec === undefined) {
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        `Provider ${provider} is not supported`,
      );
    }
    const found = resolveExecutable(configured ?? spec.binary, {
      pathEnv: env.PATH ?? "",
      pathExt: env.PATHEXT,
      platform,
      isFile: (path) =>
        statSync(path, { throwIfNoEntry: false })?.isFile() === true,
    });
    if (found === null) {
      throw new IpcError(IpcErrorCode.UNAVAILABLE, spec.notFoundMessage);
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
  const probes = createProbes(deps, container, store, (accountId) =>
    sessions.isInUse(accountId),
  );
  const sessions: SessionService = createSessionService({
    adapter: createAdapter(deps, container),
    store,
    broadcast: deps.broadcast,
    now: deps.now,
    schedule: deps.schedule,
    inspectWorktree: deps.inspectWorktree,
    newRunId: deps.newRunId,
    resolveExecutable: deps.resolveExecutable,
    stopGraceMs: AGENT_STOP_GRACE_MS,
    containerStatus: status,
    externalRuntime: (accountId) => probes.runtimeOf(accountId),
    beforeLaunch: (accountId) => probes.release(accountId),
    isBlocked: (accountId) => probes.isBlocked(accountId),
  });
  const handlers = createHandlers({
    store,
    userData,
    broadcast: deps.broadcast,
    sessions,
    probes,
    containerStatus: status,
  });
  probes.start();
  return {
    handlers,
    shutdown: async () => {
      await probes.dispose();
      await sessions.shutdown();
    },
  };
}
