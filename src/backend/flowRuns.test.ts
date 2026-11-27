import { expect, it, vi } from "vitest";

import type { TaskClass } from "../domain/taskClass";
import { emptyUsageLedger } from "../domain/usageLedger";
import {
  EdgeKind,
  FlowRunOrigin,
  PermissionProfile,
  ProviderId,
} from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type { FlowRunView, FlowsList, SessionView } from "../shared/views";
import { fakeSessions } from "../../tests/fakes/fakeSessions";

import type { ConnectionRegistry } from "./connections";
import {
  createFlowRunService,
  type FlowRunService,
  type FlowStartRequest,
} from "./flowRuns";
import type { SessionService } from "./session";

const WORK_DIR = "/work";
const START_PARAMS = { cwd: WORK_DIR, flowId: "solo", task: "Do it" } as const;
const RETAINED_RUNS = 20;
const FLOWS: FlowsList = {
  flows: [
    {
      id: "solo",
      file: "flows/solo.md",
      source: "project",
      revision: "r1",
      title: "Solo",
      maxRounds: 2,
      nodes: [{ id: "build", agent: "coder", provider: null, taskClass: null }],
      edges: [],
    },
  ],
  agents: [
    {
      id: "coder",
      file: "agents/coder.md",
      source: "project",
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
  locations: { project: WORK_DIR, library: "/library" },
};
const RUNNING_VIEW: SessionView = {
  id: "session-1",
  createdAt: 0,
  cwd: WORK_DIR,
  explicitFolder: true,
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
  currentModel: null,
  contextUsage: null,
  usage: emptyUsageLedger(),
  turns: [],
  orchestrate: false,
  imageInput: true,
  canCompact: false,
  prompts: [],
};
const FINISHED_VIEW: SessionView = {
  ...RUNNING_VIEW,
  turnInFlight: false,
  lastTurn: { kind: "ended", stopReason: "end_turn" },
};
const GATED_FLOWS: FlowsList = {
  ...FLOWS,
  flows: [
    {
      id: "gated",
      file: "flows/gated.md",
      source: "project",
      revision: "r3",
      title: "Gated",
      maxRounds: 2,
      nodes: [
        { id: "build", agent: "coder", provider: null, taskClass: null },
        { id: "review", agent: "coder", provider: null, taskClass: null },
      ],
      edges: [
        {
          from: "build",
          to: "review",
          kind: EdgeKind.handsOffTo,
          gate: true,
        },
      ],
    },
  ],
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

function startIn(cwd: string): FlowStartRequest {
  return { ...START_PARAMS, cwd };
}

interface RunSession {
  readonly service: SessionService;
  readonly start: ReturnType<typeof vi.fn<SessionService["start"]>>;
  readonly stop: ReturnType<typeof vi.fn<SessionService["stop"]>>;
  readonly prompt: ReturnType<typeof vi.fn<SessionService["prompt"]>>;
  readonly answerPermission: ReturnType<
    typeof vi.fn<SessionService["answerPermission"]>
  >;
  readonly holdStops: () => PromiseWithResolvers<undefined>;
}

function runSession(
  startResult: () => Promise<SessionView>,
  finishTurns: boolean,
): RunSession {
  const listeners = new Set<(view: SessionView | null) => void>();
  let gate: Promise<undefined> = Promise.resolve(undefined);
  const start = vi.fn<SessionService["start"]>(startResult);
  const prompt = vi.fn<SessionService["prompt"]>(() => {
    if (finishTurns) {
      listeners.forEach((listener) => {
        listener(FINISHED_VIEW);
      });
    }
    return Promise.resolve();
  });
  const answerPermission = vi.fn<SessionService["answerPermission"]>();
  const stop = vi.fn<SessionService["stop"]>(async () => {
    listeners.forEach((listener) => {
      listener(STOPPED_VIEW);
    });
    await gate;
  });
  const service = fakeSessions({
    start,
    prompt,
    stop,
    answerPermission,
    view: () => (finishTurns ? FINISHED_VIEW : RUNNING_VIEW),
    isSettled: () => finishTurns,
    onViewChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    service,
    start,
    stop,
    prompt,
    answerPermission,
    holdStops: () => {
      const held = Promise.withResolvers<undefined>();
      gate = held.promise;
      return held;
    },
  };
}

interface HarnessOptions {
  readonly startResult?: (runId: string) => Promise<SessionView>;
  readonly mainLive?: boolean;
  readonly finishTurns?: boolean;
}

interface Harness {
  readonly service: FlowRunService;
  readonly released: string[];
  readonly broadcast: ReturnType<typeof vi.fn<ConnectionRegistry["broadcast"]>>;
  readonly listing: PromiseWithResolvers<FlowsList>;
  readonly sessionOf: (runId: string) => RunSession;
  readonly listingOf: (cwd: string) => PromiseWithResolvers<FlowsList>;
}

function harness(options: HarnessOptions = {}): Harness {
  const startResult =
    options.startResult ?? (() => Promise.resolve(RUNNING_VIEW));
  const sessions = new Map<string, RunSession>();
  const listings = new Map<string, PromiseWithResolvers<FlowsList>>();
  const released: string[] = [];
  const broadcast = vi.fn<ConnectionRegistry["broadcast"]>();
  let counter = 0;
  const sessionOf = (runId: string): RunSession => {
    const existing = sessions.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const created = runSession(
      () => startResult(runId),
      options.finishTurns ?? false,
    );
    sessions.set(runId, created);
    return created;
  };
  const listingOf = (cwd: string): PromiseWithResolvers<FlowsList> => {
    const existing = listings.get(cwd);
    if (existing !== undefined) {
      return existing;
    }
    const created = Promise.withResolvers<FlowsList>();
    listings.set(cwd, created);
    return created;
  };
  const service = createFlowRunService({
    sessions: (runId) => sessionOf(runId).service,
    releaseSessions: (runId) => {
      released.push(runId);
      return Promise.resolve();
    },
    anyMainSessionLive: () => options.mainLive ?? false,
    listFlows: (cwd = "") => listingOf(cwd).promise,
    inspectWorktree: (cwd) => Promise.resolve({ isRepo: false, cwd }),
    broadcast,
    newRunId: () => {
      counter += 1;
      return `run-${String(counter)}`;
    },
  });
  return {
    service,
    released,
    broadcast,
    listing: listingOf(WORK_DIR),
    sessionOf,
    listingOf,
  };
}

function statusesOf(views: readonly FlowRunView[]): string[] {
  return views.map((view) => view.status);
}

it("flow_runs_stop_during_opening_never_launches", async () => {
  const { service, sessionOf, listing } = harness();

  const started = service.start(START_PARAMS);
  const rejected = expect(started).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  const stopping = service.stop("run-1");
  listing.resolve(FLOWS);
  await stopping;
  await rejected;

  expect(sessionOf("run-1").start).not.toHaveBeenCalled();
  expect(service.view("run-1")).toBeNull();
  expect(service.hasOpenRuns()).toBe(false);
});

it("flow_runs_stop_during_a_runs_opening_cancels_only_that_run", async () => {
  const { service, sessionOf, listingOf } = harness();

  const first = service.start(startIn("/a"));
  const rejected = expect(first).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  const second = service.start(startIn("/b"));
  const stopping = service.stop("run-1");
  listingOf("/a").resolve(FLOWS);
  listingOf("/b").resolve(FLOWS);
  await stopping;
  await rejected;
  await second;

  await vi.waitFor(() => {
    expect(sessionOf("run-2").prompt).toHaveBeenCalledTimes(1);
  });
  expect(sessionOf("run-1").start).not.toHaveBeenCalled();
  expect(service.view("run-1")).toBeNull();
  expect(service.view("run-2")?.status).toBe("running");
  expect(service.hasOpenRuns()).toBe(true);
});

it("flow_runs_shutdown_during_opening_never_launches_and_refuses_later_starts", async () => {
  const { service, sessionOf, listing } = harness();

  const started = service.start(START_PARAMS);
  const rejected = expect(started).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  const closing = service.shutdown();
  listing.resolve(FLOWS);
  await closing;
  await rejected;

  expect(sessionOf("run-1").start).not.toHaveBeenCalled();
  await expect(service.start(START_PARAMS)).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
  });
  expect(service.views()).toEqual([]);
});

it("flow_runs_shutdown_stops_every_run_and_session", async () => {
  const { service, sessionOf, released, listingOf } = harness();
  listingOf("/a").resolve(FLOWS);
  listingOf("/b").resolve(FLOWS);
  await service.start(startIn("/a"));
  await service.start(startIn("/b"));
  await vi.waitFor(() => {
    expect(sessionOf("run-1").prompt).toHaveBeenCalledTimes(1);
    expect(sessionOf("run-2").prompt).toHaveBeenCalledTimes(1);
  });

  await service.shutdown();

  expect(statusesOf(service.views())).toEqual(["stopped", "stopped"]);
  expect(sessionOf("run-1").stop).toHaveBeenCalled();
  expect(sessionOf("run-2").stop).toHaveBeenCalled();
  expect([...new Set(released)].toSorted()).toEqual(["run-1", "run-2"]);
  expect(service.hasOpenRuns()).toBe(false);
});

it("flow_runs_stay_active_until_pump_finishes", async () => {
  const { service, sessionOf, listing } = harness();
  listing.resolve(FLOWS);
  await service.start(START_PARAMS);
  await vi.waitFor(() => {
    expect(sessionOf("run-1").prompt).toHaveBeenCalledTimes(1);
  });
  const stopGate = sessionOf("run-1").holdStops();

  const stopping = service.stop("run-1");

  await vi.waitFor(() => {
    expect(service.view("run-1")?.status).toBe("stopped");
  });
  expect(service.hasOpenRuns()).toBe(true);
  expect(service.isOpen("run-1")).toBe(true);
  stopGate.resolve(undefined);
  await stopping;
  expect(service.hasOpenRuns()).toBe(false);
  expect(service.isOpen("run-1")).toBe(false);
});

it("flow_runs_visit_never_stops_a_session_it_did_not_open", async () => {
  const { service, sessionOf, listing } = harness({
    startResult: () => Promise.reject(ALREADY_RUNNING),
  });
  listing.resolve(FLOWS);

  await service.start(START_PARAMS);
  await vi.waitFor(() => {
    expect(service.view("run-1")?.status).toBe("failed");
  });

  expect(service.view("run-1")?.failure).toBe("A session is already running");
  expect(sessionOf("run-1").stop).not.toHaveBeenCalled();
  expect(service.hasOpenRuns()).toBe(false);
});

it("flow_runs_release_the_runs_sessions_when_its_start_fails", async () => {
  const { service, released, listing } = harness({
    startResult: () => Promise.reject(ALREADY_RUNNING),
  });
  listing.resolve(FLOWS);

  await service.start(START_PARAMS);

  await vi.waitFor(() => {
    expect(released).toEqual(["run-1"]);
  });
  expect(service.view("run-1")?.status).toBe("failed");
});

it("flow_runs_refuse_a_user_run_while_the_main_session_is_live", async () => {
  const { service, listing } = harness({ mainLive: true });
  listing.resolve(FLOWS);

  await expect(service.start(START_PARAMS)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A session is already running",
  });
  const orchestrated = await service.start({
    ...START_PARAMS,
    origin: FlowRunOrigin.orchestrator,
  });

  expect(orchestrated.origin).toBe("orchestrator");
  expect(service.hasOpenRuns()).toBe(true);
  expect(service.hasOpenUserRuns()).toBe(false);
});

it("flow_runs_refuse_a_fourth_open_run", async () => {
  const { service, listingOf } = harness();
  for (const cwd of ["/a", "/b", "/c", "/d"]) {
    listingOf(cwd).resolve(FLOWS);
  }
  await service.start(startIn("/a"));
  await service.start(startIn("/b"));
  await service.start(startIn("/c"));

  await expect(service.start(startIn("/d"))).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "At most 3 flows can run at once",
  });

  expect(service.views()).toHaveLength(3);
  expect(service.hasOpenUserRuns()).toBe(true);
});

