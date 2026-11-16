import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption as AcpPermissionOption,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type SetSessionModeRequest,
  type Stream,
} from "@agentclientprotocol/sdk";

import type { AgentEvent } from "../../domain/events";
import { PermissionProfile } from "../../domain/types";
import {
  AgentStartFailure,
  InvalidOptionError,
  TurnInProgressError,
  UnknownPermissionError,
  type AgentAdapter,
  type AgentHandle,
  type AgentStartResult,
  type AgentStartSpec,
} from "../agentAdapter";
import type { AgentProcess, AgentProcesses } from "../agentProcesses";
import {
  DEFAULT_STOP_GRACE_MS,
  DEFAULT_TOOL_KIND,
  MODE_BYPASS,
  MODE_DEFAULT,
  PROCESS_EXITED_MESSAGE,
  STDERR_TAIL_CHARS,
} from "../constants";
import type { StopResult } from "../process/container";

import { isAuthError, mapPromptError, mapSessionUpdate } from "./acpEvents";
import { buildClaudeLaunch } from "./launch";

export interface ClaudeAcpDeps {
  readonly processes: AgentProcesses;
  readonly envFor: (spec: AgentStartSpec) => Record<string, string>;
  readonly execPath: string;
  readonly adapterEntry: string;
  readonly stopGraceMs?: number;
}

interface AcpPeer {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  setSessionMode(params: SetSessionModeRequest): Promise<unknown>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(params: CancelNotification): Promise<void>;
}

interface PendingPermission {
  readonly optionIds: ReadonlySet<string>;
  readonly resolve: (response: RequestPermissionResponse) => void;
}

type Listener = (event: AgentEvent) => void;

const CANCELLED: RequestPermissionResponse = {
  outcome: { outcome: "cancelled" },
};

class ProcessExitedError extends Error {
  constructor() {
    super(PROCESS_EXITED_MESSAGE);
    this.name = "ProcessExitedError";
  }
}

function toWebReadable(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) {
          source.pause();
        }
      });
      source.on("end", () => {
        controller.close();
      });
      source.on("error", (error: Error) => {
        controller.error(error);
      });
    },
    pull() {
      source.resume();
    },
    cancel() {
      source.destroy();
    },
  });
}

export function openAcpStream(input: Readable, output: Writable): Stream {
  return ndJsonStream(Writable.toWeb(output), toWebReadable(input));
}

interface ClientHandlers {
  readonly onUpdate: (update: SessionUpdate) => void;
  readonly onPermission: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

function connect(stream: Stream, handlers: ClientHandlers): AcpPeer {
  const { agent } = client()
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      handlers.onPermission(params),
    )
    .onNotification(methods.client.session.update, ({ params }) => {
      handlers.onUpdate(params.update);
    })
    .connect(stream);
  return {
    initialize: (params) => agent.request(methods.agent.initialize, params),
    newSession: (params) => agent.request(methods.agent.session.new, params),
    setSessionMode: (params) =>
      agent.request(methods.agent.session.setMode, params),
    prompt: (params) => agent.request(methods.agent.session.prompt, params),
    cancel: (params) => agent.notify(methods.agent.session.cancel, params),
  };
}

function toPermissionOption(
  option: AcpPermissionOption,
): Extract<AgentEvent, { type: "permission_request" }>["options"][number] {
  return { optionId: option.optionId, name: option.name, kind: option.kind };
}

