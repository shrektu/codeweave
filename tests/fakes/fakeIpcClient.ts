import { render, type RenderResult } from "@testing-library/react";
import { createElement, type ReactElement } from "react";

import { ApiProviderId } from "../../src/domain/apiProviders";
import { TaskClass } from "../../src/domain/taskClass";
import {
  DefinitionSource,
  EdgeKind,
  EffectLevel,
  FlowPlacement,
  FlowRunOrigin,
  PermissionProfile,
  ProviderId,
  SwitchReason,
  TerminalStatus,
  UpdateChannel,
} from "../../src/domain/types";
import type { IpcClient } from "../../src/renderer/ipc";
import { ServicesContext } from "../../src/renderer/services";
import {
  createAppStore,
  type AppState,
  type AppStore,
} from "../../src/renderer/store";
import {
  ResultSchemas,
  type IpcEvent,
  type ParamsMap,
  type RequestMethod,
  type ResultMap,
} from "../../src/shared/protocol";
import type {
  AccountView,
  AgentView,
  CatalogModel,
  FlowRunView,
  FlowsList,
  FlowView,
  LimitView,
  MessageView,
  ModelCatalog,
  PermissionView,
  PromptView,
  RestorePlanView,
  RewindResultView,
  SessionHistoryEntry,
  SessionView,
  SettingsView,
  Snapshot,
  StoredSession,
  SwitchLogEntryView,
  TerminalView,
  ToolCallView,
} from "../../src/shared/views";
import type { VaultStatus } from "../../src/shared/vault";

type Handler<M extends RequestMethod> = {
  bivarianceHack(params: ParamsMap[M]): ResultMap[M] | Promise<ResultMap[M]>;
}["bivarianceHack"];

export interface RecordedRequest {
  method: string;
  params: unknown;
}

export interface FakeIpcClient extends IpcClient {
  readonly requests: RecordedRequest[];
  on<M extends RequestMethod>(method: M, handler: Handler<M>): void;
  respond<M extends RequestMethod>(method: M, result: ResultMap[M]): void;
  fail(method: RequestMethod, error: Error): void;
  emit(event: IpcEvent): void;
}

export function createFakeIpcClient(): FakeIpcClient {
  const handlers = new Map<RequestMethod, Handler<RequestMethod>>();
  const listeners = new Set<(event: IpcEvent) => void>();
  const requests: RecordedRequest[] = [];
  handlers.set("history/list", () => ({ entries: [] }));
  return {
    requests,
    on(method, handler): void {
      handlers.set(method, handler);
    },
    respond(method, result): void {
      handlers.set(method, () => result);
    },
    fail(method, error): void {
      handlers.set(method, () => {
        throw error;
      });
    },
    emit(event): void {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    async request(method, params) {
      requests.push({ method, params });
      const handler = handlers.get(method);
      if (handler === undefined) {
        throw new Error(`Unprogrammed IPC method "${method}"`);
      }
      return ResultSchemas[method].parse(await handler(params));
    },
  };
}

export function staticStore(state: AppState): AppStore {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    start: () => () => undefined,
    activateSession: () => undefined,
    focusRun: () => undefined,
    loadTranscript: () => Promise.resolve(null),
  };
}

export function readyState(snapshot: Snapshot): AppState {
  return {
    connection: "ready",
    snapshot,
    error: null,
    activeSessionId: snapshot.sessions.at(-1)?.id ?? null,
    focusedRunId: null,
    history: [],
    historyTranscripts: {},
  };
}

export function renderWithServices(
  ui: ReactElement,
  client: IpcClient,
  store: AppStore = createAppStore(client),
): RenderResult {
  store.start();
  return render(
    createElement(ServicesContext, { value: { client, store } }, ui),
  );
}

export function makeAccount(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "acc-1",
    provider: ProviderId.claude,
    label: "Work",
    configDir: "/home/user/.claude-work",
    order: 0,
    api: null,
    hasKey: false,
    keyHint: null,
    runtime: { status: "ready" },
    limit: null,
    limitAvailability: "pending",
    ...overrides,
  };
}

export function makeLimit(overrides: Partial<LimitView> = {}): LimitView {
  return {
    accountId: "acc-1",
    status: "allowed",
    resetsAt: null,
    rateLimitType: "five_hour",
    utilization: 0.5,
    windows: [],
    observedAt: 0,
    ...overrides,
  };
}

export function makeTool(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "tool-1",
    title: "Run tests",
    kind: "execute",
    status: "in_progress",
    seq: 0,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<MessageView> = {}): MessageView {
  return { id: null, text: "Working on it", seq: 0, ...overrides };
}

export function makePrompt(overrides: Partial<PromptView> = {}): PromptView {
  return { seq: 0, text: "Do the task", attachments: [], ...overrides };
}

export function makeRestorePlan(
  overrides: Partial<RestorePlanView> = {},
): RestorePlanView {
  return { sessionId: "sess-1", promptSeq: 0, files: [], ...overrides };
}

export function makeRewindResult(
  overrides: Partial<RewindResultView> = {},
): RewindResultView {
  return { promptText: "", report: null, session: null, ...overrides };
}

export function makeHistoryEntry(
  overrides: Partial<SessionHistoryEntry> = {},
): SessionHistoryEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Do the task",
    cwd: "/home/user/project",
    provider: ProviderId.claude,
    orchestrate: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    archived: false,
    ...overrides,
  };
}

