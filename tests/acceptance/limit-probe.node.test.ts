import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import * as codexAdapterModule from "../../src/backend/codex/adapter";
import { AGENT_STOP_GRACE_MS } from "../../src/backend/constants";
import {
  ContainerUnavailableError,
  StopFailureReason,
  type StopResult,
} from "../../src/backend/process/container";
import { createExecutableResolver } from "../../src/backend/startup";
import type { Account } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { AccountView } from "../../src/shared/views";
import {
  ACCOUNT_CLAUDE_C,
  ACCOUNT_CODEX_A,
  ACCOUNT_CODEX_B,
  RIG_NOW_MS,
  closeRigs,
  openRig,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import {
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  type FakeCodexConfig,
  type TurnStep,
} from "../fakes/fakeCodexAppServer";
import type { FakeContained } from "../fakes/fakeContainer";
import { hostBinDirWith, hostResolverEnv } from "../fakes/processHelpers";

const RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const PROBE_INTERVAL_MS = 300_000;
const PROBE_TIMEOUT_MS = 15_000;
const FAST_DELAY_MS = 30;
const SETTLE_TIMEOUT_MS = 4000;
const POLL_MS = 5;
const POLL_ROUNDS = 400;
const RPC_INVALID_REQUEST = -32600;

const ALLOWED_RESPONSE = rateLimitsResponse(
  rateSnapshot(rateWindow(25, FIVE_HOUR_MINUTES, RESET_AT), null),
);

const EXHAUSTED_RESPONSE = rateLimitsResponse(
  rateSnapshot(
    rateWindow(100, FIVE_HOUR_MINUTES, RESET_AT),
    null,
    "rate_limit_reached",
  ),
  false,
);

const ALLOWED_CONFIG: FakeCodexConfig = {
  rateLimitReads: [{ kind: "ok", response: ALLOWED_RESPONSE }],
};
const EXHAUSTED_CONFIG: FakeCodexConfig = {
  rateLimitReads: [{ kind: "ok", response: EXHAUSTED_RESPONSE }],
};
const HANGING_CONFIG: FakeCodexConfig = { rateLimitReads: [{ kind: "hang" }] };

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRigs();
});

function delayedConfig(delayMs: number): FakeCodexConfig {
  return {
    rateLimitReads: [{ kind: "delayed", delayMs, response: ALLOWED_RESPONSE }],
  };
}

function gatedConfig(gate: Promise<void>): FakeCodexConfig {
  return {
    rateLimitReads: [{ kind: "gated", gate, response: ALLOWED_RESPONSE }],
  };
}

async function accountsOf(rig: BackendRig): Promise<AccountView[]> {
  return (await rig.call("accounts/list", {})).accounts;
}

async function viewOf(rig: BackendRig, id: string): Promise<AccountView> {
  const found = (await accountsOf(rig)).find((account) => account.id === id);
  if (found === undefined) {
    throw new Error(`account ${id} is not listed`);
  }
  return found;
}

async function cyclesDone(rig: BackendRig, count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(rig.probeTasks).toHaveLength(count);
    },
    { timeout: SETTLE_TIMEOUT_MS },
  );
}

function probedHomes(rig: BackendRig, skip = 0): (string | undefined)[] {
  return rig.probeContainer.specs
    .slice(skip)
    .map((spec) => spec.env.CODEX_HOME);
}

function probeProcess(rig: BackendRig, index: number): FakeContained {
  const found = rig.probeContainer.contained[index];
  if (found === undefined) {
    throw new Error(`probe process ${index.toString()} was not spawned`);
  }
  return found;
}

function runNextPass(rig: BackendRig): void {
  const task = rig.probeTasks.findLast((candidate) => !candidate.cancelled);
  if (task === undefined) {
    throw new Error("no probe pass is scheduled");
  }
  task.run();
}

async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < POLL_ROUNDS && !condition(); round += 1) {
    await sleep(POLL_MS);
  }
  expect(condition()).toBe(true);
}

