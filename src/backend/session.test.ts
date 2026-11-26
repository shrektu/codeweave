import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import type { ApiAuth } from "../domain/apiProviders";
import { ProviderId, type Account } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import { settled } from "../../tests/fakes/settle";

import type { AgentAdapter, AgentHandle, AgentStartSpec } from "./agentAdapter";
import { createAccountReservations } from "./accountReservations";
import { SESSION_START_STOPPED_MESSAGE } from "./constants";
import { createLeaseModes } from "./leaseModes";
import { StopFailureReason, type StopResult } from "./process/container";
import {
  createSessionService,
  type SessionService,
  type SessionServiceDeps,
} from "./session";
import { ProbeStillRunningError } from "./limitProbe";
import { createJsonStore, type JsonStore } from "./storage";

const NOW_MS = 1_700_000_000_000;
const GRACE_MS = 10;
const ACCOUNT_A: Account = {
  id: "acc-a",
  provider: ProviderId.claude,
  label: "A",
  configDir: "/cfg/a",
  order: 0,
};
const ACCOUNT_B: Account = { ...ACCOUNT_A, id: "acc-b", label: "B", order: 1 };
const NEEDS_LOGIN: AgentEvent = {
  type: "turn_error",
  errorKind: "auth_required",
  rpcCode: null,
  message: "login",
};
const RATE_LIMITED: AgentEvent = {
  type: "turn_error",
  errorKind: "rate_limit",
  rpcCode: null,
  message: "usage limit reached",
};
const ACCOUNTS_READ = "accounts:read";
const START_STOPPED = {
  code: IpcErrorCode.CONFLICT,
  message: SESSION_START_STOPPED_MESSAGE,
};
const STOP_FAILED: StopResult = {
  ok: false,
  reason: StopFailureReason.notEmptyAfterTimeout,
  survivors: [1],
};

interface Setup {
  readonly service: SessionService;
  readonly store: JsonStore;
  readonly log: string[];
  readonly cwd: string;
  readonly specs: AgentStartSpec[];
  readonly broadcasts: unknown[];
}

interface SetupOptions {
  readonly accounts?: readonly Account[];
  readonly resolveExecutable?: SessionServiceDeps["resolveExecutable"];
  readonly events: Readonly<Record<string, readonly AgentEvent[]>>;
  readonly stopResult?: StopResult;
  readonly stopGate?: Promise<void>;
  readonly startGate?: Promise<void>;
  readonly beforeLaunch?: SessionServiceDeps["beforeLaunch"];
  readonly isBlocked?: SessionServiceDeps["isBlocked"];
  readonly startGateFor?: Readonly<Record<string, Promise<void>>>;
  readonly stopResultFor?: Readonly<Record<string, StopResult>>;
  readonly onSubscribe?: (accountId: string) => void;
  readonly appendGate?: Promise<void>;
  readonly appendError?: Error;
  readonly stopGates?: readonly Promise<void>[];
  readonly accountsGate?: Promise<void>;
  readonly hasKey?: SessionServiceDeps["hasKey"];
  readonly resolveFolder?: SessionServiceDeps["resolveFolder"];
}

const tempDirs: string[] = [];
const services: SessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function fakeHandle(
  spec: AgentStartSpec,
  options: SetupOptions,
  log: string[],
  stopGates: Promise<void>[],
): AgentHandle {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    accountId: spec.account.id,
    nativeSessionId: null,
    resumed: false,
    runId: spec.runId,
    subscribe: (listener) => {
      options.onSubscribe?.(spec.account.id);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: () => {
      for (const event of options.events[spec.account.id] ?? []) {
        listeners.forEach((listener) => {
          listener(event);
        });
      }
      return Promise.resolve();
    },
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: async () => {
      log.push(`stop:${spec.runId}`);
      await (stopGates.shift() ?? options.stopGate);
      return (
        options.stopResultFor?.[spec.account.id] ??
        options.stopResult ?? { ok: true }
      );
    },
  };
}