it("flow_runs_refuse_a_second_open_run_in_the_same_folder", async () => {
  const { service, listing } = harness();
  listing.resolve(FLOWS);
  await service.start(START_PARAMS);

  await expect(service.start(START_PARAMS)).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is already running in this folder",
  });
});

it("flow_runs_stop_only_stops_the_named_run", async () => {
  const { service, sessionOf, listingOf } = harness();
  listingOf("/a").resolve(FLOWS);
  listingOf("/b").resolve(FLOWS);
  await service.start(startIn("/a"));
  await service.start(startIn("/b"));
  await vi.waitFor(() => {
    expect(sessionOf("run-2").prompt).toHaveBeenCalledTimes(1);
  });

  await service.stop("run-1");

  expect(service.view("run-1")?.status).toBe("stopped");
  expect(service.view("run-2")?.status).toBe("running");
  expect(sessionOf("run-2").stop).not.toHaveBeenCalled();
});

it("flow_runs_route_permission_answers_to_the_runs_own_session", async () => {
  const { service, sessionOf, listing } = harness();
  listing.resolve(FLOWS);
  await service.start(START_PARAMS);

  service.answerPermission("run-1", "req-1", "allow-once");

  expect(sessionOf("run-1").answerPermission).toHaveBeenCalledWith(
    "req-1",
    "allow-once",
  );
  expect(() => {
    service.answerPermission("run-9", "req-1", "allow-once");
  }).toThrow("Unknown flow run");
  await expect(
    service.decide({ runId: "run-9", decision: "stop" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
});

it("flow_runs_broadcast_and_notify_every_state_change_of_their_run", async () => {
  const { service, broadcast, listing } = harness({
    startResult: () => Promise.reject(ALREADY_RUNNING),
  });
  const seen: FlowRunView[] = [];
  service.onChanged((view) => {
    seen.push(view);
  });
  listing.resolve(FLOWS);

  await service.start(START_PARAMS);
  await vi.waitFor(() => {
    expect(service.view("run-1")?.status).toBe("failed");
  });

  expect(statusesOf(seen)).toEqual(["running", "failed"]);
  expect(broadcast.mock.calls.map(([event]) => event)).toEqual([
    "flow/changed",
    "flow/changed",
  ]);
  expect(seen[0]).toMatchObject({
    runId: "run-1",
    origin: "user",
    placement: "in_place",
    branch: null,
  });
});

it("flow_runs_retain_twenty_runs_and_evict_the_oldest_finished_ones", async () => {
  const { service, listingOf } = harness({
    startResult: (runId) =>
      runId === "run-1"
        ? Promise.resolve(RUNNING_VIEW)
        : Promise.reject(ALREADY_RUNNING),
  });
  const cwds = Array.from(
    { length: RETAINED_RUNS + 1 },
    (_, index) => `/w${String(index)}`,
  );
  cwds.forEach((cwd) => {
    listingOf(cwd).resolve(FLOWS);
  });
  const [heldCwd, ...finishedCwds] = cwds;
  if (heldCwd === undefined) {
    throw new Error("the fixture has no folders");
  }
  await service.start(startIn(heldCwd));
  for (const cwd of finishedCwds.slice(0, RETAINED_RUNS - 1)) {
    await service.start(startIn(cwd));
    await vi.waitFor(() => {
      expect(service.hasOpenRuns()).toBe(true);
      expect(service.views().at(-1)?.status).toBe("failed");
    });
  }

  expect(service.views()).toHaveLength(RETAINED_RUNS);
  expect(service.view("run-2")).not.toBeNull();

  const last = finishedCwds.at(-1);
  if (last === undefined) {
    throw new Error("the fixture has no last folder");
  }
  await service.start(startIn(last));
  await vi.waitFor(() => {
    expect(service.views().at(-1)?.status).toBe("failed");
  });

  expect(service.views()).toHaveLength(RETAINED_RUNS);
  expect(service.view("run-1")?.status).toBe("running");
  expect(service.view("run-2")).toBeNull();
  expect(service.view("run-3")).not.toBeNull();
  expect(service.view(`run-${String(RETAINED_RUNS + 1)}`)).not.toBeNull();
});

function withTaskClasses(
  nodeClass: TaskClass | null,
  agentClass: TaskClass | null,
): FlowsList {
  const [flow] = FLOWS.flows;
  const [agent] = FLOWS.agents;
  if (flow === undefined || agent === undefined) {
    throw new Error("the fixture has no flow or agent");
  }
  return {
    ...FLOWS,
    flows: [
      {
        ...flow,
        nodes: [
          {
            id: "build",
            agent: "coder",
            provider: null,
            taskClass: nodeClass,
          },
        ],
      },
    ],
    agents: [{ ...agent, taskClass: agentClass }],
  };
}

it.each([
  { nodeClass: "light", agentClass: "heavy", expected: "light" },
  { nodeClass: null, agentClass: "heavy", expected: "heavy" },
] as const)(
  "flow_runs_toDefinition_keeps_node_task_class_$nodeClass_$agentClass",
  async ({ nodeClass, agentClass, expected }) => {
    const { service, sessionOf, listing } = harness();
    listing.resolve(withTaskClasses(nodeClass, agentClass));

    await service.start(START_PARAMS);

    await vi.waitFor(() => {
      expect(sessionOf("run-1").start).toHaveBeenCalledWith(
        expect.objectContaining({ taskClass: expected }),
      );
    });
  },
);

it("flow_runs_omit_task_class_when_node_and_agent_have_none", async () => {
  const { service, sessionOf, listing } = harness();
  listing.resolve(withTaskClasses(null, null));

  await service.start(START_PARAMS);

  await vi.waitFor(() => {
    expect(sessionOf("run-1").start).toHaveBeenCalledTimes(1);
  });
  expect(sessionOf("run-1").start.mock.calls[0]?.[0]).not.toHaveProperty(
    "taskClass",
  );
});

async function pausedAtGate(): Promise<Harness> {
  const rig = harness({ finishTurns: true });
  rig.listing.resolve(GATED_FLOWS);
  await rig.service.start({ ...START_PARAMS, flowId: "gated" });
  await vi.waitFor(() => {
    expect(rig.service.view("run-1")?.status).toBe("awaiting_decision");
  });
  return rig;
}

it("flow_runs_record_a_decision_with_its_note", async () => {
  const { service } = await pausedAtGate();

  const decided = await service.decide(
    { runId: "run-1", decision: "approve" },
    "The build node matches the task",
  );

  expect(decided.decisions).toEqual([
    {
      nodeId: "review",
      reason: "gate",
      decision: "approve",
      note: "The build node matches the task",
    },
  ]);
  await vi.waitFor(() => {
    expect(service.view("run-1")?.status).toBe("done");
  });
  expect(service.view("run-1")?.decisions).toHaveLength(1);
});

it("flow_runs_record_a_null_note_when_none_is_given", async () => {
  const { service } = await pausedAtGate();

  const decided = await service.decide({ runId: "run-1", decision: "stop" });

  expect(decided.decisions).toEqual([
    { nodeId: "review", reason: "gate", decision: "stop", note: null },
  ]);
});

it("flow_runs_record_nothing_when_the_decision_is_invalid", async () => {
  const { service } = await pausedAtGate();

  await expect(
    service.decide(
      { runId: "run-1", decision: "another_round" },
      "Not allowed at a gate",
    ),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });

  expect(service.view("run-1")?.decisions).toEqual([]);
  expect(service.view("run-1")?.status).toBe("awaiting_decision");
});

it("flow_runs_read_definitions_from_definitions_cwd_but_run_in_cwd", async () => {
  const { service, sessionOf, listingOf } = harness();
  listingOf("/project").resolve(FLOWS);

  const view = await service.start({
    ...START_PARAMS,
    cwd: "/work/worktree",
    definitionsCwd: "/project",
  });

  expect(view.cwd).toBe("/work/worktree");
  await vi.waitFor(() => {
    expect(sessionOf("run-1").start).toHaveBeenCalledTimes(1);
  });
  expect(sessionOf("run-1").start.mock.calls[0]?.[0]).toMatchObject({
    cwd: "/work/worktree",
  });
});

it("flow_runs_carry_the_owner_session_id_and_default_to_null", async () => {
  const { service, listingOf } = harness();
  listingOf("/a").resolve(FLOWS);
  listingOf("/b").resolve(FLOWS);

  const owned = await service.start({
    ...startIn("/a"),
    ownerSessionId: "orchestrator-1",
  });
  const plain = await service.start(startIn("/b"));

  expect(owned.ownerSessionId).toBe("orchestrator-1");
  expect(plain.ownerSessionId).toBeNull();
});
