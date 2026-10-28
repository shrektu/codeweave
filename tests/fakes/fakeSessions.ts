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
