import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { API_PROVIDERS, ApiAuth } from "../domain/apiProviders";
import type { RotationPorts } from "../domain/rotation";
import {
  LimitAvailability,
  PermissionProfile,
  ProviderId,
  type Account,
  type EpochMillis,
  type WorktreeState,
} from "../domain/types";
import { EXECUTABLE_SETTING_LABELS } from "../shared/constants";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type { FlowsList } from "../shared/views";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartSpec,
} from "./agentAdapter";
import { createAgentProcesses, type AgentProcesses } from "./agentProcesses";
import { createAgyAdapter } from "./agy/adapter";
import { locateAgyHookEntry, writeAgyHookConfig } from "./agy/hookConfig";
import { probeAgyUsage, type AgyProbeResult } from "./agy/usage";
import { fingerprintAgentsDir } from "./agy/workspaceGuard";
import type { BackendArgs } from "./args";
import { createClaudeAcpAdapter } from "./claude/acpAdapter";
import {
  createClaudeUsageProbe,
  type ClaudeUsageProbe,
} from "./claude/usageProbe";
import { createCodexAdapter } from "./codex/adapter";
import { createCodexLimitProbe } from "./codex/probe";
import {
  createConnectionRegistry,
  type ConnectionRegistry,
} from "./connections";
import {
  AGENT_STOP_GRACE_MS,
  AGY_BINARY,
  API_KEYS_FILE,
  ATTACHMENTS_DIR,
  CLAUDE_BINARY,
  CHECKPOINT_MAX_SESSION_BYTES,
  CHECKPOINTS_DIR,
  CODEX_BINARY,
  CONTAINER_UNAVAILABLE_MESSAGE,
  PROBE_RUN_ID_PREFIX,
  PROBE_TIMEOUT_MS,
  SESSIONS_DIR,
} from "./constants";
import { createAttachmentStore } from "./attachmentStore";
import { createCheckpointRecorder } from "./checkpointRecorder";
import { createCheckpointStore } from "./checkpointStore";
import { buildAgentEnv } from "./env";
import { resolveExecutable } from "./executable";
import { execText } from "./exec";
import { createDefinitionRoots } from "./definitionLibrary";
import { createEditedFilesTracker } from "./editedFiles";
import { listFlows } from "./flows";
import { createFlowRunService, type FlowRunService } from "./flowRuns";
import type { FlowToolServer } from "./flowTools/server";
import { createFlowWorktrees } from "./flowWorktrees";
import { createHandlers } from "./handlers";
import { resolveSessionFolder } from "./workspace";
import { recordInstance } from "./instance";
import type { IpcHandlers } from "./ipcServer";
import {
  createLimitProbeService,
  type ConsoleProbeResult,
  type LimitProbeService,
} from "./limitProbe";
import { createLeaseModes, type LeaseModes } from "./leaseModes";
import {
  LeaseMode,
  resolveLockKey,
  WorktreeLocks,
  type LockKeyResolver,
} from "./locks";
import { createOrchestratorService } from "./orchestrator/service";
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
import {
  ConsoleLoginState,
  type ConsoleLoginProbe,
} from "./opencode/consoleLogin";
import {
  type ConsoleUsageProbe,
  type ConsoleUsageResult,
} from "./opencode/consoleUsage";
import { OpencodeGeneration } from "./opencode/constants";
import { findFreePort } from "./opencode/port";
import type { GenerationProbe } from "./opencode/version";
import {
  ContainerUnavailableError,
  type ProcessContainer,
} from "./process/container";
import { protectedPaths } from "./protectedPaths";
import { createProviderAdapter } from "./providerAdapter";
import { createKeyStore, type KeyStore } from "./secrets/keyStore";
import { createSecretSource } from "./secrets/source";
import type { SecretVault } from "./secrets/vault";
import type { ContainerStatus } from "./session";
import { createSessionHistory } from "./sessionHistory";
import { createSessionPool, type SessionPool } from "./sessionPool";
import {
  configuredExecutable,
  toUpdaterConfigMessage,
  type PostUpdaterConfig,
} from "./settingsService";
import { createJsonStore, type JsonStore } from "./storage";
import { createPtyLauncher, type PtyLauncherFactory } from "./terminal/pty";
import {
  createTerminalService,
  type TerminalService,
} from "./terminal/service";
import { createShellDetector } from "./terminal/shell";

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
  readonly opencodeGeneration: GenerationProbe;
  readonly opencodeConsoleLogin: ConsoleLoginProbe;
  readonly opencodeConsoleUsage: ConsoleUsageProbe;
  readonly catalogProbeTimeoutMs?: number;
  readonly ptyLauncher?: PtyLauncherFactory;
  readonly resolveLockKey?: LockKeyResolver;
  readonly postUpdaterConfig?: PostUpdaterConfig;
  readonly startToolServer?: () => Promise<FlowToolServer>;
}