async function setup(options: SetupOptions): Promise<Setup> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-session-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-session-cwd-"));
  tempDirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts(options.accounts ?? [ACCOUNT_A]);
  const log: string[] = [];
  const specs: AgentStartSpec[] = [];
  const stopGates = [...(options.stopGates ?? [])];
  const broadcasts: unknown[] = [];
  const observeAppends =
    options.appendGate !== undefined || options.appendError !== undefined;
  const appendObserved: JsonStore = observeAppends
    ? {
        ...store,
        appendSwitchLog: async (entry) => {
          log.push("append:start");
          await options.appendGate;
          if (options.appendError !== undefined) {
            throw options.appendError;
          }
          await store.appendSwitchLog(entry);
          log.push("append:done");
        },
      }
    : store;
  const sessionStore: JsonStore =
    options.accountsGate === undefined
      ? appendObserved
      : {
          ...appendObserved,
          readAccounts: async () => {
            log.push(ACCOUNTS_READ);
            await options.accountsGate;
            return appendObserved.readAccounts();
          },
        };
  const adapter: AgentAdapter = {
    start: async (spec) => {
      specs.push(spec);
      log.push(`start:${spec.runId}`);
      await options.startGate;
      await options.startGateFor?.[spec.account.id];
      return { ok: true, handle: fakeHandle(spec, options, log, stopGates) };
    },
  };
  let runs = 0;
  const service = createSessionService({
    adapter,
    store: sessionStore,
    broadcast: () => undefined,
    publishView: (view) => {
      broadcasts.push(view);
    },
    reserved: createAccountReservations(),
    leaseModes: createLeaseModes(),
    now: () => NOW_MS,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => {
      runs += 1;
      return `run-${String(runs)}`;
    },
    resolveExecutable: options.resolveExecutable ?? (() => "/usr/bin/claude"),
    stopGraceMs: GRACE_MS,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: options.beforeLaunch ?? (() => Promise.resolve()),
    isBlocked: options.isBlocked ?? (() => false),
    hasKey: options.hasKey ?? (() => true),
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder:
      options.resolveFolder ??
      ((requested) => Promise.resolve(requested ?? "/home/u")),
    protectedPaths: () => Promise.resolve([]),
  });
  services.push(service);
  return { service, store, log, cwd, specs, broadcasts };
}

async function haltedSession(options: SetupOptions): Promise<Setup> {
  const rig = await setup(options);
  await rig.service.start({ cwd: rig.cwd });
  await rig.service.prompt("go");
  await vi.waitFor(() => {
    expect(rig.service.view()?.phase).toEqual({ phase: "halted" });
  });
  await rig.store.writeAccounts([ACCOUNT_A, ACCOUNT_B]);
  return rig;
}

it("start_after_halt_stops_old_agent_first", async () => {
  const rig = await haltedSession({ events: { "acc-a": [NEEDS_LOGIN] } });
  expect(rig.log).toEqual(["start:run-1"]);

  const view = await rig.service.start({ cwd: rig.cwd });

  expect(rig.log).toEqual(["start:run-1", "stop:run-1", "start:run-2"]);
  expect(view.phase).toEqual({ phase: "running", accountId: ACCOUNT_B.id });
});

it("start_after_halt_rejected_when_old_agent_does_not_stop", async () => {
  const rig = await haltedSession({
    events: { "acc-a": [NEEDS_LOGIN] },
    stopResult: STOP_FAILED,
  });

  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "The previous agent is still running",
  });

  expect(rig.log).toEqual(["start:run-1", "stop:run-1"]);
});

