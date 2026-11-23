import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentContext,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
  AgentToolAccess,
} from "../../src/backend/agentAdapter";
import {
  createClaudeAcpAdapter,
  openAcpStream,
} from "../../src/backend/claude/acpAdapter";
import { buildAgentEnv } from "../../src/backend/env";
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
} from "../../src/domain/types";

import {
  FakeContainer,
  unsupportedLaunch,
  type FakeContained,
} from "./fakeContainer";
import { rigProcesses } from "./rigProcesses";
import { settled } from "./settle";

export const AUTH_REQUIRED_CODE = -32000;
export const SESSION_ID = "fake-session-1";

export interface FakeRpcFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface PermissionStep {
  readonly type: "permission";
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: ToolKind;
  readonly rawInput?: unknown;
  readonly paths: readonly string[];
  readonly options: readonly PermissionOption[];
}

export type NotificationStep =
  | {
      readonly type: "text";
      readonly text: string;
      readonly messageId?: string;
    }
  | {
      readonly type: "tool_call";
      readonly toolCallId: string;
      readonly title: string;
      readonly kind: ToolKind;
      readonly rawInput?: unknown;
    }
  | {
      readonly type: "tool_call_update";
      readonly toolCallId: string;
      readonly status: ToolCallStatus;
      readonly text?: string;
      readonly title?: string;
      readonly rawInput?: unknown;
    }
  | {
      readonly type: "usage_update";
      readonly meta?: Readonly<Record<string, unknown>>;
    };

export type ScriptStep =
  | NotificationStep
  | PermissionStep
  | { readonly type: "ext_notification"; readonly method: string }
  | { readonly type: "unknown_update" }
  | { readonly type: "client_request"; readonly method: string }
  | { readonly type: "end"; readonly stopReason: StopReason }
  | ({ readonly type: "fail" } & FakeRpcFailure)
  | { readonly type: "hang" }
  | {
      readonly type: "write_file";
      readonly path: string;
      readonly content: string;
    }
  | { readonly type: "gate"; readonly until: Promise<void> };

export interface FakeAcpConfig {
  initializeError?: FakeRpcFailure;
  newSessionError?: FakeRpcFailure;
  setConfigOptionError?: FakeRpcFailure;
  sessionModel?: string;
  defaultModelDescription?: string;
  stderrText?: string;
}

export interface ConfigCall {
  readonly configId: string;
  readonly value: string | boolean;
}

const MODEL_CONFIG_ID = "model";

function modelConfigOption(
  current: string,
  description?: string,
): SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    type: "select",
    currentValue: current,
    options: [
      {
        value: current,
        name: current,
        ...(description === undefined ? {} : { description }),
      },
    ],
  };
}

interface RawSessionUpdateParams {
  readonly sessionId: string;
  readonly update: {
    readonly sessionUpdate: string;
    readonly detail: string;
  };
}

const UNKNOWN_UPDATE_KIND = "future_update_kind";

export const DEFAULT_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

const DEFAULT_SCRIPT: readonly ScriptStep[] = [
  { type: "end", stopReason: "end_turn" },
];

function toError(failure: FakeRpcFailure): RequestError {
  return new RequestError(failure.code, failure.message, failure.data);
}

function toolCallUpdate(
  step: Extract<NotificationStep, { type: "tool_call_update" }>,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: step.toolCallId,
    status: step.status,
    ...(step.title === undefined ? {} : { title: step.title }),
    ...(step.rawInput === undefined ? {} : { rawInput: step.rawInput }),
    ...(step.text === undefined
      ? {}
      : {
          content: [
            { type: "content", content: { type: "text", text: step.text } },
          ],
        }),
  };
}

function toUpdate(step: NotificationStep): SessionUpdate {
  switch (step.type) {
    case "text":
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: step.text },
        ...(step.messageId === undefined ? {} : { messageId: step.messageId }),
      };
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: step.toolCallId,
        title: step.title,
        kind: step.kind,
        status: "pending",
        rawInput: step.rawInput,
      };
    case "tool_call_update":
      return toolCallUpdate(step);
    case "usage_update":
      return {
        sessionUpdate: "usage_update",
        used: 1,
        size: 100,
        ...(step.meta === undefined ? {} : { _meta: { ...step.meta } }),
      };
  }
}

export class FakeAcpAgent {
  readonly modeCalls: string[] = [];
  readonly newSessions: NewSessionRequest[] = [];
  readonly configCalls: ConfigCall[] = [];
  readonly callOrder: string[] = [];
  readonly prompts: string[] = [];
  readonly permissionOutcomes: RequestPermissionOutcome[] = [];
  readonly clientRequestErrorCodes: number[] = [];
  cancelCalls = 0;
  private cancelSignal = Promise.withResolvers<null>();
  private readonly scripts: (readonly ScriptStep[])[] = [];
  private readonly config: FakeAcpConfig;
  private readonly contained: FakeContained;

