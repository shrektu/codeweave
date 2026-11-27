import type { FlowRunService } from "../../src/backend/flowRuns";
import type { LimitProbeService } from "../../src/backend/limitProbe";
import type { SessionService } from "../../src/backend/session";
import type { SessionHistory } from "../../src/backend/sessionHistory";
import type { SessionPool } from "../../src/backend/sessionPool";
import type { TerminalService } from "../../src/backend/terminal/service";

export function fakeSessions(
  overrides: Partial<SessionService> = {},
): SessionService {
  return {
    view: () => null,
    start: () => Promise.reject(new Error("not available in this test")),
    prompt: () => Promise.reject(new Error("not available in this test")),
    compact: () => Promise.reject(new Error("not available in this test")),
    stop: () => Promise.resolve(),
    answerPermission: () => undefined,
    isInUse: () => false,
    ownRuntimeOf: () => null,
    onRuntimeChanged: () => () => undefined,
    onViewChanged: () => () => undefined,
    isLive: () => false,
    isSettled: () => false,
    nativeSessions: () => [],
    setAccounts: () => undefined,
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
}

export function fakeSessionPool(
  main: SessionService = fakeSessions(),
  overrides: Partial<SessionPool> = {},
): SessionPool {
  return {
    createMain: () => main,
    discardMain: () => Promise.resolve(),
    main: () => main,
    mainViews: () => {
      const view = main.view();
      return view === null ? [] : [view];
    },
    anyMainLive: () => main.isLive(),
    settleEnded: () => Promise.resolve(),
    closeMain: () => Promise.resolve(),
    forRun: () => main,
    release: () => Promise.resolve(),
    isInUse: () => false,
    runtimeOf: () => ({ status: "ready" }),
    runViews: () => [],
    onRuntimeChanged: () => () => undefined,
    setAccounts: () => undefined,
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
}

export function fakeSessionHistory(
  overrides: Partial<SessionHistory> = {},
): SessionHistory {
  return {
    record: () => undefined,
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    setArchived: () => Promise.reject(new Error("not available in this test")),
    setArchivedIfPresent: () => Promise.resolve(),
    truncate: () => Promise.resolve(null),
    flush: () => Promise.resolve(),
    ...overrides,
  };
}

export function fakeFlowRuns(
  overrides: Partial<FlowRunService> = {},
): FlowRunService {
  return {
    views: () => [],
    view: () => null,
    start: () => Promise.reject(new Error("not available in this test")),
    stop: () => Promise.resolve(),
    stopAll: () => Promise.resolve(),
    decide: () => Promise.reject(new Error("not available in this test")),
    answerPermission: () => undefined,
    isOpen: () => false,
    hasOpenRuns: () => false,
    hasOpenUserRuns: () => false,
    onChanged: () => () => undefined,
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
}

export function fakeTerminals(
  overrides: Partial<TerminalService> = {},
): TerminalService {
  return {
    view: () => null,
    open: () => Promise.reject(new Error("not available in this test")),
    input: () => undefined,
    resize: () => undefined,
    ack: () => undefined,
    detach: () => undefined,
    close: () => Promise.resolve({ closed: false }),
    retarget: () => Promise.resolve(),
    detachAll: () => undefined,
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
}

export function fakeProbes(
  overrides: Partial<LimitProbeService> = {},
): LimitProbeService {
  return {
    start: () => undefined,
    trigger: () => undefined,
    release: () => Promise.resolve(),
    isBlocked: () => false,
    limitOf: () => null,
    availabilityOf: () => "pending",
    runtimeOf: () => null,
    onChanged: () => () => undefined,
    dispose: () => Promise.resolve(),
    ...overrides,
  };
}
