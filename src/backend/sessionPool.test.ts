import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import type { AccountRuntime } from "../domain/rotation";
import { ProviderId, type Account } from "../domain/types";
import { SessionViewSchema } from "../shared/views";

import type { AgentAdapter, AgentHandle } from "./agentAdapter";
import type { ConnectionRegistry } from "./connections";
import { createLeaseModes } from "./leaseModes";
import {
  combineRuntimes,
  createSessionPool,
  type SessionPool,
  type SessionPoolDeps,
} from "./sessionPool";
import { createJsonStore } from "./storage";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = 1_700_000_000;
const ACCOUNT: Account = {
  id: "acc-a",
  provider: ProviderId.claude,
  label: "A",
  configDir: "/cfg/a",
  order: 0,
};

interface Composition {
  readonly pool: SessionPool;
  readonly cwd: string;
  readonly broadcast: ReturnType<typeof vi.fn<ConnectionRegistry["broadcast"]>>;
  readonly stops: string[];
}

const dirs: string[] = [];
const pools: SessionPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function handleOf(
  runId: string,
  accountId: string,
  stops: string[],
): AgentHandle {
  return {
    accountId,
    runId,
    subscribe: () => () => undefined,
    prompt: () => Promise.resolve(),
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: () => {
      stops.push(runId);
      return Promise.resolve({ ok: true });
    },
  };
}

interface Emitter {
  listener: ((event: AgentEvent) => void) | null;
}

function haltingAdapter(stops: string[], emitter: Emitter): AgentAdapter {
  return {
    start: (spec) =>
      Promise.resolve({
        ok: true,
        handle: {
          ...handleOf(spec.runId, spec.account.id, stops),
          subscribe: (listener) => {
            emitter.listener = listener;
            return () => {
              emitter.listener = null;
            };
          },
          prompt: () => {
            queueMicrotask(() => {
              emitter.listener?.({
                type: "turn_error",
                message: "Needs login",
                errorKind: "auth_required",
                rpcCode: null,
              });
            });
            return Promise.resolve();
          },
        },
      }),
  };
}

function exitingAdapter(stops: string[], emitter: Emitter): AgentAdapter {
  return {
    start: (spec) =>
      Promise.resolve({
        ok: true,
        handle: {
          ...handleOf(spec.runId, spec.account.id, stops),
          subscribe: (listener) => {
            emitter.listener = listener;
            return () => {
              emitter.listener = null;
            };
          },
          prompt: () => {
            queueMicrotask(() => {
              emitter.listener?.({ type: "process_exit" });
            });
            return Promise.resolve();
          },
        },
      }),
  };
}

interface ComposeOptions {
  readonly beforeLaunch?: SessionPoolDeps["beforeLaunch"];
  readonly adapter?: AgentAdapter;
}

async function compose(options: ComposeOptions = {}): Promise<Composition> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-pool-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-pool-cwd-"));
  dirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT]);
  const stops: string[] = [];
  const adapter: AgentAdapter = options.adapter ?? {
    start: (spec) =>
      Promise.resolve({
        ok: true,
        handle: handleOf(spec.runId, spec.account.id, stops),
      }),
  };
  const broadcast = vi.fn<ConnectionRegistry["broadcast"]>();
  let counter = 0;
  const pool = createSessionPool({
    adapter,
    store,
    broadcast,
    now: () => NOW_MS,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => {
      counter += 1;
      return `agent-${String(counter)}`;
    },
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: options.beforeLaunch ?? (() => Promise.resolve()),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder: (requested) => Promise.resolve(requested ?? "/home/u"),
    protectedPaths: () => Promise.resolve([]),
    leaseModes: createLeaseModes(),
  });
  pools.push(pool);
  return { pool, cwd, broadcast, stops };
}

function eventsOf(composition: Composition, event: string): unknown[] {
  return composition.broadcast.mock.calls
    .filter(([name]) => name === event)
    .map(([, payload]) => payload);
}

