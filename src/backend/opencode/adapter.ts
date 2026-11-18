import { mkdir } from "node:fs/promises";

import type { Account, EpochMillis } from "../../domain/types";
import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentHandle,
  type AgentStartResult,
  type AgentStartSpec,
} from "../agentAdapter";
import type { AgentProcess, AgentProcesses } from "../agentProcesses";
import { DEFAULT_STOP_GRACE_MS } from "../constants";

import { createOpencodeClient, type OpencodeClientOptions } from "./client";
import {
  buildSessionConfig,
  createRunFiles,
  removeRunFiles,
  type OpencodeCredentials,
  type RunFilesInput,
  type RunFiles,
} from "./config";
import {
  NEEDS_LOGIN_MESSAGE,
  READY_TIMEOUT_MS,
  STALE_GATE_GRACE_MS,
  OpencodeGeneration,
} from "./constants";
import { OpencodeHandle } from "./handle";
import { accountDirs, buildOpencodeLaunch } from "./launch";
import { createRedactor, type Redactor } from "./redact";
import { createOpencodeV2Client } from "./v2/client";
import { buildV2SessionConfig } from "./v2/config";
import { OpencodeV2Handle } from "./v2/handle";
import type { GenerationProbe } from "./version";
import { watchProcess, type ProcessWatch } from "./watch";

export interface OpencodeAdapterDeps {
  readonly processes: AgentProcesses;
  readonly envFor: (spec: AgentStartSpec) => Record<string, string>;
  readonly executableFor: (spec: AgentStartSpec) => string;
  readonly credentialsFor: (
    account: Account,
  ) => Promise<OpencodeCredentials | null>;
  readonly generationFor: GenerationProbe;
  readonly runtimeRoot: string;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => EpochMillis;
  readonly freePort: () => Promise<number>;
  readonly newPassword: () => string;
  readonly stopGraceMs?: number;
  readonly staleGateGraceMs?: number;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly warmUpTimeoutMs?: number;
}

interface LaunchedRun {
  readonly generation: OpencodeGeneration;
  readonly agentProcess: AgentProcess;
  readonly files: RunFiles;
  readonly watch: ProcessWatch;
  readonly redact: Redactor;
}

type OpencodeRunHandle = AgentHandle & { open(): Promise<void> };

interface HandleContext {
  readonly deps: OpencodeAdapterDeps;
  readonly startSpec: AgentStartSpec;
  readonly run: LaunchedRun;
  readonly credentials: OpencodeCredentials;
  readonly clientOptions: OpencodeClientOptions;
}

interface GenerationDriver {
  readonly buildConfig: RunFilesInput["buildConfig"];
  readonly createHandle: (context: HandleContext) => OpencodeRunHandle;
}

const GENERATION_DRIVERS: Readonly<
  Record<OpencodeGeneration, GenerationDriver>