it("account_remove_rejected_while_switching: isInUse true for any id", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({
    events: { "acc-a": [RATE_LIMITED] },
    stopGate: gate.promise,
  });
  await rig.store.writeAccounts([ACCOUNT_A, ACCOUNT_B]);
  await rig.service.start({ cwd: rig.cwd });
  expect(rig.service.isInUse(ACCOUNT_B.id)).toBe(false);

  await rig.service.prompt("go");
  await vi.waitFor(() => {
    expect(rig.log).toContain("stop:run-1");
  });

  try {
    expect(rig.service.view()?.phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_A.id,
    });
    expect(rig.service.isInUse(ACCOUNT_B.id)).toBe(true);
    expect(rig.service.isInUse("ghost")).toBe(true);
  } finally {
    gate.resolve(undefined);
  }
  await vi.waitFor(() => {
    expect(rig.service.view()?.phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_B.id,
    });
    expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(false);
  });
});

it("launching_account_counts_as_in_use", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({ events: {}, startGate: gate.promise });
  const starting = rig.service.start({ cwd: rig.cwd });
  try {
    await vi.waitFor(() => {
      expect(rig.specs).toHaveLength(1);
    });

    expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(true);
    expect(rig.service.isInUse(ACCOUNT_B.id)).toBe(false);
  } finally {
    gate.resolve(undefined);
  }
  await starting;
  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(true);
});

it("launch_reservation_is_released_when_the_launch_fails", async () => {
  const rig = await setup({
    events: {},
    resolveExecutable: () => {
      throw new IpcError(IpcErrorCode.UNAVAILABLE, "no executable");
    },
  });

  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    message: "no executable",
  });

  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(false);
});

it("release_failure_fails_the_launch_without_starting_an_agent", async () => {
  const rig = await setup({
    events: {},
    beforeLaunch: () =>
      Promise.reject(
        new Error("The limit probe for this account is still running"),
      ),
  });

  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message:
      "Could not start the agent: The limit probe for this account is still running",
  });

  expect(rig.specs).toEqual([]);
  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(false);
});

it("is_in_use_follows_live_handles", async () => {
  const rig = await haltedSession({ events: { "acc-a": [NEEDS_LOGIN] } });

  expect(rig.service.view()?.phase).toEqual({ phase: "halted" });
  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(true);
  expect(rig.service.isInUse(ACCOUNT_B.id)).toBe(false);
});

const CODEX_A: Account = {
  id: "codex-a",
  provider: ProviderId.codex,
  label: "Codex A",
  configDir: "/cfg/codex-a",
  order: 0,
};
const CLAUDE_X: Account = {
  id: "claude-x",
  provider: ProviderId.claude,
  label: "Claude X",
  configDir: "/cfg/claude-x",
  order: 1,
};
const CODEX_B: Account = {
  ...CODEX_A,
  id: "codex-b",
  label: "Codex B",
  order: 2,
};

it("spawn_resolves_the_executable_of_the_accounts_provider", async () => {
  const resolveExecutable: SessionServiceDeps["resolveExecutable"] = (
    provider,
    configured,
  ) => `${provider}:${configured ?? "path"}`;
  const codex = await setup({
    accounts: [CODEX_A],
    events: {},
    resolveExecutable,
  });
  await codex.store.writeSettings({
    ...(await codex.store.readSettings()),
    claudeExecutable: "/opt/claude",
    codexExecutable: "/opt/codex",
  });
  const claude = await setup({ events: {}, resolveExecutable });

  await codex.service.start({ cwd: codex.cwd });
  await claude.service.start({ cwd: claude.cwd });

  expect(codex.specs.map((spec) => spec.executable)).toEqual([
    "codex:/opt/codex",
  ]);
  expect(claude.specs.map((spec) => spec.executable)).toEqual(["claude:path"]);
});