function readRequested(rig: BackendRig): boolean {
  return (
    rig.probeContainer.servers[0]
      ?.methods()
      .includes("account/rateLimits/read") === true
  );
}

it("probe_fills_account_limit_for_idle_account", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    runtime: { status: "ready" },
    limit: {
      accountId: ACCOUNT_CODEX_A.id,
      status: "allowed",
      resetsAt: RESET_AT,
      rateLimitType: "five_hour",
      utilization: 0.25,
      observedAt: RIG_NOW_MS,
    },
  });
  expect((await viewOf(rig, ACCOUNT_CODEX_B.id)).limit).toMatchObject({
    accountId: ACCOUNT_CODEX_B.id,
    utilization: 0.25,
  });
  expect(rig.probeContainer.specs[0]).toMatchObject({
    args: ["app-server"],
    cwd: ACCOUNT_CODEX_A.configDir,
    env: { CODEX_HOME: ACCOUNT_CODEX_A.configDir },
  });
  expect(rig.probeContainer.servers[0]?.methods()).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
  ]);
  expect(rig.broadcastsOf("accounts/changed").at(-1)).toMatchObject({
    accounts: [
      { id: ACCOUNT_CODEX_A.id, limit: { utilization: 0.25 } },
      { id: ACCOUNT_CODEX_B.id, limit: { utilization: 0.25 } },
    ],
  });
});

it("probe_skips_claude_accounts", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C, ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
  });

  await cyclesDone(rig, 1);

  expect(probedHomes(rig)).toEqual([ACCOUNT_CODEX_A.configDir]);
  expect((await viewOf(rig, ACCOUNT_CLAUDE_C.id)).limit).toBeNull();
  expect((await viewOf(rig, ACCOUNT_CODEX_A.id)).limit).not.toBeNull();
  expect(rig.container.agents).toHaveLength(0);
});

it("probe_skips_account_in_use", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
  });
  await cyclesDone(rig, 1);
  const firstPass = rig.probeContainer.specs.length;

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });
  runNextPass(rig);
  await cyclesDone(rig, 2);

  expect(started.activeAccountId).toBe(ACCOUNT_CODEX_A.id);
  expect(probedHomes(rig, firstPass)).toEqual([ACCOUNT_CODEX_B.configDir]);
});

it("probe_stops_process_after_read", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
  });

  await cyclesDone(rig, 1);

  expect(rig.probeContainer.contained).toHaveLength(2);
  for (const process of rig.probeContainer.contained) {
    expect(process.stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
    expect(await process.isEmpty()).toBe(true);
  }
  expect(rig.probeStats.alive).toBe(0);
});

it("probe_timeout_stops_process", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const rig = await openRig({
      accounts: [ACCOUNT_CODEX_A],
      probeConfig: HANGING_CONFIG,
    });
    await until(() => readRequested(rig));
    expect(probeProcess(rig, 0).stopCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

    await until(() => rig.probeTasks.length === 1);
    expect(probeProcess(rig, 0).stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
    expect(rig.probeStats.alive).toBe(0);
    expect((await viewOf(rig, ACCOUNT_CODEX_A.id)).limit).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("probe_read_failure_reports_no_limit", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: {
      rateLimitReads: [
        {
          kind: "error",
          code: RPC_INVALID_REQUEST,
          message: "chatgpt authentication required to read rate limits",
        },
      ],
    },
  });

  await cyclesDone(rig, 1);

  expect(rig.probeContainer.specs).toHaveLength(1);
  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    runtime: { status: "ready" },
    limit: null,
  });
  expect(probeProcess(rig, 0).stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
});

it("probes_run_one_at_a_time", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: delayedConfig(FAST_DELAY_MS),
  });

  await cyclesDone(rig, 1);

  expect(rig.probeContainer.specs).toHaveLength(2);
  expect(rig.probeStats.peak).toBe(1);
});

it("trigger_during_pass_runs_one_more_pass", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: gatedConfig(gate.promise),
  });
  await until(() => readRequested(rig));

  for (const name of ["first", "second"]) {
    await rig.call("accounts/add", {
      label: name,
      configDir: join(rig.userData, "accounts", name),
    });
  }
  gate.resolve(undefined);
  await cyclesDone(rig, 1);

  expect(rig.probeContainer.specs).toHaveLength(2);
  expect(rig.probeStats.peak).toBe(1);
});