it("for_run_creates_an_instance_once_per_run_and_never_returns_the_main_one", async () => {
  const { pool } = await compose();
  const main = pool.createMain();

  const first = pool.forRun("run-1");

  expect(pool.forRun("run-1")).toBe(first);
  expect(pool.forRun("run-2")).not.toBe(first);
  expect(first).not.toBe(main);
});

it("main_views_go_to_session_changed_and_run_views_to_flow_session_changed", async () => {
  const composition = await compose();
  const { pool, cwd } = composition;

  const main = await pool.createMain().start({ cwd });
  const node = await pool.forRun("run-1").start({ cwd });

  const sessionEvents = eventsOf(composition, "session/changed");
  expect(sessionEvents.length).toBeGreaterThan(0);
  expect(
    sessionEvents.every(
      (payload) => SessionViewSchema.parse(payload).id === main.id,
    ),
  ).toBe(true);
  const runEvents = eventsOf(composition, "flowSession/changed");
  expect(runEvents.length).toBeGreaterThan(0);
  expect(runEvents).toContainEqual({ runId: "run-1", view: node });
  expect(
    runEvents.every((payload) => {
      const event = payload as { runId: string };
      return event.runId === "run-1";
    }),
  ).toBe(true);
  expect(pool.runViews()).toEqual([{ runId: "run-1", view: node }]);
});

it("release_stops_the_instance_publishes_a_removal_and_forgets_it", async () => {
  const composition = await compose();
  const { pool, cwd, stops } = composition;
  const first = pool.forRun("run-1");
  await first.start({ cwd });
  expect(pool.isInUse(ACCOUNT.id)).toBe(true);

  await pool.release("run-1");

  expect(stops).toEqual(["agent-1"]);
  expect(eventsOf(composition, "flowSession/changed").at(-1)).toEqual({
    runId: "run-1",
    view: null,
  });
  expect(pool.isInUse(ACCOUNT.id)).toBe(false);
  expect(pool.runViews()).toEqual([]);
  expect(pool.forRun("run-1")).not.toBe(first);
});

it("release_of_an_unknown_run_does_nothing", async () => {
  const composition = await compose();

  await composition.pool.release("run-9");

  expect(composition.broadcast).not.toHaveBeenCalled();
});

it("no_view_is_published_for_a_released_instance", async () => {
  const composition = await compose();
  const { pool, cwd } = composition;
  const instance = pool.forRun("run-1");
  await instance.start({ cwd });
  await pool.release("run-1");
  const before = composition.broadcast.mock.calls.length;

  await instance.stop();

  expect(composition.broadcast.mock.calls.length).toBe(before);
});

it("is_in_use_covers_the_main_session_and_every_run", async () => {
  const { pool, cwd } = await compose();
  expect(pool.isInUse(ACCOUNT.id)).toBe(false);

  await pool.forRun("run-1").start({ cwd });

  expect(pool.isInUse(ACCOUNT.id)).toBe(true);
  expect(pool.isInUse("acc-other")).toBe(false);
});

it("on_runtime_changed_fires_when_a_run_instance_is_released", async () => {
  const { pool, cwd } = await compose();
  const listener = vi.fn<() => void>();
  const unsubscribe = pool.onRuntimeChanged(listener);
  await pool.forRun("run-1").start({ cwd });

  await pool.release("run-1");

  expect(listener).toHaveBeenCalled();
  unsubscribe();
  listener.mockClear();
  await pool.forRun("run-2").start({ cwd });
  await pool.release("run-2");
  expect(listener).not.toHaveBeenCalled();
});

it("shutdown_stops_the_main_session_and_every_run_session", async () => {
  const { pool, cwd, stops } = await compose();
  await pool.createMain().start({ cwd });
  await pool.forRun("run-1").start({ cwd });
  await pool.forRun("run-2").start({ cwd });

  await pool.shutdown();

  expect(stops.toSorted()).toEqual(["agent-1", "agent-2", "agent-3"]);
  expect(pool.runViews()).toEqual([]);
});