it("set_accounts_during_codex_run_keeps_rotation_on_codex", async () => {
  const rig = await setup({
    accounts: [CODEX_A],
    events: { "codex-a": [RATE_LIMITED] },
  });
  await rig.service.start({ cwd: rig.cwd, provider: ProviderId.codex });

  rig.service.setAccounts([CODEX_A, CLAUDE_X, CODEX_B]);
  await rig.service.prompt("go");

  await vi.waitFor(() => {
    expect(rig.service.view()?.phase).toEqual({
      phase: "running",
      accountId: CODEX_B.id,
    });
  });
  expect(rig.specs.map((spec) => spec.account.id)).toEqual([
    "codex-a",
    "codex-b",
  ]);
  expect(rig.service.view()?.provider).toBe(ProviderId.codex);
});

const ACCOUNT_C: Account = { ...ACCOUNT_A, id: "acc-c", label: "C", order: 2 };
const PUBLISH_HOPS = 40;

it("is_in_use_covers_run_until_published", async () => {
  const observed: boolean[] = [];
  let service: SessionService | null = null;
  const observe = async (): Promise<void> => {
    for (let hop = 0; hop < PUBLISH_HOPS; hop += 1) {
      await Promise.resolve();
      observed.push(service?.isInUse(ACCOUNT_A.id) ?? false);
    }
  };
  const rig = await setup({
    events: {},
    onSubscribe: () => {
      void observe();
    },
  });
  service = rig.service;

  await rig.service.start({ cwd: rig.cwd });

  await vi.waitFor(() => {
    expect(observed).toHaveLength(PUBLISH_HOPS);
  });
  expect(observed.filter((inUse) => !inUse)).toEqual([]);
});

it("closed_launch_with_survivors_stays_in_use", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: { "acc-a": [RATE_LIMITED] },
    startGateFor: { "acc-b": gate.promise },
    stopResultFor: { "acc-b": STOP_FAILED },
  });
  await rig.service.start({ cwd: rig.cwd });
  await rig.service.prompt("go");
  await vi.waitFor(() => {
    expect(rig.specs).toHaveLength(2);
  });

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(rig.service.isInUse(ACCOUNT_B.id)).toBe(true);
  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "The previous agent is still running",
  });
});

it("start_skips_blocked_account", async () => {
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: {},
    isBlocked: (accountId) => accountId === ACCOUNT_A.id,
  });

  const view = await rig.service.start({ cwd: rig.cwd });

  expect(view.activeAccountId).toBe(ACCOUNT_B.id);
  expect(rig.specs.map((spec) => spec.account.id)).toEqual(["acc-b"]);
});

it("start_with_every_account_blocked_reports_no_usable_account", async () => {
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: {},
    isBlocked: () => true,
  });

  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No usable account",
  });

  expect(rig.specs).toEqual([]);
});

it("start_moves_on_when_initial_probe_turns_unstopped", async () => {
  let blocked = false;
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: {},
    isBlocked: (accountId) => accountId === ACCOUNT_A.id && blocked,
    beforeLaunch: (accountId) => {
      if (accountId !== ACCOUNT_A.id) {
        return Promise.resolve();
      }
      blocked = true;
      return Promise.reject(new ProbeStillRunningError());
    },
  });

  const view = await rig.service.start({ cwd: rig.cwd });

  expect(view.activeAccountId).toBe(ACCOUNT_B.id);
  expect(rig.specs.map((spec) => spec.account.id)).toEqual(["acc-b"]);
  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(false);
});

it("start_fails_once_when_unavailable_account_is_not_blocked", async () => {
  const launched: string[] = [];
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: {},
    beforeLaunch: (accountId) => {
      launched.push(accountId);
      return Promise.reject(new ProbeStillRunningError());
    },
  });

  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    code: IpcErrorCode.UNAVAILABLE,
    message: expect.stringContaining("Could not start the agent:") as string,
  });

  expect(launched).toEqual(["acc-a"]);
  expect(rig.specs).toEqual([]);
});

