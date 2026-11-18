import { mkdir } from "node:fs/promises";

import type { Account, EpochMillis } from "../../domain/types";
import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartResult,
  type AgentStartSpec,
} from "../agentAdapter";
import type { AgentProcess, AgentProcesses } from "../agentProcesses";
import { DEFAULT_STOP_GRACE_MS } from "../constants";

import { createOpencodeClient, type OpencodeClient } from "./client";
import {
  createRunFiles,
  removeRunFiles,
  type OpencodeCredentials,
  type RunFiles,
} from "./config";
import {
  NEEDS_LOGIN_MESSAGE,
  READY_TIMEOUT_MS,
  STALE_GATE_GRACE_MS,
} from "./constants";
import { OpencodeHandle } from "./handle";
import { accountDirs, buildOpencodeLaunch } from "./launch";
import { createRedactor, type Redactor } from "./redact";
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
  readonly agentProcess: AgentProcess;
  readonly files: RunFiles;
  readonly watch: ProcessWatch;
  readonly redact: Redactor;
}

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
): Promise<LaunchedRun> {
  const port = await deps.freePort();
  const files = await createRunFiles({
    credentials: secrets.credentials,
    runtimeRoot: deps.runtimeRoot,
  });
  try {
    const launch = buildOpencodeLaunch({
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
  handle: OpencodeHandle | null,
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

function newHandle(
  deps: OpencodeAdapterDeps,
  startSpec: AgentStartSpec,
  run: LaunchedRun,
  client: OpencodeClient,
): OpencodeHandle {
  return new OpencodeHandle({
    spec: startSpec,
    agentProcess: run.agentProcess,
    watch: run.watch,
    files: run.files,
    client,
    redact: run.redact,
    now: deps.now,
    stopGraceMs: deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    staleGateGraceMs: deps.staleGateGraceMs ?? STALE_GATE_GRACE_MS,
  });
}

async function connectRun(
  deps: OpencodeAdapterDeps,
  startSpec: AgentStartSpec,
  run: LaunchedRun,
  password: string,
): Promise<AgentStartResult> {
  let handle: OpencodeHandle | null = null;
  try {
    const baseUrl = await run.watch.listening(
      deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
    );
    handle = newHandle(
      deps,
      startSpec,
      run,
      createOpencodeClient({
        baseUrl,
        password,
        directory: startSpec.cwd,
        fetchImpl: deps.fetchImpl,
        ...(deps.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: deps.requestTimeoutMs }),
        ...(deps.warmUpTimeoutMs === undefined
          ? {}
          : { warmUpTimeoutMs: deps.warmUpTimeoutMs }),
      }),
    );
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
    await deps.generationFor(deps.executableFor(startSpec), {
      env: { ...deps.envFor(startSpec), ...dirs },
      cwd: startSpec.cwd,
    });
    run = await spawnRun(deps, startSpec, secrets);
  } catch (error) {
    return failure(secrets.redact(messageOf(error)));
  }
  return connectRun(deps, startSpec, run, password);
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