  constructor(contained: FakeContained, config: FakeAcpConfig) {
    this.config = config;
    this.contained = contained;
    const stream = openAcpStream(contained.stdin, contained.stdout);
    agent()
      .onRequest(methods.agent.initialize, (): InitializeResponse => {
        if (this.config.initializeError !== undefined) {
          throw toError(this.config.initializeError);
        }
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
      })
      .onRequest(
        methods.agent.session.new,
        ({ params }): NewSessionResponse => {
          this.newSessions.push(params);
          if (this.config.stderrText !== undefined) {
            this.contained.stderr.write(this.config.stderrText);
          }
          if (this.config.newSessionError !== undefined) {
            throw toError(this.config.newSessionError);
          }
          return {
            sessionId: SESSION_ID,
            ...(this.config.sessionModel === undefined
              ? {}
              : {
                  configOptions: [
                    modelConfigOption(
                      this.config.sessionModel,
                      this.config.defaultModelDescription,
                    ),
                  ],
                }),
          };
        },
      )
      .onRequest(methods.agent.authenticate, () => ({}))
      .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        this.configCalls.push({
          configId: params.configId,
          value: params.value,
        });
        this.callOrder.push("set_config_option");
        if (this.config.setConfigOptionError !== undefined) {
          throw toError(this.config.setConfigOptionError);
        }
        return {
          configOptions:
            typeof params.value === "string"
              ? [modelConfigOption(params.value)]
              : [],
        };
      })
      .onRequest(methods.agent.session.setMode, ({ params }) => {
        this.modeCalls.push(params.modeId);
        return {};
      })
      .onNotification(methods.agent.session.cancel, () => {
        this.cancelCalls += 1;
        this.cancelSignal.resolve(null);
      })
      .onRequest(
        methods.agent.session.prompt,
        async ({ params, client }): Promise<PromptResponse> => {
          this.cancelSignal = Promise.withResolvers<null>();
          this.callOrder.push("prompt");
          for (const block of params.prompt) {
            if (block.type === "text") {
              this.prompts.push(block.text);
            }
          }
          for (const step of this.scripts.shift() ?? DEFAULT_SCRIPT) {
            const response = await this.runStep(client, step);
            if (response !== undefined) {
              return response;
            }
          }
          return { stopReason: "end_turn" };
        },
      )
      .connect(stream);
  }

  enqueue(steps: readonly ScriptStep[]): void {
    this.scripts.push(steps);
  }

  private async runStep(
    peer: AgentContext,
    step: ScriptStep,
  ): Promise<PromptResponse | undefined> {
    switch (step.type) {
      case "permission":
        return Promise.race([
          this.askPermission(peer, step).then(() => undefined),
          this.cancelSignal.promise.then((): PromptResponse => ({
            stopReason: "cancelled",
          })),
        ]);
      case "end":
        return { stopReason: step.stopReason };
      case "fail":
        throw toError(step);
      case "hang":
        return new Promise<PromptResponse>(() => undefined);
      case "write_file":
        await writeFile(join(this.sessionCwd(), step.path), step.content);
        return undefined;
      case "gate":
        await step.until;
        return undefined;
      case "ext_notification":
        await peer.notify(step.method, { value: 1 });
        return undefined;
      case "unknown_update":
        await peer.notify<RawSessionUpdateParams>(
          methods.client.session.update,
          {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: UNKNOWN_UPDATE_KIND,
              detail: "from a newer agent",
            },
          },
        );
        return undefined;
      case "client_request":
        await this.probeClientRequest(peer, step.method);
        return undefined;
      default:
        await peer.notify(methods.client.session.update, {
          sessionId: SESSION_ID,
          update: toUpdate(step),
        });
        return undefined;
    }
  }

  private sessionCwd(): string {
    const request = this.newSessions[0];
    if (request === undefined) {
      throw new Error("no session was created");
    }
    return request.cwd;
  }

  private async probeClientRequest(
    peer: AgentContext,
    method: string,
  ): Promise<void> {
    try {
      await peer.request(method, { sessionId: SESSION_ID });
    } catch (error) {
      if (error instanceof RequestError) {
        this.clientRequestErrorCodes.push(error.code);
        return;
      }
      throw error;
    }
  }

  private async askPermission(
    peer: AgentContext,
    step: PermissionStep,
  ): Promise<void> {
    const response = await peer.request<
      RequestPermissionResponse,
      RequestPermissionRequest
    >(methods.client.session.requestPermission, {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: step.toolCallId,
        title: step.title,
        kind: step.kind,
        rawInput: step.rawInput,
        locations: step.paths.map((path) => ({ path })),
      },
      options: [...step.options],
    });
    this.permissionOutcomes.push(response.outcome);
  }
}