it("rotation_skips_target_blocked_by_a_running_probe", async () => {
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C],
    events: { "acc-a": [RATE_LIMITED] },
    beforeLaunch: (accountId) =>
      accountId === ACCOUNT_B.id
        ? Promise.reject(new ProbeStillRunningError())
        : Promise.resolve(),
  });
  await rig.service.start({ cwd: rig.cwd });

  await rig.service.prompt("go");

  await vi.waitFor(() => {
    expect(rig.service.view()?.phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_C.id,
    });
  });
  expect(rig.specs.map((spec) => spec.account.id)).toEqual(["acc-a", "acc-c"]);
});

function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function shutdownStoppedPhase(rig: Setup): Promise<void> {
  await vi.waitFor(() => {
    expect(rig.service.view()?.phase).toEqual({ phase: "stopped" });
  });
  await nextMacrotask();
}

function shutdownTracked(rig: Setup): Promise<void> {
  return rig.service.shutdown().then(() => {
    rig.log.push("shutdown:done");
  });
}

it("shutdown_waits_for_in_flight_switch_log_append", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: { "acc-a": [RATE_LIMITED] },
    appendGate: gate.promise,
  });
  await rig.service.start({ cwd: rig.cwd });
  await rig.service.prompt("go");
  await vi.waitFor(() => {
    expect(rig.log).toContain("append:start");
  });

  const shutdown = shutdownTracked(rig);
  try {
    await shutdownStoppedPhase(rig);
    expect(rig.log).not.toContain("shutdown:done");
  } finally {
    gate.resolve(undefined);
  }
  await shutdown;

  expect(rig.log.slice(-2)).toEqual(["append:done", "shutdown:done"]);
});

it("shutdown_waits_for_halt_log_append", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({
    events: { "acc-a": [RATE_LIMITED] },
    appendGate: gate.promise,
  });
  await rig.service.start({ cwd: rig.cwd });
  await rig.service.prompt("go");
  await vi.waitFor(() => {
    expect(rig.log).toContain("append:start");
  });

  const shutdown = shutdownTracked(rig);
  try {
    await shutdownStoppedPhase(rig);
    expect(rig.log).not.toContain("shutdown:done");
  } finally {
    gate.resolve(undefined);
  }
  await shutdown;

  expect(rig.log.slice(-2)).toEqual(["append:done", "shutdown:done"]);
});

it("shutdown_resolves_when_in_flight_switch_log_append_fails", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: { "acc-a": [RATE_LIMITED] },
    appendGate: gate.promise,
    appendError: new Error("disk full"),
  });
  await rig.service.start({ cwd: rig.cwd });
  await rig.service.prompt("go");
  await vi.waitFor(() => {
    expect(rig.log).toContain("append:start");
  });

  const shutdown = shutdownTracked(rig);
  try {
    await shutdownStoppedPhase(rig);
  } finally {
    gate.resolve(undefined);
  }
  await shutdown;

  expect(rig.service.view()?.phase).toEqual({ phase: "stopped" });
});

it("shutdown_waits_for_launch_started_during_close", async () => {
  const chainStop = Promise.withResolvers<undefined>();
  const closeStop = Promise.withResolvers<undefined>();
  const launchGate = Promise.withResolvers<undefined>();
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: { "acc-a": [RATE_LIMITED] },
    stopGates: [chainStop.promise, closeStop.promise],
    startGateFor: { "acc-b": launchGate.promise },
  });
  await rig.service.start({ cwd: rig.cwd });
  await rig.service.prompt("go");
  const stopsOfRunOne = (): string[] =>
    rig.log.filter((entry) => entry === "stop:run-1");
  await vi.waitFor(() => {
    expect(stopsOfRunOne()).toHaveLength(1);
  });

  const shutdown = shutdownTracked(rig);
  try {
    await vi.waitFor(() => {
      expect(stopsOfRunOne()).toHaveLength(2);
    });
    chainStop.resolve(undefined);
    await vi.waitFor(() => {
      expect(rig.log).toContain("start:run-2");
    });
    closeStop.resolve(undefined);
    await shutdownStoppedPhase(rig);
    expect(rig.log).not.toContain("shutdown:done");
  } finally {
    chainStop.resolve(undefined);
    closeStop.resolve(undefined);
    launchGate.resolve(undefined);
  }
  await shutdown;

  expect(rig.log.indexOf("stop:run-2")).toBeGreaterThan(-1);
  expect(rig.log.indexOf("stop:run-2")).toBeLessThan(
    rig.log.indexOf("shutdown:done"),
  );
});