const READY: AccountRuntime = { status: "ready" };
it("account_stays_in_use_while_a_second_instance_still_launches_on_it", async () => {
  const firstLaunch = Promise.withResolvers<undefined>();
  const secondLaunch = Promise.withResolvers<undefined>();
  const launches = [firstLaunch, secondLaunch];
  let launched = 0;
  const { pool, cwd } = await compose({
    beforeLaunch: () => {
      const gate = launches[launched];
      launched += 1;
      return gate?.promise ?? Promise.resolve(undefined);
    },
  });
  const main = pool.createMain();
  const mainStart = main.start({ cwd });
  await vi.waitFor(() => {
    expect(launched).toBe(1);
  });
  const nodeStart = pool.forRun("run-1").start({ cwd });
  await vi.waitFor(() => {
    expect(launched).toBe(2);
  });

  firstLaunch.resolve(undefined);
  await mainStart;
  await main.stop();

  try {
    expect(pool.isInUse(ACCOUNT.id)).toBe(true);
  } finally {
    secondLaunch.resolve(undefined);
    await nodeStart;
  }
});

const NEEDS_LOGIN: AccountRuntime = { status: "needs_login" };
const EXHAUSTED_LATER: AccountRuntime = {
  status: "exhausted",
  resetsAt: NOW_SECONDS + 600,
};
const EXHAUSTED_EARLIER: AccountRuntime = {
  status: "exhausted",
  resetsAt: NOW_SECONDS + 60,
};

it.each([
  { label: "no runtimes", own: [], external: null, expected: READY },
  {
    label: "two ready instances",
    own: [READY, READY],
    external: null,
    expected: READY,
  },
  {
    label: "one exhausted instance",
    own: [READY, EXHAUSTED_LATER],
    external: null,
    expected: EXHAUSTED_LATER,
  },
  {
    label: "the later reset of two exhausted instances",
    own: [EXHAUSTED_EARLIER, EXHAUSTED_LATER],
    external: null,
    expected: EXHAUSTED_LATER,
  },
  {
    label: "a login need on the second instance",
    own: [READY, NEEDS_LOGIN],
    external: EXHAUSTED_LATER,
    expected: NEEDS_LOGIN,
  },
  {
    label: "an external exhaustion beside ready instances",
    own: [READY, READY],
    external: EXHAUSTED_EARLIER,
    expected: EXHAUSTED_EARLIER,
  },
] as const)(
  "combine_runtimes_merges_instances_$label",
  ({ own, external, expected }) => {
    expect(combineRuntimes(own, external, NOW_MS)).toEqual(expected);
  },
);

it("pool_reports_main_and_run_views_to_observers", async () => {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-pool-obs-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-pool-obs-cwd-"));
  dirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT]);
  const mainViews: ReturnType<ReturnType<SessionPool["createMain"]>["view"]>[] =
    [];
  const runViews: {
    runId: string;
    view: ReturnType<ReturnType<SessionPool["createMain"]>["view"]>;
  }[] = [];
  const pool = createSessionPool({
    adapter: {
      start: (spec) =>
        Promise.resolve({
          ok: true,
          handle: handleOf(spec.runId, spec.account.id, []),
        }),
    },
    store,
    broadcast: vi.fn<ConnectionRegistry["broadcast"]>(),
    now: () => NOW_MS,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => "agent-obs",
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: userData,
    resolveFolder: (requested) => Promise.resolve(requested ?? cwd),
    protectedPaths: () => Promise.resolve([]),
    leaseModes: createLeaseModes(),
    onMainView: (view) => {
      mainViews.push(view);
    },
    onRunView: (runId, view) => {
      runViews.push({ runId, view });
    },
  });
  pools.push(pool);

  await pool.createMain().start({ cwd });
  await pool.forRun("run-obs").start({ cwd });

  expect(mainViews.some((view) => view !== null)).toBe(true);
  expect(
    runViews.some((entry) => entry.runId === "run-obs" && entry.view !== null),
  ).toBe(true);
});

