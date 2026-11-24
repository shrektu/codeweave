import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

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

async function compose(
  beforeLaunch: SessionPoolDeps["beforeLaunch"] = () => Promise.resolve(),
): Promise<Composition> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-pool-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-pool-cwd-"));
  dirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT]);
  const stops: string[] = [];
  const adapter: AgentAdapter = {
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
    beforeLaunch,
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

  const first = pool.forRun("run-1");

  expect(pool.forRun("run-1")).toBe(first);
  expect(pool.forRun("run-2")).not.toBe(first);
  expect(first).not.toBe(pool.main);
});

it("main_views_go_to_session_changed_and_run_views_to_flow_session_changed", async () => {
  const composition = await compose();
  const { pool, cwd } = composition;

  const main = await pool.main.start({ cwd });
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
  await pool.main.start({ cwd });
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
  const { pool, cwd } = await compose(() => {
    const gate = launches[launched];
    launched += 1;
    return gate?.promise ?? Promise.resolve(undefined);
  });
  const mainStart = pool.main.start({ cwd });
  await vi.waitFor(() => {
    expect(launched).toBe(1);
  });
  const nodeStart = pool.forRun("run-1").start({ cwd });
  await vi.waitFor(() => {
    expect(launched).toBe(2);
  });

  firstLaunch.resolve(undefined);
  await mainStart;
  await pool.main.stop();

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
