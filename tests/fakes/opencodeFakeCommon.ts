import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import type {
  AgentToolAccess,
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
} from "../../src/backend/agentAdapter";
import { createOpencodeAdapter } from "../../src/backend/opencode/adapter";
import type { OpencodeCredentials } from "../../src/backend/opencode/config";
import {
  ConsoleLoginState,
  type ConsoleLoginProbe,
} from "../../src/backend/opencode/consoleLogin";
import { OpencodeGeneration } from "../../src/backend/opencode/constants";
import { findFreePort } from "../../src/backend/opencode/port";
import type { GenerationProbe } from "../../src/backend/opencode/version";
import {
  ContainerKind,
  type Contained,
  type ProcessContainer,
  type SpawnSpec,
  type StopResult,
} from "../../src/backend/process/container";
import type { AgentEvent } from "../../src/domain/events";
import {
  PermissionProfile,
  ProviderId,
  type Account,
  type ApiAccount,
} from "../../src/domain/types";

import { FakeContained, unsupportedLaunch } from "./fakeContainer";
import { rigProcesses } from "./rigProcesses";
import { settled } from "./settle";

export type Json = Readonly<Record<string, unknown>>;

export const OPENCODE_SESSION_ID = "ses_fake";
export const OPENCODE_RIG_PASSWORD = randomUUID();
export const OPENCODE_RIG_NOW_MS = 1_700_000_000_000;
export const OPENCODE_RIG_EXECUTABLE = "/usr/bin/opencode";
export const OPENCODE_RIG_GRACE_MS = 25;
export const OPENCODE_RIG_READY_TIMEOUT_MS = 400;
export const OPENCODE_RIG_REQUEST_TIMEOUT_MS = 150;
export const OPENCODE_RIG_WARM_UP_TIMEOUT_MS = 500;
export const OPENCODE_RIG_CREDENTIALS: OpencodeCredentials = {
  auth: "api_key",
  providerId: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  apiKey: "sk-test-A",
};
export const OPENCODE_RIG_ACCOUNT_ID = "acc-opencode";

const PORT_ARG = "--port";
const PERMISSION_MASK = 0o777;
const FILE_REFERENCE = /^\{file:(.*)\}$/;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorized: boolean;
}

export function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      resolve(text === "" ? null : (JSON.parse(text) as unknown));
    });
  });
}

export function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export function basicAuthOf(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export function keyPathOf(apiKeyReference: string): string {
  return FILE_REFERENCE.exec(apiKeyReference)?.[1] ?? "";
}

export interface OpencodeStartup {
  readonly configPath: string;
  readonly config: unknown;
  readonly keyFileContent: string | null;
  readonly keyFileMode: number | null;
  readonly configFileMode: number;
  readonly runDirMode: number;
  readonly runDirEntries: readonly string[];
}

export async function readRunStartup(
  configPath: string,
  apiKeyReferenceOf: (config: unknown) => string,
): Promise<OpencodeStartup> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const keyPath = keyPathOf(apiKeyReferenceOf(config));
  const runDir = dirname(configPath);
  const keyed = keyPath !== "";
  return {
    configPath,
    config,
    keyFileContent: keyed ? await readFile(keyPath, "utf8") : null,
    keyFileMode: keyed ? (await stat(keyPath)).mode & PERMISSION_MASK : null,
    configFileMode: (await stat(configPath)).mode & PERMISSION_MASK,
    runDirMode: (await stat(runDir)).mode & PERMISSION_MASK,
    runDirEntries: await readdir(runDir),
  };
}

function portOf(spec: SpawnSpec): number {
  const index = spec.args.indexOf(PORT_ARG);
  return Number(spec.args[index + 1]);
}

export interface ScriptedServer<Step> {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  enqueue(steps: readonly Step[]): void;
}

export interface BaseContainerConfig {
  exitBeforeListening?: boolean;
  silent?: boolean;
  stderrText?: string;
  launchDelayMs?: number;
}

export abstract class ScriptedContainerBase<
  Server extends ScriptedServer<Step>,
  Step,
  Config extends BaseContainerConfig,
> implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  readonly launch = unsupportedLaunch;
  readonly specs: SpawnSpec[] = [];
  readonly servers: Server[] = [];
  readonly contained: FakeContained[] = [];
  readonly startups: OpencodeStartup[] = [];
  readonly config: Config;
  private readonly stopResults: readonly StopResult[];
  private readonly nextScripts: (readonly Step[])[] = [];

  protected constructor(stopResults: readonly StopResult[], config: Config) {
    this.stopResults = stopResults;
    this.config = config;
  }

  protected abstract passwordEnv(): string;
  protected abstract listeningLine(port: number): string;
  protected abstract readStartup(
    env: Readonly<Record<string, string>>,
  ): Promise<OpencodeStartup>;
  protected abstract createServer(
    password: string,
    env: Readonly<Record<string, string>>,
  ): Server;

  scriptNextServer(steps: readonly Step[]): void {
    this.nextScripts.push(steps);
  }

  async spawn(spec: SpawnSpec): Promise<Contained> {
    const { launchDelayMs } = this.config;
    if (launchDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, launchDelayMs));
    }
    const contained = new FakeContained(spec.runId, this.stopResults);
    this.specs.push(spec);
    this.contained.push(contained);
    if (this.config.stderrText !== undefined) {
      contained.stderr.write(this.config.stderrText);
    }
    if (this.config.exitBeforeListening === true) {
      setImmediate(() => {
        contained.emitExit(1);
      });
      return contained;
    }
    if (this.config.silent === true) {
      return contained;
    }
    this.startups.push(await this.readStartup(spec.env));
    const server = this.createServer(
      spec.env[this.passwordEnv()] ?? "",
      spec.env,
    );
    this.servers.push(server);
    const script = this.nextScripts.shift();
    if (script !== undefined) {
      server.enqueue(script);
    }
    const port = portOf(spec);
    await server.listen(port);
    contained.stdout.write(this.listeningLine(port));
    return contained;
  }

  sweepOrphans(): Promise<number> {
    return Promise.resolve(0);
  }
}