export class ScriptedAcpContainer implements ProcessContainer {
  readonly kind = ContainerKind.envMarker;
  readonly launch = unsupportedLaunch;
  readonly specs: SpawnSpec[] = [];
  readonly agents: FakeAcpAgent[] = [];
  readonly contained: FakeContained[] = [];
  readonly config: FakeAcpConfig = {};
  defaultScript: readonly ScriptStep[] | undefined;
  private readonly inner: FakeContainer;
  private readonly nextScripts: (readonly ScriptStep[])[] = [];

  constructor(stopResults: readonly StopResult[] = []) {
    this.inner = new FakeContainer(stopResults);
  }

  holdStops(): void {
    this.inner.holdStops();
  }

  scriptNext(steps: readonly ScriptStep[]): void {
    this.nextScripts.push(steps);
  }

  async spawn(spec: SpawnSpec): Promise<Contained> {
    const spawned = await this.inner.spawn(spec);
    const fake = this.inner.spawned[this.inner.spawned.length - 1];
    if (fake === undefined) {
      throw new Error("fake container did not record the spawn");
    }
    this.specs.push(spec);
    this.contained.push(fake);
    const agent = new FakeAcpAgent(fake, this.config);
    const steps = this.nextScripts.shift() ?? this.defaultScript;
    if (steps !== undefined) {
      agent.enqueue(steps);
    }
    this.agents.push(agent);
    return spawned;
  }

  sweepOrphans(): Promise<number> {
    return this.inner.sweepOrphans();
  }
}

export const RIG_ACCOUNT: Account = {
  id: "acc-1",
  provider: ProviderId.claude,
  label: "Main",
  configDir: "/home/jane/.claude",
  order: 0,
};
export const RIG_EXEC_PATH = "/opt/codeweave/codeweave";
export const RIG_ADAPTER_ENTRY =
  "/opt/codeweave/claude-agent-acp/dist/index.js";
export const RIG_GRACE_MS = 25;

const rigDirs: string[] = [];

export async function removeRigDirs(): Promise<void> {
  await Promise.all(
    rigDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export interface AcpRig {
  readonly container: ScriptedAcpContainer;
  readonly cwd: string;
  start(
    profile?: PermissionProfile,
    runId?: string,
    tools?: AgentToolAccess,
  ): Promise<AgentStartResult>;
}

export async function createRig(
  stopResults: readonly StopResult[] = [],
): Promise<AcpRig> {
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-acp-"));
  rigDirs.push(cwd);
  const container = new ScriptedAcpContainer(stopResults);
  const adapter = createClaudeAcpAdapter({
    processes: rigProcesses(container),
    envFor: (spec: AgentStartSpec) =>
      buildAgentEnv({
        parent: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "0" },
        platform: "linux",
        homeDir: "/home/jane",
        account: spec.account,
        executable: spec.executable,
        runMarker: spec.runId,
        testMode: false,
      }),
    execPath: RIG_EXEC_PATH,
    adapterEntry: RIG_ADAPTER_ENTRY,
    stopGraceMs: RIG_GRACE_MS,
  });
  return {
    container,
    cwd,
    start: (profile = PermissionProfile.ask, runId = "run-1", tools) =>
      adapter.start({
        account: RIG_ACCOUNT,
        cwd,
        profile,
        runId,
        executable: "/usr/bin/claude",
        ...(tools === undefined ? {} : { tools }),
      }),
  };
}

export async function startHandle(
  rig: AcpRig,
  profile: PermissionProfile = PermissionProfile.ask,
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const result = await rig.start(profile);
  if (!result.ok) {
    throw new Error(`start failed: ${result.reason}: ${result.message}`);
  }
  const events: AgentEvent[] = [];
  result.handle.subscribe((event) => events.push(event));
  return { handle: result.handle, events };
}

export function agentOf(rig: AcpRig): FakeAcpAgent {
  const agent = rig.container.agents[0];
  if (agent === undefined) {
    throw new Error("no agent was spawned");
  }
  return agent;
}

export function containedOf(rig: AcpRig): FakeContained {
  const contained = rig.container.contained[0];
  if (contained === undefined) {
    throw new Error("no process was spawned");
  }
  return contained;
}

export async function permissionRequestOf(
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
