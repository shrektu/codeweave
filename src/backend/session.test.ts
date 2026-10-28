import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import { ProviderId, type Account } from "../domain/types";
import { IpcErrorCode } from "../shared/protocol";

import type { AgentAdapter, AgentHandle, AgentStartSpec } from "./agentAdapter";
import { StopFailureReason, type StopResult } from "./process/container";
import {
  createSessionService,
  type SessionService,
  type SessionServiceDeps,
} from "./session";
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
  await store.writeAccounts(options.accounts ?? [ACCOUNT_A]);
  const log: string[] = [];
  const specs: AgentStartSpec[] = [];
  const adapter: AgentAdapter = {
    start: (spec) => {
      specs.push(spec);
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
    resolveExecutable: options.resolveExecutable ?? (() => "/usr/bin/claude"),
    stopGraceMs: GRACE_MS,
    containerStatus: { available: true, message: null },
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