it("create_main_registers_and_main_lookup_before_start_returns_null", async () => {
  const { pool, cwd } = await compose();
  const service = pool.createMain();

  expect(pool.main("unknown")).toBeNull();
  expect(pool.mainViews()).toEqual([]);
  expect(pool.anyMainLive()).toBe(false);

  const started = await service.start({ cwd });

  expect(pool.main(started.id)).toBe(service);
  expect(pool.mainViews()).toHaveLength(1);
  expect(pool.anyMainLive()).toBe(true);
});

it("discard_main_unregisters_without_broadcasting", async () => {
  const composition = await compose();
  const { pool, cwd } = composition;
  const service = pool.createMain();

  await service.start({ cwd });
  const beforeCount = eventsOf(composition, "session/changed").length;
  await pool.discardMain(service);

  expect(pool.mainViews()).toEqual([]);
  expect(eventsOf(composition, "session/changed")).toHaveLength(beforeCount);
});

it("close_main_rejects_unknown_or_live_and_removes_ended_session", async () => {
  const composition = await compose();
  const { pool, cwd } = composition;

  await expect(pool.closeMain("missing")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  const service = pool.createMain();
  const started = await service.start({ cwd });
  await expect(pool.closeMain(started.id)).rejects.toMatchObject({
    code: "CONFLICT",
  });

  await service.stop();
  await pool.closeMain(started.id);

  expect(pool.main(started.id)).toBeNull();
  expect(eventsOf(composition, "session/removed")).toContainEqual({
    sessionId: started.id,
  });
});

it("double_close_is_not_found", async () => {
  const { pool, cwd } = await compose();
  const service = pool.createMain();
  const started = await service.start({ cwd });
  await service.stop();

  await pool.closeMain(started.id);
  await expect(pool.closeMain(started.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("publish_after_close_is_ignored", async () => {
  const composition = await compose();
  const { pool, cwd } = composition;
  const service = pool.createMain();
  const started = await service.start({ cwd });
  await service.stop();
  await pool.closeMain(started.id);

  const before = eventsOf(composition, "session/changed").length;
  await service.stop();

  expect(eventsOf(composition, "session/changed")).toHaveLength(before);
});

it("settle_ended_stops_lingering_agents", async () => {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-pool-halt-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-pool-halt-cwd-"));
  dirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT]);
  const stops: string[] = [];
  const emitter: Emitter = { listener: null };
  const pool = createSessionPool({
    adapter: haltingAdapter(stops, emitter),
    store,
    broadcast: vi.fn(),
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => "agent-1",
    resolveExecutable: () => "/bin/true",
    stopGraceMs: 1000,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder: (requested) => Promise.resolve(requested ?? "/home/u"),
    protectedPaths: () => Promise.resolve([]),
    leaseModes: createLeaseModes(),
  });
  pools.push(pool);
  const service = pool.createMain();
  await service.start({ cwd });
  await service.prompt("go");

  await vi.waitFor(() => {
    expect(service.isLive()).toBe(false);
  });
  expect(service.isSettled()).toBe(false);
  expect(stops).toEqual([]);

  await pool.settleEnded();

  expect(stops).toEqual(["agent-1"]);
  expect(service.view()?.phase.phase).toBe("stopped");
});

it("settle_ended_keeps_failed_session_failure", async () => {
  const stops: string[] = [];
  const emitter: Emitter = { listener: null };
  const { pool, cwd } = await compose({
    adapter: exitingAdapter(stops, emitter),
  });
  const service = pool.createMain();
  await service.start({ cwd });
  await service.prompt("go");
  const failedPhase = {
    phase: "failed",
    reason: "Agent process exited",
    runningAccountId: ACCOUNT.id,
  };

  await vi.waitFor(() => {
    expect(service.view()?.phase).toEqual(failedPhase);
  });
  await pool.settleEnded();

  expect(service.view()?.phase).toEqual(failedPhase);
  expect(stops).toEqual([]);
});