export interface Backend {
  readonly handlers: IpcHandlers;
  readonly onConnectionClosed: () => void;
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

const NO_UPDATER_CONFIG: PostUpdaterConfig = () => undefined;

const OPENCODE_BINARY = "opencode";
const SERVER_PASSWORD_BYTES = 32;

const UNAVAILABLE_CATALOG: ModelCatalogService = {
  load: () =>
    Promise.resolve({ models: [], error: CONTAINER_UNAVAILABLE_MESSAGE }),
};

const CLAUDE_PROBE_TIME_ZONE = "UTC";

function probeLockKey(configDir: string): Promise<string> {
  return Promise.resolve(configDir);
}

const CONSOLE_LOGIN_KINDS: Readonly<
  Record<
    Exclude<ConsoleLoginState, typeof ConsoleLoginState.loggedIn>,
    ConsoleProbeResult
  >
> = {
  [ConsoleLoginState.needsLogin]: { kind: "needs_login" },
  [ConsoleLoginState.failed]: { kind: "failed" },
};

function consoleResultOf(usage: ConsoleUsageResult): ConsoleProbeResult {
  switch (usage.kind) {
    case "limits":
      return { kind: "limits", limits: usage.windows };
    case "none":
      return { kind: "no_limits" };
    case "failed":
      return { kind: "failed" };
  }
}

function newServerPassword(): string {
  return randomBytes(SERVER_PASSWORD_BYTES).toString("hex");
}

const NO_PROBES: LimitProbeService = {
  start: () => undefined,
  trigger: () => undefined,
  release: () => Promise.resolve(),
  isBlocked: () => false,
  limitOf: () => null,
  availabilityOf: () => LimitAvailability.failed,
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

function createAgyLimitProbe(
  deps: BackendDeps,
  container: ProcessContainer,
  store: JsonStore,
): (account: Account, signal: AbortSignal) => Promise<AgyProbeResult> {
  const envFor = createEnvFor(deps);
  return async (account, signal) => {
    const executable = deps.resolveExecutable(
      ProviderId.gemini,
      (await store.readSettings()).agyExecutable,
    );
    const runId = `${PROBE_RUN_ID_PREFIX}${randomUUID()}`;
    return probeAgyUsage({
      container,
      executable,
      configDir: account.configDir,
      cwd: account.configDir,
      env: envFor({
        account,
        cwd: account.configDir,
        profile: PermissionProfile.plan,
        runId,
        executable,
      }),
      runId,
      timeoutMs: PROBE_TIMEOUT_MS,
      stopGraceMs: AGENT_STOP_GRACE_MS,
      signal,
    });
  };
}

function createConsoleLimitProbe(
  deps: BackendDeps,
  store: JsonStore,
): (account: Account, signal: AbortSignal) => Promise<ConsoleProbeResult> {
  const envFor = createEnvFor(deps);
  return async (account, signal) => {
    const executable = deps.resolveExecutable(
      ProviderId.opencode,
      (await store.readSettings()).opencodeExecutable,
    );
    const env = envFor({
      account,
      cwd: account.configDir,
      profile: PermissionProfile.plan,
      runId: `${PROBE_RUN_ID_PREFIX}${randomUUID()}`,
      executable,
    });
    const generation = await deps.opencodeGeneration(executable, {
      env,
      cwd: account.configDir,
    });
    if (generation === OpencodeGeneration.v1) {
      return { kind: "needs_login" };
    }
    const input = { executable, configDir: account.configDir, env, signal };
    const state = await deps.opencodeConsoleLogin(input);
    if (state !== ConsoleLoginState.loggedIn) {
      return CONSOLE_LOGIN_KINDS[state];
    }
    return consoleResultOf(await deps.opencodeConsoleUsage(input));
  };
}

function createClaudeLimitProbe(
  deps: BackendDeps,
  container: ProcessContainer,
  store: JsonStore,
): ClaudeUsageProbe {
  const envFor = createEnvFor(deps);
  return createClaudeUsageProbe({
    adapter: createClaudeAcpAdapter({
      processes: createProcesses(container, probeLockKey, createLeaseModes()),
      envFor: (spec) => ({
        ...envFor(spec),
        TZ: CLAUDE_PROBE_TIME_ZONE,
      }),
      execPath: deps.execPath,
      adapterEntry: deps.adapterEntry,
    }),
    executable: async () =>
      deps.resolveExecutable(
        ProviderId.claude,
        configuredExecutable(await store.readSettings(), ProviderId.claude),
      ),
    timeoutMs: PROBE_TIMEOUT_MS,
    stopGraceMs: AGENT_STOP_GRACE_MS,
    newRunId: () => `${PROBE_RUN_ID_PREFIX}${randomUUID()}`,
    now: deps.now,
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
    agyProbe: createAgyLimitProbe(deps, container, store),
    consoleProbe: createConsoleLimitProbe(deps, store),
    claudeProbe: createClaudeLimitProbe(deps, container, store),
    isInUse,
    now: deps.now,
    schedule: deps.schedule,
  });
}

function createProcesses(
  container: ProcessContainer,
  resolveLockKey: LockKeyResolver,
  leaseModes: LeaseModes,
  locks: WorktreeLocks = new WorktreeLocks(),
): AgentProcesses {
  return createAgentProcesses({
    container,
    locks,
    resolveLockKey,
    leaseModeOf: (runId) => leaseModes.modeOf(runId),
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
    if (api.auth === ApiAuth.consoleLogin) {
      return {
        auth: ApiAuth.consoleLogin,
        providerId: API_PROVIDERS[api.provider].opencodeId,
        model: api.model,
        baseUrl: null,
      };
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
          auth: ApiAuth.apiKey,
          providerId: API_PROVIDERS[api.provider].opencodeId,
          model: api.model,
          baseUrl: api.baseUrl,
          apiKey,
        };
  };
}

function createAdapter(
  deps: BackendDeps,
  container: ProcessContainer | null,
  processes: AgentProcesses | null,
  keyStore: KeyStore,
  protectedPathsNow: () => Promise<readonly string[]>,
): AgentAdapter {
  if (processes === null || container === null) {
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
    [ProviderId.gemini]: createAgyAdapter({
      processes,
      container,
      envFor,
      executableFor: (spec) => spec.executable,
      writeHookConfig: (configDir) =>
        writeAgyHookConfig({
          configDir,
          execPath: deps.execPath,
          hookEntry: locateAgyHookEntry(),
          platform: deps.platform,
        }),
      fingerprintWorkspace: fingerprintAgentsDir,
      homeDir: deps.homeDir,
      protectedPaths: protectedPathsNow,
    }),
    [ProviderId.opencode]: createOpencodeAdapter({
      processes,
      envFor,
      executableFor: (spec) => spec.executable,
      credentialsFor: createCredentialsFor(keyStore),
      generationFor: deps.opencodeGeneration,
      consoleLoginFor: deps.opencodeConsoleLogin,
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
    generationFor: deps.opencodeGeneration,
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

function createTerminals(
  deps: BackendDeps,
  container: ProcessContainer | null,
  store: JsonStore,
  resolveLockKey: LockKeyResolver,
): TerminalService {
  return createTerminalService({
    resolveLockKey,
    container,
    launcher: deps.ptyLauncher ?? createPtyLauncher,
    broadcast: deps.broadcast,
    readShellSetting: async () => (await store.readSettings()).terminalShell,
    detectShell: createShellDetector(deps.platform, deps.parentEnv),
    platform: deps.platform,
    parentEnv: deps.parentEnv,
    newRunId: deps.newRunId,
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
  });
}

interface ExecutableSpec {
  readonly binary: string;
  readonly cliName: string;
}

const EXECUTABLE_SPECS: Readonly<Partial<Record<ProviderId, ExecutableSpec>>> =
  {
    [ProviderId.claude]: { binary: CLAUDE_BINARY, cliName: "Claude" },
    [ProviderId.codex]: { binary: CODEX_BINARY, cliName: "Codex" },
    [ProviderId.gemini]: { binary: AGY_BINARY, cliName: "agy" },
    [ProviderId.opencode]: { binary: OPENCODE_BINARY, cliName: "OpenCode" },
  };

function notFoundMessage(
  spec: ExecutableSpec,
  label: string,
  configured: string | null,
): string {
  return configured === null
    ? `The ${spec.cliName} CLI was not found. Install it and restart Codeweave, or set its full path under Settings → ${label}.`
    : `The ${spec.cliName} CLI was not found at "${configured}". Correct Settings → ${label}, or clear it so Codeweave searches PATH again.`;
}

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
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        notFoundMessage(spec, EXECUTABLE_SETTING_LABELS[provider], configured),
      );
    }
    return found;
  };
}

export function createBackendRegistry(backend: Backend): ConnectionRegistry {
  return createConnectionRegistry(backend.handlers, backend.onConnectionClosed);
}

async function postStoredUpdaterConfig(
  store: JsonStore,
  post: PostUpdaterConfig,
): Promise<void> {
  try {
    post(toUpdaterConfigMessage(await store.readSettings()));
  } catch (error) {
    console.error("the updater configuration could not be posted", error);
  }
}

export async function startBackend(deps: BackendDeps): Promise<Backend> {
  const { userData } = deps.args;
  const postUpdaterConfig = deps.postUpdaterConfig ?? NO_UPDATER_CONFIG;
  const store = createJsonStore(userData);
  const history = createSessionHistory({
    dir: join(userData, SESSIONS_DIR),
    now: deps.now,
    broadcast: (event, entry) => {
      deps.broadcast(event, entry);
    },
  });
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
  const lockKeyResolver = deps.resolveLockKey ?? resolveLockKey;
  const leaseModes = createLeaseModes();
  const locks = new WorktreeLocks();
  const processes =
    container === null
      ? null
      : createProcesses(container, lockKeyResolver, leaseModes, locks);
  const protectedPathsNow = async (): Promise<readonly string[]> =>
    protectedPaths({
      homeDir: deps.homeDir,
      userData,
      accountDirs: (await store.readAccounts()).map(
        (account) => account.configDir,
      ),
    });
  const resolveFolder = async (
    requested: string | undefined,
  ): Promise<string> =>
    resolveSessionFolder(requested, await store.readSettings(), deps.homeDir);
  let flowRunsRef: FlowRunService | null = null;
  const editedFiles = createEditedFilesTracker({
    ownerOf: (runId) =>
      flowRunsRef?.views().find((run) => run.runId === runId)?.ownerSessionId ??
      null,
    publish: (edits) => {
      deps.broadcast("editedFiles/changed", edits);
    },
  });
  const checkpoints = createCheckpointStore({
    dir: join(userData, CHECKPOINTS_DIR),
    maxSessionBytes: CHECKPOINT_MAX_SESSION_BYTES,
    protectedPaths: protectedPathsNow,
  });
  const attachments = createAttachmentStore({
    dir: join(userData, ATTACHMENTS_DIR),
  });
  const checkpointRecorder = createCheckpointRecorder({
    store: checkpoints,
    ownerOf: (runId) =>
      flowRunsRef?.views().find((run) => run.runId === runId)?.ownerSessionId ??
      null,
  });
  const sessions: SessionPool = createSessionPool({
    adapter: createAdapter(
      deps,
      container,
      processes,
      keyStore,
      protectedPathsNow,
    ),
    leaseModes,
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
    homeDir: deps.homeDir,
    resolveFolder,
    attachments,
    protectedPaths: protectedPathsNow,
    onMainView: (view, nativeSessions) => {
      editedFiles.observeMain(view);
      checkpointRecorder.observeMain(view);
      if (view !== null) {
        history.record(view, nativeSessions);
      }
    },
    onMainClosed: (sessionId) => {
      editedFiles.forget(sessionId);
      checkpointRecorder.forget(sessionId);
    },
    onRunView: (runId, view) => {
      editedFiles.observeRun(runId, view);
      checkpointRecorder.observeRun(runId, view);
    },
  });
  const terminals = createTerminals(deps, container, store, lockKeyResolver);
  const definitionRoots = createDefinitionRoots({ store, userData });
  const listProjectFlows = async (cwd?: string): Promise<FlowsList> =>
    listFlows(await definitionRoots(cwd));
  const flowRuns = createFlowRunService({
    sessions: (runId) => sessions.forRun(runId),
    releaseSessions: (runId) => sessions.release(runId),
    anyMainSessionLive: () => sessions.anyMainLive(),
    listFlows: listProjectFlows,
    inspectWorktree: deps.inspectWorktree,
    broadcast: deps.broadcast,
    newRunId: deps.newRunId,
  });
  flowRunsRef = flowRuns;
  const orchestrator = createOrchestratorService({
    sessions,
    flowRuns,
    flowWorktrees: createFlowWorktrees({ exec: execText }),
    listFlows: listProjectFlows,
    newRunId: deps.newRunId,
    inspectWorktree: deps.inspectWorktree,
    protectedPaths: protectedPathsNow,
    homeDir: deps.homeDir,
    platform: deps.platform,
    acquireMergeLock: (key) => locks.acquire(key, LeaseMode.exclusive),
    resolveLockKey: lockKeyResolver,
    ...(deps.startToolServer === undefined
      ? {}
      : { startToolServer: deps.startToolServer }),
  });
  const handlers = createHandlers({
    store,
    keyStore,
    vault: deps.vault,
    userData,
    homeDir: deps.homeDir,
    broadcast: deps.broadcast,
    sessions,
    history,
    inspectWorktree: deps.inspectWorktree,
    flowRuns,
    orchestrator,
    probes,
    catalog: createCatalog(deps, processes, store),
    containerStatus: status,
    terminals,
    postUpdaterConfig,
    editedFiles,
    checkpoints,
    attachments,
  });
  await postStoredUpdaterConfig(store, postUpdaterConfig);
  probes.start();
  return {
    handlers,
    onConnectionClosed: () => {
      terminals.detachAll();
    },
    shutdown: async () => {
      await terminals.shutdown();
      await probes.dispose();
      await orchestrator.shutdown();
      await flowRuns.shutdown();
      await sessions.shutdown();
      await history.flush();
    },
  };
}