it("probe_repeats_every_interval", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
  });
  await cyclesDone(rig, 1);

  expect(rig.probeTasks[0]?.at).toBe(RIG_NOW_MS + PROBE_INTERVAL_MS);
  runNextPass(rig);
  await cyclesDone(rig, 2);

  expect(probedHomes(rig)).toEqual([
    ACCOUNT_CODEX_A.configDir,
    ACCOUNT_CODEX_A.configDir,
  ]);
});

it("probe_runs_after_account_added", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
  });
  await cyclesDone(rig, 1);
  const configDir = join(rig.userData, "accounts", "codex-new");

  const { account } = await rig.call("accounts/add", {
    label: "Codex new",
    configDir,
    provider: "codex",
  });

  await vi.waitFor(async () => {
    expect(probedHomes(rig)).toContain(configDir);
    expect((await viewOf(rig, account.id)).limit).toMatchObject({
      accountId: account.id,
      utilization: 0.25,
    });
  });
});

it("probe_runs_after_account_removed", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
  });
  await cyclesDone(rig, 1);
  const firstPass = rig.probeContainer.specs.length;

  await rig.call("accounts/remove", { id: ACCOUNT_CODEX_B.id });

  await vi.waitFor(() => {
    expect(probedHomes(rig, firstPass)).toEqual([ACCOUNT_CODEX_A.configDir]);
  });
  expect((await accountsOf(rig)).map((account) => account.id)).toEqual([
    ACCOUNT_CODEX_A.id,
  ]);
});

it("session_launch_waits_for_probe_release", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: HANGING_CONFIG,
  });
  await vi.waitFor(() => {
    expect(rig.probeContainer.contained).toHaveLength(1);
  });
  const probe = probeProcess(rig, 0);
  probe.holdStops();

  const starting = rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });
  await vi.waitFor(() => {
    expect(probe.stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
  });
  await sleep(POLL_MS);

  expect(rig.codexContainer.specs).toHaveLength(0);
  probe.resolveHeldStops();
  const started = await starting;
  expect(started.activeAccountId).toBe(ACCOUNT_CODEX_A.id);
  expect(rig.codexContainer.specs).toHaveLength(1);
});

it("probe_exhausted_account_skipped_in_rotation", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfigByHome: {
      [ACCOUNT_CODEX_A.configDir]: EXHAUSTED_CONFIG,
      [ACCOUNT_CODEX_B.configDir]: ALLOWED_CONFIG,
    },
  });
  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    runtime: { status: "exhausted", resetsAt: RESET_AT },
    limit: { status: "rejected", resetsAt: RESET_AT },
  });
  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });

  expect(started.activeAccountId).toBe(ACCOUNT_CODEX_B.id);
  expect(rig.codexContainer.specs.map((spec) => spec.env.CODEX_HOME)).toEqual([
    ACCOUNT_CODEX_B.configDir,
  ]);
});

it("probe_needs_login_does_not_exclude_account", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfigByHome: {
      [ACCOUNT_CODEX_A.configDir]: { loggedIn: false },
      [ACCOUNT_CODEX_B.configDir]: ALLOWED_CONFIG,
    },
  });
  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    runtime: { status: "needs_login" },
    limit: null,
  });
  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });

  expect(started.activeAccountId).toBe(ACCOUNT_CODEX_A.id);
});

it("missing_codex_executable_skips_probes_quietly", async () => {
  const binDir = await hostBinDirWith("claude");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CLAUDE_C],
    resolveExecutable: createExecutableResolver(
      hostResolverEnv(binDir),
      process.platform,
    ),
  });

  await cyclesDone(rig, 1);

  expect(rig.probeContainer.specs).toEqual([]);
  const warned = warn.mock.calls.map(([message]) => String(message));
  expect(warned.some((message) => message.includes(ACCOUNT_CODEX_A.id))).toBe(
    true,
  );
  expect((await viewOf(rig, ACCOUNT_CODEX_A.id)).limit).toBeNull();
  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "claude",
  });
  expect(started.activeAccountId).toBe(ACCOUNT_CLAUDE_C.id);
});

