import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { API_PROVIDERS } from "../domain/apiProviders";
import type { RotationPorts } from "../domain/rotation";
import {
  ProviderId,
  type Account,
  type EpochMillis,
  type WorktreeState,
} from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartSpec,
} from "./agentAdapter";
import { createAgentProcesses, type AgentProcesses } from "./agentProcesses";
import type { BackendArgs } from "./args";
import { createClaudeAcpAdapter } from "./claude/acpAdapter";
import { createCodexAdapter } from "./codex/adapter";
import { createCodexLimitProbe } from "./codex/probe";
import type { ConnectionRegistry } from "./connections";
import {
  AGENT_STOP_GRACE_MS,
  API_KEYS_FILE,
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
import { createOpencodeAdapter } from "./opencode/adapter";
import {
  CATALOG_DIR_NAME,
  CATALOG_RUN_ID_PREFIX,
  createModelCatalog,
  type ModelCatalogService,
} from "./opencode/catalog";
import {
  defaultRuntimeRoot,
  type OpencodeCredentials,
} from "./opencode/config";
import { findFreePort } from "./opencode/port";
import {
  ContainerUnavailableError,
  type ProcessContainer,
} from "./process/container";
import { createProviderAdapter } from "./providerAdapter";
import { createKeyStore, type KeyStore } from "./secrets/keyStore";
import { createSecretSource } from "./secrets/source";
import type { SecretVault } from "./secrets/vault";
import {
  createSessionService,
  type ContainerStatus,
  type SessionService,
} from "./session";
import { createJsonStore, type JsonStore } from "./storage";

export interface BackendDeps {
  readonly args: BackendArgs;
  readonly vault: SecretVault;
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
  readonly catalogProbeTimeoutMs?: number;
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

const OPENCODE_BINARY = "opencode";
const SERVER_PASSWORD_BYTES = 32;

const UNAVAILABLE_CATALOG: ModelCatalogService = {
  load: () =>
    Promise.resolve({ models: [], error: CONTAINER_UNAVAILABLE_MESSAGE }),
};

function newServerPassword(): string {
  return randomBytes(SERVER_PASSWORD_BYTES).toString("hex");
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

function createProcesses(container: ProcessContainer): AgentProcesses {
  return createAgentProcesses({
    container,
    locks: new WorktreeLocks(),
    onFailure: (failure) => {
      console.error(
        `agent ${failure.runId} left processes behind: ${failure.survivors.join(",")}`,
      );
    },
  });
}

function comSpecOf(deps: BackendDeps): { comSpec?: string } {
  return deps.parentEnv.ComSpec === undefined
    ? {}
    : { comSpec: deps.parentEnv.ComSpec };
}

export function createCredentialsFor(
  keyStore: KeyStore,
): (account: Account) => Promise<OpencodeCredentials | null> {
  return async (account) => {
    const { api } = account;
    if (api === undefined) {
      return null;
    }
    let apiKey: string | null;
    try {
      apiKey = await keyStore.get(account.id);
    } catch (error) {
      console.error(`the stored key of ${account.id} cannot be read`, error);
      return null;
    }
    return apiKey === null
      ? null
      : {
          providerId: API_PROVIDERS[api.provider].opencodeId,
          model: api.model,
          baseUrl: api.baseUrl,
          apiKey,
        };
  };
}

function createAdapter(
  deps: BackendDeps,
  processes: AgentProcesses | null,
  keyStore: KeyStore,
): AgentAdapter {
  if (processes === null) {
    return UNAVAILABLE_ADAPTER;
  }
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
      ...comSpecOf(deps),
    }),
    [ProviderId.opencode]: createOpencodeAdapter({
      processes,
      envFor,
      executableFor: (spec) => spec.executable,
      credentialsFor: createCredentialsFor(keyStore),
      runtimeRoot: defaultRuntimeRoot(deps.parentEnv),
      platform: deps.platform,
      ...comSpecOf(deps),
      fetchImpl: fetch,
      now: deps.now,
      freePort: findFreePort,
      newPassword: newServerPassword,
    }),
  });
}

function createCatalog(
  deps: BackendDeps,
  processes: AgentProcesses | null,
  store: JsonStore,
): ModelCatalogService {
  if (processes === null) {
    return UNAVAILABLE_CATALOG;
  }
  return createModelCatalog({
    processes,
    envFor: createEnvFor(deps),
    resolveExecutable: async () =>
      deps.resolveExecutable(
        ProviderId.opencode,
        (await store.readSettings()).opencodeExecutable,
      ),
    directory: join(deps.args.userData, CATALOG_DIR_NAME),
    platform: deps.platform,
    ...comSpecOf(deps),
    fetchImpl: fetch,
    freePort: findFreePort,
    newPassword: newServerPassword,
    newRunId: () => `${CATALOG_RUN_ID_PREFIX}${randomUUID()}`,
    stopGraceMs: AGENT_STOP_GRACE_MS,
    ...(deps.catalogProbeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: deps.catalogProbeTimeoutMs }),
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
    [ProviderId.opencode]: {
      binary: OPENCODE_BINARY,
      notFoundMessage: "The OpenCode executable was not found",
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
  const keyStore = createKeyStore({
    path: join(userData, API_KEYS_FILE),
    vault: deps.vault,
  });
  await keyStore.ready().catch((error: unknown) => {
    console.error("the API key store could not be loaded", error);
  });
  const instance = await recordInstance(userData);
  const { container, status } = await openContainer(
    deps,
    instance.current,
    instance.previous,
  );
  const probes = createProbes(deps, container, store, (accountId) =>
    sessions.isInUse(accountId),
  );
  const processes = container === null ? null : createProcesses(container);
  const sessions: SessionService = createSessionService({
    adapter: createAdapter(deps, processes, keyStore),
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
    hasKey: (accountId) => keyStore.hint(accountId) !== null,
    secrets: createSecretSource(keyStore),
  });
  const handlers = createHandlers({
    store,
    keyStore,
    vault: deps.vault,
    userData,
    broadcast: deps.broadcast,
    sessions,
    probes,
    catalog: createCatalog(deps, processes, store),
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
