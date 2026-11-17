import { expect, it, vi } from "vitest";

import { PermissionProfile, ProviderId } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type { FlowsList, SessionView } from "../shared/views";
import { fakeSessions } from "../../tests/fakes/fakeSessions";

import { createFlowRunService, type FlowRunService } from "./flowRuns";
import type { SessionService } from "./session";

const START_PARAMS = { cwd: "/work", flowId: "solo", task: "Do it" } as const;
const FLOWS: FlowsList = {
  flows: [
    {
      id: "solo",
      file: "flows/solo.md",
      revision: "r1",
      title: "Solo",
      maxRounds: 2,
      nodes: [{ id: "build", agent: "coder", provider: null }],
      edges: [],
    },
  ],
  agents: [
    {
      id: "coder",
      file: "agents/coder.md",
      revision: "r2",
      role: "Writes the change",
      provider: ProviderId.claude,
      model: null,
      permissionProfile: PermissionProfile.unattended,
      taskClass: null,
      body: "Write small changes.",
      usedBy: [],
    },
  ],
  errors: [],
};
const RUNNING_VIEW: SessionView = {
  id: "session-1",
  cwd: "/work",
  provider: ProviderId.claude,
  profile: PermissionProfile.unattended,
  phase: { phase: "running", accountId: "acc-a" },
  activeAccountId: "acc-a",
  activeProvider: ProviderId.claude,
  messages: [],
  toolCalls: [],
  permissions: [],
  limits: [],
  lastTurn: null,
  turnInFlight: true,
  flowRef: { flowId: "solo", nodeId: "build" },
};
const STOPPED_VIEW: SessionView = {
  ...RUNNING_VIEW,
  phase: { phase: "stopped" },
  turnInFlight: false,
};
const ALREADY_RUNNING = new IpcError(
  IpcErrorCode.CONFLICT,
  "A session is already running",
);

interface Harness {
  readonly service: FlowRunService;
  readonly sessions: SessionService;
  readonly start: ReturnType<typeof vi.fn<SessionService["start"]>>;
  readonly stop: ReturnType<typeof vi.fn<SessionService["stop"]>>;
  readonly prompt: ReturnType<typeof vi.fn<SessionService["prompt"]>>;
  readonly listing: PromiseWithResolvers<FlowsList>;
  readonly stopGate: PromiseWithResolvers<undefined>;
}

function harness(startResult: () => Promise<SessionView>): Harness {
  const listeners = new Set<(view: SessionView | null) => void>();
  const listing = Promise.withResolvers<FlowsList>();
  const stopGate = Promise.withResolvers<undefined>();
  const start = vi.fn<SessionService["start"]>(startResult);
  const prompt = vi.fn<SessionService["prompt"]>(() => Promise.resolve());
  const stop = vi.fn<SessionService["stop"]>(async () => {
    listeners.forEach((listener) => {
      listener(STOPPED_VIEW);
    });
    await stopGate.promise;
  });
  const sessions = fakeSessions({
    start,
    prompt,
    stop,
    view: () => RUNNING_VIEW,
    onViewChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const service = createFlowRunService({
    sessions,
    listFlows: () => listing.promise,
    inspectWorktree: (cwd) => Promise.resolve({ isRepo: false, cwd }),
    broadcast: () => undefined,
    newRunId: () => "run-1",
  });
  return { service, sessions, start, stop, prompt, listing, stopGate };
}

it("flow_runs_stop_during_opening_never_launches", async () => {
  const { service, start, listing } = harness(() =>
    Promise.resolve(RUNNING_VIEW),
  );

  const started = service.start(START_PARAMS);
  const rejected = expect(started).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  const stopping = service.stop();
  listing.resolve(FLOWS);
  await stopping;
  await rejected;

  expect(start).not.toHaveBeenCalled();
  expect(service.view()).toBeNull();
  expect(service.isActive()).toBe(false);
});

it("flow_runs_shutdown_during_opening_never_launches_and_refuses_later_starts", async () => {
  const { service, start, listing } = harness(() =>
    Promise.resolve(RUNNING_VIEW),
  );

  const started = service.start(START_PARAMS);
  const rejected = expect(started).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  const closing = service.shutdown();
  listing.resolve(FLOWS);
  await closing;
  await rejected;

  expect(start).not.toHaveBeenCalled();
  await expect(service.start(START_PARAMS)).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
  });
  expect(service.view()).toBeNull();
});

it("flow_runs_stays_active_until_pump_finishes", async () => {
  const { service, prompt, listing, stopGate } = harness(() =>
    Promise.resolve(RUNNING_VIEW),
  );
  listing.resolve(FLOWS);
  await service.start(START_PARAMS);
  await vi.waitFor(() => {
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  const stopping = service.stop();

  await vi.waitFor(() => {
    expect(service.view()?.status).toBe("stopped");
  });
  expect(service.isActive()).toBe(true);
  stopGate.resolve(undefined);
  await stopping;
  expect(service.isActive()).toBe(false);
});

it("flow_runs_visit_never_stops_a_session_it_did_not_open", async () => {
  const { service, stop, listing } = harness(() =>
    Promise.reject(ALREADY_RUNNING),
  );
  listing.resolve(FLOWS);

  await service.start(START_PARAMS);
  await vi.waitFor(() => {
    expect(service.view()?.status).toBe("failed");
  });

  expect(service.view()?.failure).toBe("A session is already running");
  expect(stop).not.toHaveBeenCalled();
  expect(service.isActive()).toBe(false);
});