it("no_container_disables_probes", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    containerError: new ContainerUnavailableError("No container here"),
  });

  await rig.call("accounts/add", {
    label: "Codex new",
    configDir: join(rig.userData, "accounts", "codex-new"),
    provider: "codex",
  });

  expect((await accountsOf(rig)).map((account) => account.limit)).toEqual([
    null,
    null,
  ]);
  expect(rig.probeContainer.specs).toEqual([]);
  expect(rig.probeTasks).toEqual([]);
});

const LATER_RESET_AT = 1_700_021_600;
const AFTER_RESET_MS = (RESET_AT + 1) * 1000;
const EXHAUSTED_LATER_RESPONSE = rateLimitsResponse(
  rateSnapshot(
    rateWindow(100, FIVE_HOUR_MINUTES, LATER_RESET_AT),
    null,
    "rate_limit_reached",
  ),
  false,
);
const EXHAUSTED_LATER_CONFIG: FakeCodexConfig = {
  rateLimitReads: [{ kind: "ok", response: EXHAUSTED_LATER_RESPONSE }],
};
const STOP_SURVIVORS: StopResult = {
  ok: false,
  reason: StopFailureReason.notEmptyAfterTimeout,
  survivors: [4242],
};
const USAGE_LIMIT_FAIL: TurnStep = {
  type: "fail",
  codexErrorInfo: "usageLimitExceeded",
  message: "You've hit your usage limit.",
};
const UNAUTHORIZED_FAIL: TurnStep = {
  type: "fail",
  codexErrorInfo: "unauthorized",
  message: "Please log in again.",
};
const ACCOUNT_CODEX_C: Account = {
  ...ACCOUNT_CODEX_B,
  id: "codex-c",
  label: "Codex C",
  configDir: "/cfg/codex-c",
  order: 2,
};

it("probe_waits_for_initial_launch_reservation", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
  });
  await cyclesDone(rig, 1);
  const firstPass = rig.probeContainer.specs.length;
  const gate = Promise.withResolvers<undefined>();
  rig.codexContainer.spawnGate = gate.promise;

  const starting = rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });
  try {
    await vi.waitFor(() => {
      expect(rig.codexContainer.spawnRequests).toBe(1);
    });
    runNextPass(rig);
    await cyclesDone(rig, 2);

    expect(probedHomes(rig, firstPass)).toEqual([ACCOUNT_CODEX_B.configDir]);
  } finally {
    gate.resolve(undefined);
  }
  expect((await starting).activeAccountId).toBe(ACCOUNT_CODEX_A.id);
});

it("probe_skips_account_with_live_agent_after_halt", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
  });
  await cyclesDone(rig, 1);
  const firstPass = rig.probeContainer.specs.length;
  rig.codexContainer.scriptNext([UNAUTHORIZED_FAIL]);
  await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });
  await rig.call("session/prompt", { text: "go" });
  await vi.waitFor(async () => {
    expect((await rig.session()).phase).toEqual({ phase: "halted" });
  });

  runNextPass(rig);
  await cyclesDone(rig, 2);

  expect(probedHomes(rig, firstPass)).toEqual([]);
  expect(rig.codexContainer.contained[0]?.stopCalls).toEqual([]);
});

it("shutdown_waits_for_probe_process_stop", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: HANGING_CONFIG,
  });
  await until(() => readRequested(rig));
  const probe = probeProcess(rig, 0);
  probe.holdStops();
  let closed = false;

  const closing = rig.dispose().then(() => {
    closed = true;
  });
  await vi.waitFor(() => {
    expect(probe.stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
  });
  await sleep(POLL_MS);

  expect(closed).toBe(false);
  probe.resolveHeldStops();
  await closing;
  expect(closed).toBe(true);
});