export interface OpencodeRigOptions {
  readonly credentials?: OpencodeCredentials | null;
  readonly consoleLoginFor?: ConsoleLoginProbe;
  readonly stopResults?: readonly StopResult[];
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly warmUpTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly staleGateGraceMs?: number;
  readonly api?: ApiAccount;
  readonly generationFor?: GenerationProbe;
}

export interface RigContainer extends ProcessContainer {
  readonly servers: readonly { close(): Promise<void> }[];
}

export interface OpencodeRigOf<Container> {
  readonly container: Container;
  readonly cwd: string;
  readonly accountDir: string;
  readonly runtimeRoot: string;
  start(
    profile?: PermissionProfile,
    runId?: string,
    tools?: AgentToolAccess,
  ): Promise<AgentStartResult>;
}

const rigRoots: string[] = [];
const rigContainers: RigContainer[] = [];

export async function disposeOpencodeRigs(): Promise<void> {
  const containers = rigContainers.splice(0);
  await Promise.allSettled(
    containers.flatMap((container) =>
      container.servers.map((server) => server.close()),
    ),
  );
  await Promise.allSettled(
    rigRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

function specFor(
  account: Account,
  cwd: string,
  profile: PermissionProfile,
  runId: string,
  tools: AgentToolAccess | undefined,
): AgentStartSpec {
  return {
    account,
    cwd,
    profile,
    runId,
    executable: OPENCODE_RIG_EXECUTABLE,
    ...(tools === undefined ? {} : { tools }),
  };
}

export async function createRigOn<Container extends RigContainer>(
  container: Container,
  options: OpencodeRigOptions,
  defaultGeneration: OpencodeGeneration,
): Promise<OpencodeRigOf<Container>> {
  const root = await mkdtemp(join(tmpdir(), "codeweave-opencode-rig-"));
  rigRoots.push(root);
  const cwd = join(root, "work");
  const accountDir = join(root, "account");
  const runtimeRoot = join(root, "runtime");
  await Promise.all([cwd, accountDir, runtimeRoot].map((dir) => mkdir(dir)));
  rigContainers.push(container);
  const credentials =
    options.credentials === undefined
      ? OPENCODE_RIG_CREDENTIALS
      : options.credentials;
  const adapter = createOpencodeAdapter({
    processes: rigProcesses(container),
    envFor: () => ({ PATH: "/usr/bin" }),
    executableFor: () => OPENCODE_RIG_EXECUTABLE,
    credentialsFor: () => Promise.resolve(credentials),
    consoleLoginFor:
      options.consoleLoginFor ??
      (() => Promise.resolve(ConsoleLoginState.loggedIn)),
    generationFor:
      options.generationFor ?? (() => Promise.resolve(defaultGeneration)),
    runtimeRoot,
    platform: "linux",
    fetchImpl: fetch,
    now: () => OPENCODE_RIG_NOW_MS,
    freePort: findFreePort,
    newPassword: () => OPENCODE_RIG_PASSWORD,
    stopGraceMs: options.stopGraceMs ?? OPENCODE_RIG_GRACE_MS,
    staleGateGraceMs: options.staleGateGraceMs ?? OPENCODE_RIG_GRACE_MS,
    readyTimeoutMs: options.readyTimeoutMs ?? OPENCODE_RIG_READY_TIMEOUT_MS,
    requestTimeoutMs:
      options.requestTimeoutMs ?? OPENCODE_RIG_REQUEST_TIMEOUT_MS,
    warmUpTimeoutMs: options.warmUpTimeoutMs ?? OPENCODE_RIG_WARM_UP_TIMEOUT_MS,
  });
  const account: Account = {
    id: OPENCODE_RIG_ACCOUNT_ID,
    provider: ProviderId.opencode,
    label: "OpenCode",
    configDir: accountDir,
    order: 0,
    api: options.api,
  };
  return {
    container,
    cwd,
    accountDir,
    runtimeRoot,
    start: (profile = PermissionProfile.ask, runId = "run-1", tools) =>
      adapter.start(specFor(account, cwd, profile, runId, tools)),
  };
}

export async function startOpencodeHandle(
  rig: Pick<OpencodeRigOf<unknown>, "start">,
  profile: PermissionProfile = PermissionProfile.ask,
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const result = await rig.start(profile);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(result.message);
  }
  const events: AgentEvent[] = [];
  result.handle.subscribe((event) => events.push(event));
  return { handle: result.handle, events };
}

export function firstServerOf<Server>(container: {
  readonly servers: readonly Server[];
}): Server {
  const [server] = container.servers;
  if (server === undefined) {
    throw new Error("no opencode server was spawned");
  }
  return server;
}

export async function opencodePermissionRequestOf(
  events: readonly AgentEvent[],
): Promise<Extract<AgentEvent, { type: "permission_request" }>> {
  return settled(() => {
    const found = events.find((event) => event.type === "permission_request");
    if (found === undefined) {
      throw new Error("no permission_request yet");
    }
    return found;
  });
}
