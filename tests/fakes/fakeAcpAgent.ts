import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type InitializeResponse,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AgentHandle,
  AgentStartResult,
  AgentStartSpec,
} from "../../src/backend/agentAdapter";
import { createAgentProcesses } from "../../src/backend/agentProcesses";
import {
  createClaudeAcpAdapter,
  openAcpStream,
} from "../../src/backend/claude/acpAdapter";
import { buildAgentEnv } from "../../src/backend/env";
import { WorktreeLocks } from "../../src/backend/locks";
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
  | { readonly type: "end"; readonly stopReason: StopReason }
  | ({ readonly type: "fail" } & FakeRpcFailure)
  | { readonly type: "hang" };

export interface FakeAcpConfig {
  initializeError?: FakeRpcFailure;
  newSessionError?: FakeRpcFailure;
  stderrText?: string;
}

interface AgentPeer {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}

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
  readonly prompts: string[] = [];
  readonly permissionOutcomes: RequestPermissionOutcome[] = [];
  cancelCalls = 0;
  private cancelSignal = Promise.withResolvers<null>();
  private readonly scripts: (readonly ScriptStep[])[] = [];
  private readonly config: FakeAcpConfig;
  private readonly contained: FakeContained;

  constructor(contained: FakeContained, config: FakeAcpConfig) {
    this.config = config;
    this.contained = contained;
    const stream = openAcpStream(contained.stdin, contained.stdout);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    new AgentSideConnection((conn) => this.createAgent(conn), stream);
  }

  enqueue(steps: readonly ScriptStep[]): void {
    this.scripts.push(steps);
  }

  private createAgent(peer: AgentPeer): Agent {
    return {
      initialize: (): InitializeResponse => {
        if (this.config.initializeError !== undefined) {
          throw toError(this.config.initializeError);
        }
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
      },
      newSession: (): NewSessionResponse => {
        if (this.config.stderrText !== undefined) {
          this.contained.stderr.write(this.config.stderrText);
        }
        if (this.config.newSessionError !== undefined) {
          throw toError(this.config.newSessionError);
        }
        return { sessionId: SESSION_ID };
      },
      authenticate: () => ({}),
      setSessionMode: ({ modeId }) => {
        this.modeCalls.push(modeId);
        return {};
      },
      cancel: () => {
        this.cancelCalls += 1;
        this.cancelSignal.resolve(null);
      },
      prompt: async ({ prompt }): Promise<PromptResponse> => {
        this.cancelSignal = Promise.withResolvers<null>();
        for (const block of prompt) {
          if (block.type === "text") {
            this.prompts.push(block.text);
          }
        }
        for (const step of this.scripts.shift() ?? DEFAULT_SCRIPT) {
          const response = await this.runStep(peer, step);
          if (response !== undefined) {
            return response;
          }
        }
        return { stopReason: "end_turn" };
      },
    };
  }

  private async runStep(
    peer: AgentPeer,
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
      default:
        await peer.sessionUpdate({
          sessionId: SESSION_ID,
          update: toUpdate(step),
        });
        return undefined;
    }
  }

  private async askPermission(
    peer: AgentPeer,
    step: PermissionStep,
  ): Promise<void> {
    const response = await peer.requestPermission({
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
    const steps = this.nextScripts.shift();
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
  start(profile?: PermissionProfile, runId?: string): Promise<AgentStartResult>;
}

export async function createRig(
  stopResults: readonly StopResult[] = [],
): Promise<AcpRig> {
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-acp-"));
  rigDirs.push(cwd);
  const container = new ScriptedAcpContainer(stopResults);
  const adapter = createClaudeAcpAdapter({
    processes: createAgentProcesses({ container, locks: new WorktreeLocks() }),
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
    start: (profile = PermissionProfile.ask, runId = "run-1") =>
      adapter.start({
        account: RIG_ACCOUNT,
        cwd,
        profile,
        runId,
        executable: "/usr/bin/claude",
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
  return vi.waitFor(() => {
    const found = events.find((event) => event.type === "permission_request");
    if (found === undefined) {
      throw new Error("no permission_request yet");
    }
    return found;
  });
}