export function makeStoredSession(
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    title: "Do the task",
    cwd: "/home/user/project",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    orchestrate: false,
    archived: false,
    prompts: [makePrompt()],
    messages: [],
    toolCalls: [],
    turns: [],
    lastTurn: null,
    nativeSessions: [],
    ...overrides,
  };
}

export function makePermission(
  overrides: Partial<PermissionView> = {},
): PermissionView {
  return {
    requestId: "req-1",
    toolCallId: "tool-1",
    title: "Run tests",
    command: "pnpm test",
    seq: 0,
    options: [
      { optionId: "opt-always", name: "Always allow", kind: "allow_always" },
      { optionId: "opt-once", name: "Allow this once", kind: "allow_once" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "sess-1",
    cwd: "/home/user/project",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    activeProvider: ProviderId.claude,
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    contextUsage: null,
    turns: [],
    orchestrate: false,
    imageInput: true,
    prompts: [],
    createdAt: 0,
    ...overrides,
  };
}

export function makeSettings(
  overrides: Partial<SettingsView> = {},
): SettingsView {
  return {
    permissionProfile: PermissionProfile.ask,
    effectLevel: EffectLevel.auto,
    appearance: "system",
    claudeExecutable: null,
    codexExecutable: null,
    agyExecutable: null,
    opencodeExecutable: null,
    terminalShell: null,
    updateCheck: true,
    updateChannel: UpdateChannel.stable,
    defaultTaskClass: TaskClass.standard,
    definitionLibrary: null,
    defaultWorkspace: null,
    defaultWorkspaceResolved: "/home/user",
    recentFolders: [],
    ...overrides,
  };
}

export function makeFlowRun(overrides: Partial<FlowRunView> = {}): FlowRunView {
  return {
    runId: "run-1",
    flowId: "implement-and-review",
    flowTitle: "Implement and review",
    cwd: "/home/user/project",
    task: "Add a login form",
    status: "running",
    round: 0,
    maxRounds: 2,
    currentNodeId: "build",
    nodes: [
      { id: "build", status: "running", visits: 1, result: null, model: null },
      { id: "review", status: "idle", visits: 0, result: null, model: null },
    ],
    decision: null,
    decisions: [],
    failure: null,
    origin: FlowRunOrigin.user,
    placement: FlowPlacement.inPlace,
    branch: null,
    ownerSessionId: null,
    ...overrides,
  };
}

export function makeTerminal(
  overrides: Partial<TerminalView> = {},
): TerminalView {
  return {
    id: "term-1",
    cwd: "/home/user/project",
    shell: "/bin/bash",
    status: TerminalStatus.running,
    exitCode: null,
    ...overrides,
  };
}

export function makeSwitchEntry(
  overrides: Partial<SwitchLogEntryView> = {},
): SwitchLogEntryView {
  return {
    at: 0,
    sessionId: "sess-1",
    from: "acc-1",
    to: "acc-2",
    reason: SwitchReason.rateLimit,
    resetsAt: null,
    contextPackageChars: 0,
    ...overrides,
  };
}

export function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "implementer",
    file: "agents/implementer.md",
    source: DefinitionSource.project,
    revision: "agent-rev-1",
    role: "Implements the planned change",
    provider: ProviderId.claude,
    model: null,
    permissionProfile: PermissionProfile.plan,
    taskClass: null,
    body: "Implements the change.",
    usedBy: [],
    ...overrides,
  };
}

export function makeFlow(overrides: Partial<FlowView> = {}): FlowView {
  return {
    id: "ship",
    file: "flows/ship.md",
    source: DefinitionSource.project,
    revision: "rev-1",
    title: "Ship it",
    maxRounds: 2,
    nodes: [
      { id: "build", agent: "implementer", provider: null, taskClass: null },
      { id: "review", agent: "reviewer", provider: null, taskClass: null },
    ],
    edges: [
      { from: "build", to: "review", kind: EdgeKind.handsOffTo, gate: false },
    ],
    ...overrides,
  };
}

export function makeFlowsList(overrides: Partial<FlowsList> = {}): FlowsList {
  return {
    flows: [makeFlow()],
    agents: [makeAgent(), makeAgent({ id: "reviewer", role: "Reviews diffs" })],
    errors: [],
    locations: { project: "/home/user/project", library: "/data/library" },
    ...overrides,
  };
}

export function makeCatalogModel(
  overrides: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    providerId: ApiProviderId.groq,
    modelId: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    contextWindow: 131072,
    costIn: 0.59,
    costOut: 0.79,
    free: false,
    trainsOnData: false,
    ...overrides,
  };
}

export function makeModelCatalog(
  overrides: Partial<ModelCatalog> = {},
): ModelCatalog {
  return { models: [makeCatalogModel()], error: null, ...overrides };
}

export function makeVaultStatus(
  overrides: Partial<VaultStatus> = {},
): VaultStatus {
  return { available: true, reason: null, ...overrides };
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sessions: [],
    accounts: [],
    settings: makeSettings(),
    switchLog: [],
    container: { available: true, message: null },
    terminal: null,
    flowRuns: [],
    flowSessions: [],
    editedFiles: [],
    ...overrides,
  };
}
