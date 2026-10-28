import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import { ProviderId, type Account } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import type { AgentAdapter, AgentHandle, AgentStartSpec } from "./agentAdapter";
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
): AgentHandle {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    accountId: spec.account.id,
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
      await options.stopGate;
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
  const adapter: AgentAdapter = {
    start: async (spec) => {
      specs.push(spec);
      log.push(`start:${spec.runId}`);
      await options.startGate;
      await options.startGateFor?.[spec.account.id];
      return { ok: true, handle: fakeHandle(spec, options, log) };
    },
  };
  let runs = 0;
  const service = createSessionService({
    adapter,
    store,
    broadcast: () => undefined,
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
  });
  services.push(service);
  return { service, store, log, cwd, specs };
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
