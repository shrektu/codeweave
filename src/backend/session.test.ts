import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import { ProviderId, type Account } from "../domain/types";
import { IpcErrorCode } from "../shared/protocol";

import type { AgentAdapter, AgentHandle, AgentStartSpec } from "./agentAdapter";
import { StopFailureReason, type StopResult } from "./process/container";
import { createSessionService, type SessionService } from "./session";
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
}

interface SetupOptions {
  readonly events: Readonly<Record<string, readonly AgentEvent[]>>;
  readonly stopResult?: StopResult;
  readonly stopGate?: Promise<void>;
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
      return options.stopResult ?? { ok: true };
    },
  };
}

async function setup(options: SetupOptions): Promise<Setup> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-session-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-session-cwd-"));
  tempDirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT_A]);
  const log: string[] = [];
  const adapter: AgentAdapter = {
    start: (spec) => {
      log.push(`start:${spec.runId}`);
      return Promise.resolve({
        ok: true,
        handle: fakeHandle(spec, options, log),
      });
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
    resolveClaudeExecutable: () => "/usr/bin/claude",
    stopGraceMs: GRACE_MS,
    containerStatus: { available: true, message: null },
  });
  services.push(service);
  return { service, store, log, cwd };
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
