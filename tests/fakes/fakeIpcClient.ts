import { render, type RenderResult } from "@testing-library/react";
import { createElement, type ReactElement } from "react";

import {
  EffectLevel,
  PermissionProfile,
  ProviderId,
  SwitchReason,
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
  LimitView,
  MessageView,
  PermissionView,
  SessionView,
  SettingsView,
  Snapshot,
  SwitchLogEntryView,
  ToolCallView,
} from "../../src/shared/views";

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
  };
}

export function readyState(snapshot: Snapshot): AppState {
  return { connection: "ready", snapshot, error: null };
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
    runtime: { status: "ready" },
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
    profile: PermissionProfile.ask,
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    ...overrides,
  };
}

export function makeSettings(
  overrides: Partial<SettingsView> = {},
): SettingsView {
  return {
    permissionProfile: PermissionProfile.ask,
    effectLevel: EffectLevel.auto,
    claudeExecutable: null,
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

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    session: null,
    accounts: [],
    settings: makeSettings(),
    switchLog: [],
    container: { available: true, message: null },
    ...overrides,
  };
}