it("only_account_with_unstopped_probe_is_not_usable", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
    probeStopResults: [STOP_SURVIVORS],
  });
  await cyclesDone(rig, 1);

  await expect(
    rig.call("session/start", { cwd: rig.cwd, provider: "codex" }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No usable account",
  });

  expect(rig.codexContainer.specs).toHaveLength(0);
  runNextPass(rig);
  await cyclesDone(rig, 2);
  expect(rig.probeContainer.specs).toHaveLength(1);
});

it("probe_exhausted_overrides_expired_own_exhaustion", async () => {
  let nowMs = RIG_NOW_MS;
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B, ACCOUNT_CODEX_C],
    probeConfig: ALLOWED_CONFIG,
    now: () => nowMs,
  });
  await cyclesDone(rig, 1);
  rig.codexContainer.configByHome.set(ACCOUNT_CODEX_B.configDir, {
    rateLimitReads: [
      { kind: "ok", response: ALLOWED_RESPONSE },
      { kind: "ok", response: EXHAUSTED_LATER_RESPONSE },
    ],
  });
  rig.codexContainer.config.rateLimitReads = [
    { kind: "ok", response: ALLOWED_RESPONSE },
    { kind: "ok", response: EXHAUSTED_RESPONSE },
  ];
  rig.codexContainer.scriptNext([USAGE_LIMIT_FAIL]);
  await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });
  await rig.call("session/prompt", { text: "go" });
  await vi.waitFor(() => {
    expect(rig.codexContainer.servers[1]?.methods() ?? []).toContain(
      "turn/start",
    );
  });
  rig.codexContainer.servers[1]?.enqueue([USAGE_LIMIT_FAIL]);
  await turnEnded(rig);
  nowMs = AFTER_RESET_MS;
  rig.probeContainer.configByHome.set(
    ACCOUNT_CODEX_A.configDir,
    EXHAUSTED_LATER_CONFIG,
  );
  runNextPass(rig);
  await vi.waitFor(async () => {
    expect((await viewOf(rig, ACCOUNT_CODEX_A.id)).limit).toMatchObject({
      status: "rejected",
      resetsAt: LATER_RESET_AT,
    });
  });

  await rig.call("session/prompt", { text: "again" });

  await vi.waitFor(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_CODEX_C.id,
    });
  });
});

const ALLOWED_THEN_EXHAUSTED: FakeCodexConfig = {
  rateLimitReads: [
    { kind: "ok", response: ALLOWED_RESPONSE },
    { kind: "ok", response: EXHAUSTED_RESPONSE },
  ],
};
const PUBLISH_WINDOW_HOPS = Array.from({ length: 40 }, (_, hops) => hops);

function onCodexStarted(onStarted: () => void): void {
  const create = codexAdapterModule.createCodexAdapter;
  vi.spyOn(codexAdapterModule, "createCodexAdapter").mockImplementation(
    (deps) => {
      const adapter = create(deps);
      return {
        start: async (spec) => {
          const result = await adapter.start(spec);
          onStarted();
          return result;
        },
      };
    },
  );
}

it.each(PUBLISH_WINDOW_HOPS)(
  "probe_does_not_run_while_initial_run_is_publishing (%i hops)",
  async (hops) => {
    let release: () => void = () => undefined;
    onCodexStarted(() => {
      release();
    });
    const rig = await openRig({
      accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
      probeConfigByHome: {
        [ACCOUNT_CODEX_A.configDir]: EXHAUSTED_CONFIG,
        [ACCOUNT_CODEX_B.configDir]: ALLOWED_CONFIG,
      },
    });
    await cyclesDone(rig, 1);
    const firstPass = rig.probeContainer.specs.length;
    const gate = Promise.withResolvers<undefined>();
    rig.probeContainer.configByHome.set(
      ACCOUNT_CODEX_A.configDir,
      gatedConfig(gate.promise),
    );
    runNextPass(rig);
    await vi.waitFor(() => {
      expect(rig.probeContainer.contained).toHaveLength(firstPass + 1);
    });
    const probe = probeProcess(rig, firstPass);
    probe.holdStops();
    gate.resolve(undefined);
    await vi.waitFor(() => {
      expect(probe.stopCalls).toHaveLength(1);
    });
    release = () => {
      let hop = Promise.resolve();
      for (let step = 0; step < hops; step += 1) {
        hop = hop.then(() => undefined);
      }
      void hop.then(() => {
        probe.resolveHeldStops();
      });
    };

    const started = await rig.call("session/start", {
      cwd: rig.cwd,
      provider: "codex",
    });
    await cyclesDone(rig, 2);

    expect(started.activeAccountId).toBe(ACCOUNT_CODEX_B.id);
    expect(probedHomes(rig, firstPass)).toEqual([ACCOUNT_CODEX_A.configDir]);
  },
);