function startOutcome(rig: Setup): Promise<unknown> {
  return rig.service.start({ cwd: rig.cwd }).catch((error: unknown) => error);
}

function expectNothingLeft(rig: Setup): void {
  expect(rig.service.view()).toBeNull();
  expect(rig.service.isLive()).toBe(false);
  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(false);
  expect(rig.broadcasts).toEqual([]);
}

it("stop_during_initial_launch_halts_agent_and_rejects_start", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({ events: {}, startGate: gate.promise });
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.specs).toHaveLength(1);
  });

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(rig.log).toEqual(["start:run-1", "stop:run-1"]);
  expect(await outcome).toMatchObject(START_STOPPED);
  expectNothingLeft(rig);
});

it("shutdown_during_initial_launch_halts_agent_and_rejects_start", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({ events: {}, startGate: gate.promise });
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.specs).toHaveLength(1);
  });

  const shutdown = rig.service.shutdown();
  gate.resolve(undefined);
  await shutdown;

  expect(rig.log).toEqual(["start:run-1", "stop:run-1"]);
  expect(await outcome).toMatchObject(START_STOPPED);
  expectNothingLeft(rig);
});

it("stop_during_launch_reservation_halts_the_agent", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const rig = await setup({
    events: {},
    beforeLaunch: () => {
      entered.resolve(undefined);
      return gate.promise;
    },
  });
  const outcome = startOutcome(rig);
  await entered.promise;

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(rig.log).toEqual(["start:run-1", "stop:run-1"]);
  expect(await outcome).toMatchObject(START_STOPPED);
  expectNothingLeft(rig);
});

it("stop_while_previous_session_is_released_starts_nothing", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await haltedSession({
    events: { "acc-a": [NEEDS_LOGIN] },
    stopGate: gate.promise,
    accountsGate: Promise.resolve(),
  });
  const readsBefore = rig.log.filter((entry) => entry === ACCOUNTS_READ);
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.log).toContain("stop:run-1");
  });

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(rig.specs).toHaveLength(1);
  expect(rig.log.filter((entry) => entry === ACCOUNTS_READ)).toEqual(
    readsBefore,
  );
  expect(await outcome).toMatchObject(START_STOPPED);
  expect(rig.service.isLive()).toBe(false);
});

it("stop_while_accounts_are_read_starts_nothing", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({ events: {}, accountsGate: gate.promise });
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.log).toContain(ACCOUNTS_READ);
  });

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(rig.specs).toEqual([]);
  expect(await outcome).toMatchObject(START_STOPPED);
  expectNothingLeft(rig);
});

it("stop_during_start_retry_never_launches_the_next_account", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const state = { blocked: false };
  const rig = await setup({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    events: {},
    isBlocked: (accountId) => accountId === ACCOUNT_A.id && state.blocked,
    beforeLaunch: async (accountId) => {
      if (accountId !== ACCOUNT_A.id) {
        return;
      }
      entered.resolve(undefined);
      await gate.promise;
      state.blocked = true;
      throw new ProbeStillRunningError();
    },
  });
  const outcome = startOutcome(rig);
  await entered.promise;

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(rig.specs).toEqual([]);
  expect(await outcome).toMatchObject(START_STOPPED);
  expectNothingLeft(rig);
});