class ClaudeAcpSession implements AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  private readonly agentProcess: AgentProcess;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly peer: AcpPeer;
  private readonly exitSignal: Promise<void>;
  private resolveExit: () => void = () => undefined;
  private sessionId = "";
  private stderrText = "";
  private exited = false;
  private exitEmitted = false;
  private turn: Promise<void> | null = null;

  constructor(spec: AgentStartSpec, agentProcess: AgentProcess) {
    this.accountId = spec.account.id;
    this.runId = spec.runId;
    this.agentProcess = agentProcess;
    this.exitSignal = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    const { contained } = agentProcess;
    contained.stdin.on("error", (error: Error) => {
      console.warn(`agent stdin error: ${this.runId}`, error);
    });
    contained.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString()).slice(
        -STDERR_TAIL_CHARS,
      );
    });
    contained.onExit(() => {
      this.handleExit();
    });
    this.peer = connect(this.openStream(), {
      onUpdate: (update) => {
        this.emitUpdate(update);
      },
      onPermission: (params) => this.requestPermission(params),
    });
  }

  stderrTail(): string {
    return this.stderrText;
  }

  async handshake(spec: AgentStartSpec): Promise<void> {
    await Promise.race([
      this.negotiate(spec),
      this.exitSignal.then(() => {
        throw new ProcessExitedError();
      }),
    ]);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    if (this.turn !== null) {
      throw new TurnInProgressError(this.runId);
    }
    const run = this.runTurn(text);
    this.turn = run;
    try {
      await run;
    } finally {
      if (this.turn === run) {
        this.turn = null;
      }
    }
  }

  answerPermission(requestId: string, optionId: string): void {
    const request = this.pending.get(requestId);
    if (request === undefined) {
      throw new UnknownPermissionError(requestId);
    }
    if (!request.optionIds.has(optionId)) {
      throw new InvalidOptionError(requestId, optionId);
    }
    this.pending.delete(requestId);
    request.resolve({ outcome: { outcome: "selected", optionId } });
  }

  async setProfile(profile: PermissionProfile): Promise<void> {
    await this.peer.setSessionMode({
      sessionId: this.sessionId,
      modeId: profile === PermissionProfile.bypass ? MODE_BYPASS : MODE_DEFAULT,
    });
  }

  async cancel(): Promise<void> {
    if (!this.exited) {
      await this.peer.cancel({ sessionId: this.sessionId });
    }
  }

  async stop(graceMs: number): Promise<StopResult> {
    this.cancelPending();
    await this.cancel().catch((error: unknown) => {
      console.warn(`cancel before stop failed: ${this.runId}`, error);
    });
    const result = await this.agentProcess.stop(graceMs);
    this.handleExit();
    return result;
  }

  private openStream(): Stream {
    const { stdin, stdout } = this.agentProcess.contained;
    return openAcpStream(stdout, stdin);
  }

  private emitUpdate(update: SessionUpdate): void {
    for (const event of mapSessionUpdate(update)) {
      this.emit(event);
    }
  }

  private async negotiate(spec: AgentStartSpec): Promise<void> {
    await this.peer.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await this.peer.newSession({
      cwd: spec.cwd,
      mcpServers: [],
    });
    this.sessionId = session.sessionId;
    if (spec.profile === PermissionProfile.bypass) {
      await this.setProfile(spec.profile);
    }
  }

  private async runTurn(text: string): Promise<void> {
    const response = this.peer
      .prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      })
      .then((result): AgentEvent => ({
        type: "turn_end",
        stopReason: result.stopReason,
      }))
      .catch((error: unknown): AgentEvent => mapPromptError(error));
    const exited = this.exitSignal.then((): AgentEvent => ({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: PROCESS_EXITED_MESSAGE,
    }));
    const terminal = await Promise.race([response, exited]);
    this.cancelPending();
    this.turn = null;
    this.emit(terminal);
  }

  private requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.exited) {
      return Promise.resolve(CANCELLED);
    }
    const requestId = randomUUID();
    const { toolCall } = params;
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        optionIds: new Set(params.options.map((option) => option.optionId)),
        resolve,
      });
      this.emit({
        type: "permission_request",
        requestId,
        toolCallId: toolCall.toolCallId,
        title: toolCall.title ?? "",
        kind: toolCall.kind ?? DEFAULT_TOOL_KIND,
        ...(toolCall.rawInput === undefined
          ? {}
          : { rawInput: toolCall.rawInput }),
        locations: (toolCall.locations ?? []).map((location) => location.path),
        options: params.options.map(toPermissionOption),
      });
    });
  }

  private cancelPending(): void {
    for (const request of this.pending.values()) {
      request.resolve(CANCELLED);
    }
    this.pending.clear();
  }

  private handleExit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.cancelPending();
    this.resolveExit();
    void (this.turn ?? Promise.resolve()).then(() => {
      if (!this.exitEmitted) {
        this.exitEmitted = true;
        this.emit({ type: "process_exit" });
      }
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`agent event listener failed: ${this.runId}`, error);
      }
    }
  }
}

export function createClaudeAcpAdapter(deps: ClaudeAcpDeps): AgentAdapter {
  const graceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

  async function spawn(spec: AgentStartSpec): Promise<AgentProcess> {
    const launch = buildClaudeLaunch({
      execPath: deps.execPath,
      adapterEntry: deps.adapterEntry,
      env: deps.envFor(spec),
    });
    return deps.processes.start({
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd: spec.cwd,
      runId: spec.runId,
    });
  }

  async function abort(
    session: ClaudeAcpSession,
    error: unknown,
  ): Promise<AgentStartResult> {
    const needsLogin = isAuthError(error);
    const tail = session.stderrTail();
    await session.stop(graceMs).catch((stopError: unknown) => {
      console.error(
        `stop after failed start failed: ${session.runId}`,
        stopError,
      );
    });
    const message = mapPromptError(error).message;
    return {
      ok: false,
      reason: needsLogin
        ? AgentStartFailure.needsLogin
        : AgentStartFailure.error,
      message: needsLogin || tail === "" ? message : `${message}\n${tail}`,
    };
  }

  return {
    async start(spec: AgentStartSpec): Promise<AgentStartResult> {
      let agentProcess: AgentProcess;
      try {
        agentProcess = await spawn(spec);
      } catch (error) {
        return {
          ok: false,
          reason: AgentStartFailure.error,
          message: mapPromptError(error).message,
        };
      }
      const session = new ClaudeAcpSession(spec, agentProcess);
      try {
        await session.handshake(spec);
      } catch (error) {
        return abort(session, error);
      }
      return { ok: true, handle: session };
    },
  };
}