it("probe_skips_account_whose_closed_launch_left_survivors", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
    codexStopResultsByHome: {
      [ACCOUNT_CODEX_B.configDir]: [STOP_SURVIVORS, STOP_SURVIVORS],
    },
  });
  await cyclesDone(rig, 1);
  const firstPass = rig.probeContainer.specs.length;
  rig.codexContainer.config.rateLimitReads =
    ALLOWED_THEN_EXHAUSTED.rateLimitReads ?? [];
  rig.codexContainer.scriptNext([USAGE_LIMIT_FAIL]);
  await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });
  const gate = Promise.withResolvers<undefined>();
  rig.codexContainer.spawnGate = gate.promise;
  await rig.call("session/prompt", { text: "go" });
  await vi.waitFor(() => {
    expect(rig.codexContainer.spawnRequests).toBe(2);
  });

  const stopping = rig.call("session/stop", {});
  gate.resolve(undefined);
  await stopping;
  runNextPass(rig);
  await cyclesDone(rig, 2);

  expect(probedHomes(rig, firstPass)).toEqual([ACCOUNT_CODEX_A.configDir]);
});

it("session_starts_on_next_account_when_first_probe_unstopped", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: ALLOWED_CONFIG,
    probeStopResultsByHome: {
      [ACCOUNT_CODEX_A.configDir]: [STOP_SURVIVORS],
    },
  });
  await cyclesDone(rig, 1);

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });

  expect(started.activeAccountId).toBe(ACCOUNT_CODEX_B.id);
  expect(rig.codexContainer.specs.map((spec) => spec.env.CODEX_HOME)).toEqual([
    ACCOUNT_CODEX_B.configDir,
  ]);
});

it("session_start_moves_on_when_initial_probe_stop_leaves_survivors", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    probeConfig: HANGING_CONFIG,
    probeStopResultsByHome: {
      [ACCOUNT_CODEX_A.configDir]: [STOP_SURVIVORS],
    },
  });
  await vi.waitFor(() => {
    expect(rig.probeContainer.contained).toHaveLength(1);
  });

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });

  expect(started.activeAccountId).toBe(ACCOUNT_CODEX_B.id);
  expect(rig.codexContainer.specs.map((spec) => spec.env.CODEX_HOME)).toEqual([
    ACCOUNT_CODEX_B.configDir,
  ]);
});

it("rotation_skips_target_blocked_by_unstopped_probe", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B, ACCOUNT_CODEX_C],
    probeConfig: ALLOWED_CONFIG,
    probeStopResultsByHome: {
      [ACCOUNT_CODEX_B.configDir]: [STOP_SURVIVORS],
    },
  });
  await cyclesDone(rig, 1);
  rig.codexContainer.config.rateLimitReads =
    ALLOWED_THEN_EXHAUSTED.rateLimitReads ?? [];
  rig.codexContainer.scriptNext([USAGE_LIMIT_FAIL]);
  await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });

  await rig.call("session/prompt", { text: "go" });

  await vi.waitFor(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: ACCOUNT_CODEX_C.id,
    });
  });
  expect(rig.codexContainer.specs.map((spec) => spec.env.CODEX_HOME)).toEqual([
    ACCOUNT_CODEX_A.configDir,
    ACCOUNT_CODEX_C.configDir,
  ]);
});