it("start_after_interrupted_start_launches_normally", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({ events: {}, startGate: gate.promise });
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.specs).toHaveLength(1);
  });
  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;
  await outcome;

  const view = await rig.service.start({ cwd: rig.cwd });

  expect(view.phase).toEqual({ phase: "running", accountId: ACCOUNT_A.id });
  expect(rig.log).toEqual(["start:run-1", "stop:run-1", "start:run-2"]);
});

it("concurrent_stop_and_shutdown_during_start_halt_the_agent_once", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({ events: {}, startGate: gate.promise });
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.specs).toHaveLength(1);
  });

  const stopping = rig.service.stop();
  const shutdown = rig.service.shutdown();
  gate.resolve(undefined);
  await Promise.all([stopping, shutdown]);

  expect(rig.log.filter((entry) => entry === "stop:run-1")).toHaveLength(1);
  expect(await outcome).toMatchObject(START_STOPPED);
});

it("interrupted_start_with_surviving_agent_stays_in_use", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await setup({
    events: {},
    startGate: gate.promise,
    stopResult: STOP_FAILED,
  });
  const outcome = startOutcome(rig);
  await settled(() => {
    expect(rig.specs).toHaveLength(1);
  });

  const stopping = rig.service.stop();
  gate.resolve(undefined);
  await stopping;

  expect(await outcome).toMatchObject(START_STOPPED);
  expect(rig.service.isInUse(ACCOUNT_A.id)).toBe(true);
  await expect(rig.service.start({ cwd: rig.cwd })).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "The previous agent is still running",
  });
});

function opencodeAccount(id: string, auth: ApiAuth): Account {
  return {
    id,
    provider: ProviderId.opencode,
    label: id,
    configDir: `/cfg/${id}`,
    order: 0,
    api: {
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      baseUrl: null,
      rotation: true,
      auth,
    },
  };
}

it("console_login_opencode_account_without_a_key_is_startable", async () => {
  const rig = await setup({
    accounts: [opencodeAccount("go-console", "console_login")],
    events: {},
    hasKey: () => false,
  });

  const view = await rig.service.start({
    cwd: rig.cwd,
    provider: ProviderId.opencode,
  });

  expect(view.phase).toEqual({ phase: "running", accountId: "go-console" });
});

it("api_key_opencode_account_without_a_key_is_still_refused", async () => {
  const rig = await setup({
    accounts: [opencodeAccount("go-key", "api_key")],
    events: {},
    hasKey: () => false,
  });

  await expect(
    rig.service.start({ cwd: rig.cwd, provider: ProviderId.opencode }),
  ).rejects.toBeInstanceOf(IpcError);

  expect(rig.specs).toEqual([]);
});

it("flow-start-refused-while-folder-resolves", async () => {
  const gate = Promise.withResolvers<string>();
  const rig = await setup({
    events: { "acc-a": [] },
    resolveFolder: () => gate.promise,
  });

  const starting = rig.service.start({});

  expect(rig.service.isLive()).toBe(true);
  await expect(rig.service.start({})).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
  });
  gate.resolve(rig.cwd);
  await starting;
});

it("folder-resolution-failure-frees-the-session-slot", async () => {
  const gate = Promise.withResolvers<string>();
  const rig = await setup({
    events: { "acc-a": [] },
    resolveFolder: () => gate.promise,
  });

  const starting = rig.service.start({});
  const rejected = expect(starting).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
  });
  expect(rig.service.isLive()).toBe(true);
  gate.reject(new IpcError(IpcErrorCode.VALIDATION, "no folder"));
  await rejected;

  expect(rig.service.isLive()).toBe(false);
  expect(rig.log).toEqual([]);
});

it("session_view_tracks_explicit_folder_from_start_input", async () => {
  const rig = await setup({ events: { "acc-a": [] } });

  const implicit = await rig.service.start({});
  expect(implicit.explicitFolder).toBe(false);
  await rig.service.stop();

  const explicit = await rig.service.start({ cwd: rig.cwd });
  expect(explicit.explicitFolder).toBe(true);
});