> = {
  [OpencodeGeneration.v1]: {
    buildConfig: buildSessionConfig,
    createHandle: ({ deps, startSpec, run, clientOptions }) =>
      new OpencodeHandle({
        spec: startSpec,
        agentProcess: run.agentProcess,
        watch: run.watch,
        files: run.files,
        client: createOpencodeClient(clientOptions),
        redact: run.redact,
        now: deps.now,
        stopGraceMs: deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
        staleGateGraceMs: deps.staleGateGraceMs ?? STALE_GATE_GRACE_MS,
      }),
  },
  [OpencodeGeneration.v2]: {
    buildConfig: buildV2SessionConfig,
    createHandle: ({ deps, startSpec, run, credentials, clientOptions }) =>
      new OpencodeV2Handle({
        spec: startSpec,
        agentProcess: run.agentProcess,
        watch: run.watch,
        files: run.files,
        client: createOpencodeV2Client(clientOptions),
        redact: run.redact,
        now: deps.now,
        stopGraceMs: deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
        readyTimeoutMs: deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
        defaultModel: {
          id: credentials.model,
          providerID: credentials.providerId,
        },
      }),
  },
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunSecrets {
  readonly credentials: OpencodeCredentials;
  readonly password: string;
  readonly redact: Redactor;
}

async function spawnRun(
  deps: OpencodeAdapterDeps,
  spec: AgentStartSpec,
  secrets: RunSecrets,
  generation: OpencodeGeneration,
): Promise<LaunchedRun> {
  const port = await deps.freePort();
  const files = await createRunFiles({
    credentials: secrets.credentials,
    runtimeRoot: deps.runtimeRoot,
    buildConfig: GENERATION_DRIVERS[generation].buildConfig,
  });
  try {
    const launch = buildOpencodeLaunch({
      generation,
      executable: deps.executableFor(spec),
      configDir: spec.account.configDir,
      configFile: files.configFile,
      password: secrets.password,
      port,
      env: deps.envFor(spec),
      platform: deps.platform,
      comSpec: deps.comSpec,
    });
    const agentProcess = await deps.processes.start({
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd: spec.cwd,
      runId: spec.runId,
      ...(launch.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
    });
    return {
      generation,
      agentProcess,
      files,
      watch: watchProcess(agentProcess.contained),
      redact: secrets.redact,
    };
  } catch (error) {
    await removeRunFiles(files);
    throw error;
  }
}

function failure(message: string): AgentStartResult {
  return { ok: false, reason: AgentStartFailure.error, message };
}

async function abortStart(
  run: LaunchedRun,
  handle: OpencodeRunHandle | null,
  error: unknown,
  graceMs: number,
): Promise<AgentStartResult> {
  const tail = run.watch.stderrTail();
  try {
    await (handle?.stop(graceMs) ?? run.agentProcess.stop(graceMs));
  } catch (stopError) {
    console.error("stop after failed opencode start failed", stopError);
  } finally {
    await removeRunFiles(run.files);
  }
  const message = run.redact(messageOf(error));
  return failure(tail === "" ? message : `${message}\n${run.redact(tail)}`);
}

async function connectRun(
  deps: OpencodeAdapterDeps,
  startSpec: AgentStartSpec,
  run: LaunchedRun,
  secrets: RunSecrets,
): Promise<AgentStartResult> {
  let handle: OpencodeRunHandle | null = null;
  try {
    const baseUrl = await run.watch.listening(
      deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
    );
    handle = GENERATION_DRIVERS[run.generation].createHandle({
      deps,
      startSpec,
      run,
      credentials: secrets.credentials,
      clientOptions: {
        baseUrl,
        password: secrets.password,
        directory: startSpec.cwd,
        fetchImpl: deps.fetchImpl,
        ...(deps.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: deps.requestTimeoutMs }),
        ...(deps.warmUpTimeoutMs === undefined
          ? {}
          : { warmUpTimeoutMs: deps.warmUpTimeoutMs }),
      },
    });
    await handle.open();
    return { ok: true, handle };
  } catch (error) {
    return abortStart(
      run,
      handle,
      error,
      deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    );
  }
}

async function startWithCredentials(
  deps: OpencodeAdapterDeps,
  startSpec: AgentStartSpec,
  credentials: OpencodeCredentials,
): Promise<AgentStartResult> {
  const password = deps.newPassword();
  const secrets: RunSecrets = {
    credentials,
    password,
    redact: createRedactor([credentials.apiKey, password]),
  };
  let run: LaunchedRun;
  try {
    const dirs = accountDirs(startSpec.account.configDir);
    await Promise.all(
      Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })),
    );
    const generation = await deps.generationFor(deps.executableFor(startSpec), {
      env: { ...deps.envFor(startSpec), ...dirs },
      cwd: startSpec.cwd,
    });
    run = await spawnRun(deps, startSpec, secrets, generation);
  } catch (error) {
    return failure(secrets.redact(messageOf(error)));
  }
  return connectRun(deps, startSpec, run, secrets);
}

export function createOpencodeAdapter(deps: OpencodeAdapterDeps): AgentAdapter {
  return {
    async start(startSpec: AgentStartSpec): Promise<AgentStartResult> {
      let credentials: OpencodeCredentials | null;
      try {
        credentials = await deps.credentialsFor(startSpec.account);
      } catch (error) {
        return failure(messageOf(error));
      }
      if (credentials === null) {
        return {
          ok: false,
          reason: AgentStartFailure.needsLogin,
          message: NEEDS_LOGIN_MESSAGE,
        };
      }
      return startWithCredentials(deps, startSpec, credentials);
    },
  };
}
