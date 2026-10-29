import type { LimitProbeService } from "../../src/backend/limitProbe";
import type { SessionService } from "../../src/backend/session";

export function fakeSessions(
  overrides: Partial<SessionService> = {},
): SessionService {
  return {
    view: () => null,
    start: () => Promise.reject(new Error("not available in this test")),
    prompt: () => Promise.reject(new Error("not available in this test")),
    stop: () => Promise.resolve(),
    answerPermission: () => undefined,
    isInUse: () => false,
    runtimeOf: () => ({ status: "ready" }),
    onRuntimeChanged: () => () => undefined,
    setAccounts: () => undefined,
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
    runtimeOf: () => null,
    onChanged: () => () => undefined,
    dispose: () => Promise.resolve(),
    ...overrides,
  };
}
