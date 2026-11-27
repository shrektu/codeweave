import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption as AcpPermissionOption,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
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
  readPromptImages,
  type AgentStartResult,
  type AgentStartSpec,
  type TurnOptions,
} from "../agentAdapter";
import type { AgentProcess, AgentProcesses } from "../agentProcesses";
import {
  DEFAULT_STOP_GRACE_MS,
  DEFAULT_TOOL_KIND,
  MODE_BYPASS,
  MODE_DEFAULT,
  MODEL_CONFIG_ID,
  PROCESS_EXITED_MESSAGE,
  STDERR_TAIL_CHARS,
} from "../constants";
import type { StopResult } from "../process/container";

import {
  createAcpEventMapper,
  isAuthError,
  mapPromptError,
  modelOf,
  modelValueOf,
} from "./acpEvents";
import { buildClaudeLaunch } from "./launch";
import { buildNewSessionRequest } from "./toolAccess";

const IMAGE_UNSUPPORTED_MESSAGE = "This Claude agent does not accept images";

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
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  loadSession(
    params: LoadSessionRequest,
  ): Promise<LoadSessionResponse | undefined>;
  setSessionMode(params: SetSessionModeRequest): Promise<unknown>;
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse>;
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
    resumeSession: (params) =>
      agent.request(methods.agent.session.resume, params),
    loadSession: (params) => agent.request(methods.agent.session.load, params),
    setSessionMode: (params) =>
      agent.request(methods.agent.session.setMode, params),
    setSessionConfigOption: (params) =>
      agent.request(methods.agent.session.setConfigOption, params),
    prompt: (params) => agent.request(methods.agent.session.prompt, params),
    cancel: (params) => agent.notify(methods.agent.session.cancel, params),
  };
}

function toPermissionOption(
  option: AcpPermissionOption,
): Extract<AgentEvent, { type: "permission_request" }>["options"][number] {
  return { optionId: option.optionId, name: option.name, kind: option.kind };
}

interface OpenedSession {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly configOptions: readonly SessionConfigOption[] | null;
}

class ClaudeAcpSession implements AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  nativeSessionId: string | null = null;
  resumed = false;
  private readonly agentProcess: AgentProcess;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly mapUpdate = createAcpEventMapper();
  private readonly peer: AcpPeer;
  private readonly exitSignal: Promise<void>;
  private resolveExit: () => void = () => undefined;
  private sessionId = "";
  private imageInput = false;
  private selectedModel: string | null = null;
  private announcedModel: string | null = null;
  private stderrText = "";
  private exited = false;
  private exitEmitted = false;
  private turn: Promise<void> | null = null;
  private replaying = false;

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
    if (this.announcedModel !== null) {
      listener({ type: "model", model: this.announcedModel });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string, options: TurnOptions): Promise<void> {
    if (this.turn !== null) {
      throw new TurnInProgressError(this.runId);
    }
    const run = this.runTurn(text, options);
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
    if (this.replaying) {
      return;
    }
    for (const event of this.mapUpdate.map(update)) {
      this.emit(event);
    }
  }

  private async negotiate(spec: AgentStartSpec): Promise<void> {
    const initialized = await this.peer.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    this.imageInput =
      initialized.agentCapabilities?.promptCapabilities?.image === true;
    const opened = await this.openSession(
      spec,
      initialized.agentCapabilities ?? null,
    );
    this.sessionId = opened.sessionId;
    this.nativeSessionId = opened.sessionId;
    this.resumed = opened.resumed;
    this.selectedModel = modelValueOf(opened.configOptions);
    this.announcedModel = modelOf(opened.configOptions);
    if (spec.profile === PermissionProfile.bypass) {
      await this.setProfile(spec.profile);
    }
  }

  private async openSession(
    spec: AgentStartSpec,
    capabilities: AgentCapabilities | null,
  ): Promise<OpenedSession> {
    const request = buildNewSessionRequest(spec.cwd, spec.tools);
    const requested = spec.resume?.nativeSessionId;
    if (requested !== undefined) {
      const resumed = await this.resumeRequested(
        requested,
        spec,
        request,
        capabilities,
      );
      if (resumed !== null) {
        return resumed;
      }
    }
    const fresh = await this.peer.newSession(request);
    return {
      sessionId: fresh.sessionId,
      resumed: false,
      configOptions: fresh.configOptions ?? null,
    };
  }

  private resumeRequested(
    sessionId: string,
    spec: AgentStartSpec,
    request: NewSessionRequest,
    capabilities: AgentCapabilities | null,
  ): Promise<OpenedSession | null> {
    if (capabilities?.sessionCapabilities?.resume != null) {
      return this.tryResumeSession(sessionId, spec, request);
    }
    if (capabilities?.loadSession === true) {
      return this.tryLoadSession(sessionId, spec, request);
    }
    return Promise.resolve(null);
  }

  private async tryResumeSession(
    sessionId: string,
    spec: AgentStartSpec,
    request: NewSessionRequest,
  ): Promise<OpenedSession | null> {
    try {
      const resumed = await this.peer.resumeSession({
        sessionId,
        cwd: spec.cwd,
        mcpServers: request.mcpServers,
      });
      return {
        sessionId,
        resumed: true,
        configOptions: resumed.configOptions ?? null,
      };
    } catch (error) {
      console.warn(`session/resume failed: ${this.runId}`, error);
      return null;
    }
  }

  private async tryLoadSession(
    sessionId: string,
    spec: AgentStartSpec,
    request: NewSessionRequest,
  ): Promise<OpenedSession | null> {
    this.replaying = true;
    try {
      const loaded = await this.peer.loadSession({
        sessionId,
        cwd: spec.cwd,
        mcpServers: request.mcpServers,
      });
      return {
        sessionId,
        resumed: true,
        configOptions: loaded?.configOptions ?? null,
      };
    } catch (error) {
      console.warn(`session/load failed: ${this.runId}`, error);
      return null;
    } finally {
      this.replaying = false;
    }
  }

  private async selectModel(model: string | null): Promise<void> {
    if (model !== null && model !== this.selectedModel) {
      const updated = await this.peer.setSessionConfigOption({
        sessionId: this.sessionId,
        configId: MODEL_CONFIG_ID,
        value: model,
      });
      this.selectedModel = modelValueOf(updated.configOptions) ?? model;
      this.announcedModel = modelOf(updated.configOptions) ?? model;
    }
    if (this.announcedModel !== null) {
      this.emit({ type: "model", model: this.announcedModel });
    }
  }

  private async runTurn(text: string, options: TurnOptions): Promise<void> {
    const images = options.images ?? [];
    if (images.length > 0 && !this.imageInput) {
      throw new Error(IMAGE_UNSUPPORTED_MESSAGE);
    }
    const imageBlocks = (await readPromptImages(images)).map((image) => ({
      type: "image" as const,
      data: image.dataBase64,
      mimeType: image.mimeType,
    }));
    const response = this.selectModel(options.model)
      .then(() =>
        this.peer.prompt({
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }, ...imageBlocks],
        }),
      )
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
      toolsEnabled: spec.tools !== undefined,
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
