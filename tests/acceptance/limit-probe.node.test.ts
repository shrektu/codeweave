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
  probeAgentsOf,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import { AUTH_REQUIRED_CODE } from "../fakes/fakeAcpAgent";
import {
  FIVE_HOUR_RESET,
  FIVE_HOUR_RESET_SECONDS,
  NO_LIMITS_USAGE_MARKDOWN,
  OPUS_RESET,
  OPUS_RESET_SECONDS,
  WEEK_RESET as USAGE_WEEK_RESET,
  WEEK_RESET_SECONDS,
  renderUsageMarkdown,
  usageResponse,
} from "../fakes/fakeClaudeUsage";
import {
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  type FakeCodexConfig,
  type TurnStep,
} from "../fakes/fakeCodexAppServer";
import { usageBucket, usageGroup, type UsageScript } from "../fakes/fakeAgy";
import type { FakeContained } from "../fakes/fakeContainer";
import {
  hostBinDirWith,
  hostResolverEnv,
  makeTempDir,
} from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

const RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const PROBE_INTERVAL_MS = 300_000;
const PROBE_TIMEOUT_MS = 15_000;
const FAST_DELAY_MS = 30;
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
  await settled(() => {
    expect(rig.probeTasks).toHaveLength(count);
  });
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

it("probe_reports_claude_usage_windows", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C, ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CLAUDE_C.id)).toMatchObject({
    runtime: { status: "ready" },
    limitAvailability: "reported",
    limit: {
      accountId: ACCOUNT_CLAUDE_C.id,
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.6,
      resetsAt: WEEK_RESET_SECONDS,
      windows: [
        {
          id: "five_hour",
          scope: null,
          period: "five_hour",
          utilization: 0.3,
          resetsAt: FIVE_HOUR_RESET_SECONDS,
          exhausted: false,
        },
        {
          id: "seven_day",
          scope: null,
          period: "seven_day",
          utilization: 0.6,
          resetsAt: WEEK_RESET_SECONDS,
          exhausted: false,
        },
        {
          id: "seven_day:opus",
          scope: "Opus",
          period: "seven_day",
          utilization: 0.2,
          resetsAt: OPUS_RESET_SECONDS,
          exhausted: false,
        },
      ],
    },
  });
  expect(probeAgentsOf(rig).map((agent) => agent.prompts)).toEqual([
    ["/usage"],
  ]);
  expect(rig.claudeProbeContainer.specs[0]?.env.TZ).toBe("UTC");
  expect(probedHomes(rig)).toEqual([ACCOUNT_CODEX_A.configDir]);
  expect(rig.container.agents).toHaveLength(0);
});

const OPUS_EXHAUSTED_MARKDOWN = renderUsageMarkdown(
  usageResponse({
    five_hour: { utilization: 30, resets_at: FIVE_HOUR_RESET },
    seven_day: { utilization: 60, resets_at: USAGE_WEEK_RESET },
    seven_day_opus: { utilization: 100, resets_at: OPUS_RESET },
  }),
);

const FIVE_HOUR_EXHAUSTED_MARKDOWN = renderUsageMarkdown(
  usageResponse({
    five_hour: { utilization: 100, resets_at: FIVE_HOUR_RESET },
    seven_day: { utilization: 60, resets_at: USAGE_WEEK_RESET },
  }),
);

it("claude_opus_weekly_exhausted_keeps_account_ready", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C],
    claudeProbeText: OPUS_EXHAUSTED_MARKDOWN,
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CLAUDE_C.id)).toMatchObject({
    runtime: { status: "ready" },
    limitAvailability: "reported",
    limit: {
      status: "allowed",
      windows: [
        { id: "five_hour", exhausted: false },
        { id: "seven_day", exhausted: false },
        {
          id: "seven_day:opus",
          scope: "Opus",
          utilization: 1,
          exhausted: true,
        },
      ],
    },
  });
});

it("claude_five_hour_exhausted_keeps_account_exhausted", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C],
    claudeProbeText: FIVE_HOUR_EXHAUSTED_MARKDOWN,
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CLAUDE_C.id)).toMatchObject({
    runtime: { status: "exhausted", resetsAt: FIVE_HOUR_RESET_SECONDS },
    limit: { status: "rejected", resetsAt: FIVE_HOUR_RESET_SECONDS },
  });
});

it("claude_probe_needs_login", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C],
    claudeProbeScripts: [
      [{ type: "fail", code: AUTH_REQUIRED_CODE, message: "Auth required" }],
    ],
  });

  await cyclesDone(rig, 1);

  expect((await viewOf(rig, ACCOUNT_CLAUDE_C.id)).runtime).toEqual({
    status: "needs_login",
  });
});

it("claude_probe_without_limits_reports_unsupported", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C],
    claudeProbeScripts: [
      [
        { type: "text", text: NO_LIMITS_USAGE_MARKDOWN },
        { type: "end", stopReason: "end_turn" },
      ],
    ],
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CLAUDE_C.id)).toMatchObject({
    runtime: { status: "ready" },
    limit: null,
    limitAvailability: "unsupported",
  });
});

it("claude_probe_timeout_reports_failed", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const rig = await openRig({
      accounts: [ACCOUNT_CLAUDE_C],
      claudeProbeScripts: [[{ type: "hang" }]],
    });
    await until(() => probeAgentsOf(rig)[0]?.prompts.length === 1);
    expect((await viewOf(rig, ACCOUNT_CLAUDE_C.id)).limitAvailability).toBe(
      "pending",
    );

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

    await until(() => rig.probeTasks.length === 1);
    expect(await viewOf(rig, ACCOUNT_CLAUDE_C.id)).toMatchObject({
      runtime: { status: "ready" },
      limit: null,
      limitAvailability: "failed",
    });
  } finally {
    vi.useRealTimers();
  }
});

it("claude_probe_stops_its_agent", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_CLAUDE_C] });

  await cyclesDone(rig, 1);

  expect(rig.claudeProbeContainer.contained).toHaveLength(1);
  expect(rig.claudeProbeContainer.contained[0]?.stopCalls).toEqual([
    AGENT_STOP_GRACE_MS,
  ]);
  expect(rig.probeStats.alive).toBe(0);
});

it("claude_probe_unstopped_blocks_account", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C],
    claudeProbeStopResults: [STOP_SURVIVORS],
  });
  await cyclesDone(rig, 1);

  await expect(
    rig.call("session/start", { cwd: rig.cwd, provider: "claude" }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "No usable account",
  });

  expect(rig.container.specs).toHaveLength(0);
});

it("claude_launch_waits_for_probe_release", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C],
    claudeProbeScripts: [[{ type: "hang" }]],
  });
  await settled(() => {
    expect(rig.claudeProbeContainer.contained).toHaveLength(1);
  });
  const probe = rig.claudeProbeContainer.contained[0];
  if (probe === undefined) {
    throw new Error("the Claude probe was not spawned");
  }
  await until(() => probeAgentsOf(rig)[0]?.prompts.length === 1);
  probe.holdStops();

  const starting = rig.call("session/start", {
    cwd: rig.cwd,
    provider: "claude",
  });
  await settled(() => {
    expect(probe.stopCalls).toEqual([AGENT_STOP_GRACE_MS]);
  });
  await sleep(POLL_MS);

  expect(rig.container.specs).toHaveLength(0);
  probe.resolveHeldStops();
  const started = await starting;
  expect(started.activeAccountId).toBe(ACCOUNT_CLAUDE_C.id);
  expect(rig.container.specs).toHaveLength(1);
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

const WEEK_RESET = 1_700_600_000;
const EXTRA_RESET = 1_700_007_200;
const SPARK_ID = "codex_bengalfox";
const SPARK_NAME = "GPT-5.3-Codex-Spark";
const WEEK_MINUTES = 10_080;
const RPC_BACKEND_FAILURE = -32603;
const RPC_OVERLOADED = -32001;

const MAIN_SNAPSHOT = rateSnapshot(
  rateWindow(25, FIVE_HOUR_MINUTES, RESET_AT),
  rateWindow(60, WEEK_MINUTES, WEEK_RESET),
);
const ALL_WINDOWS_RESPONSE = rateLimitsResponse(MAIN_SNAPSHOT, true, {
  codex: MAIN_SNAPSHOT,
  [SPARK_ID]: rateSnapshot(
    rateWindow(5, FIVE_HOUR_MINUTES, EXTRA_RESET),
    null,
    null,
    SPARK_ID,
    SPARK_NAME,
  ),
});
const ALL_WINDOWS = [
  {
    id: "five_hour",
    scope: null,
    period: "five_hour",
    utilization: 0.25,
    resetsAt: RESET_AT,
    exhausted: false,
  },
  {
    id: "seven_day",
    scope: null,
    period: "seven_day",
    utilization: 0.6,
    resetsAt: WEEK_RESET,
    exhausted: false,
  },
  {
    id: `${SPARK_ID}:five_hour`,
    scope: SPARK_NAME,
    period: "five_hour",
    utilization: 0.05,
    resetsAt: EXTRA_RESET,
    exhausted: false,
  },
];
const ACCOUNT_API_KEY: Account = {
  id: "api-key",
  provider: "opencode",
  label: "Key account",
  configDir: "/cfg/api-key",
  order: 3,
  api: {
    provider: "openrouter",
    model: "m",
    baseUrl: null,
    rotation: false,
    auth: "api_key",
  },
};

it("probe_reports_every_codex_window", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: {
      rateLimitReads: [{ kind: "ok", response: ALL_WINDOWS_RESPONSE }],
    },
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    limitAvailability: "reported",
    limit: {
      status: "allowed",
      resetsAt: WEEK_RESET,
      rateLimitType: "seven_day",
      utilization: 0.6,
      windows: ALL_WINDOWS,
    },
  });
});

it("api_key_account_reports_unsupported", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CLAUDE_C, ACCOUNT_API_KEY, ACCOUNT_CODEX_A],
    probeConfig: ALLOWED_CONFIG,
  });

  await cyclesDone(rig, 1);

  expect((await viewOf(rig, ACCOUNT_API_KEY.id)).limitAvailability).toBe(
    "unsupported",
  );
  expect((await viewOf(rig, ACCOUNT_CODEX_A.id)).limitAvailability).toBe(
    "reported",
  );
});

it("probed_account_is_pending_before_the_first_result", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: HANGING_CONFIG,
  });

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    limitAvailability: "pending",
    limit: null,
  });
});

it("no_limits_probe_reports_unsupported", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: {
      rateLimitReads: [
        { kind: "error", code: RPC_INVALID_REQUEST, message: "api key" },
      ],
    },
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    limitAvailability: "unsupported",
    limit: null,
  });
});

it("first_probe_failure_reports_failed", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: {
      rateLimitReads: [
        { kind: "error", code: RPC_BACKEND_FAILURE, message: "backend down" },
      ],
    },
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    runtime: { status: "ready" },
    limitAvailability: "failed",
    limit: null,
  });
});

it("probe_failure_keeps_last_windows", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_CODEX_A],
    probeConfig: {
      rateLimitReads: [
        { kind: "ok", response: ALL_WINDOWS_RESPONSE },
        { kind: "error", code: RPC_OVERLOADED, message: "overloaded" },
      ],
    },
  });
  await cyclesDone(rig, 1);

  runNextPass(rig);
  await cyclesDone(rig, 2);

  expect(await viewOf(rig, ACCOUNT_CODEX_A.id)).toMatchObject({
    limitAvailability: "reported",
    limit: { utilization: 0.6, windows: ALL_WINDOWS },
  });
});

const GEMINI_RESET_WEEK = "2026-11-02T10:21:22Z";
const GEMINI_RESET_FIVE_HOUR = "2026-10-30T12:54:36Z";
const GEMINI_WEEK_EPOCH = 1_793_614_882;
const GEMINI_FIVE_HOUR_EPOCH = 1_793_364_876;

const THREE_GROUPS: UsageScript = {
  kind: "ok",
  groups: [
    usageGroup("Gemini Models", [
      usageBucket("gemini-weekly", "weekly", 0.75, GEMINI_RESET_WEEK),
      usageBucket("gemini-5h", "5h", 0.5, GEMINI_RESET_FIVE_HOUR),
    ]),
    usageGroup("Claude and GPT models", [
      usageBucket("claude-weekly", "weekly", 0.875, GEMINI_RESET_WEEK),
      usageBucket("claude-5h", "5h", 0, GEMINI_RESET_FIVE_HOUR),
    ]),
    usageGroup("Gemini 4 Argon", [
      usageBucket("argon-weekly", "weekly", 0.25, GEMINI_RESET_WEEK),
    ]),
  ],
};

const GEMINI_WINDOWS = [
  {
    id: "Gemini Models/gemini-weekly/weekly",
    scope: "weekly limit",
    period: "seven_day",
    utilization: 0.25,
    resetsAt: GEMINI_WEEK_EPOCH,
    exhausted: false,
  },
  {
    id: "Gemini Models/gemini-5h/5h",
    scope: "5h limit",
    period: "five_hour",
    utilization: 0.5,
    resetsAt: GEMINI_FIVE_HOUR_EPOCH,
    exhausted: false,
  },
  {
    id: "Claude and GPT models/claude-weekly/weekly",
    scope: "weekly limit",
    period: "seven_day",
    utilization: 0.125,
    resetsAt: GEMINI_WEEK_EPOCH,
    exhausted: false,
  },
  {
    id: "Claude and GPT models/claude-5h/5h",
    scope: "5h limit",
    period: "five_hour",
    utilization: 1,
    resetsAt: GEMINI_FIVE_HOUR_EPOCH,
    exhausted: true,
  },
  {
    id: "Gemini 4 Argon/argon-weekly/weekly",
    scope: "weekly limit",
    period: "seven_day",
    utilization: 0.75,
    resetsAt: GEMINI_WEEK_EPOCH,
    exhausted: false,
  },
];

it("probe_reports_every_agy_bucket", async () => {
  const userData = await makeTempDir();
  const gemini: Account = {
    id: "gemini-a",
    provider: "gemini",
    label: "Gemini",
    configDir: join(userData, "accounts", "gemini-a"),
    order: 0,
  };
  const rig = await openRig({
    userData,
    accounts: [gemini],
    agyUsage: [THREE_GROUPS],
  });

  await cyclesDone(rig, 1);

  expect(await viewOf(rig, gemini.id)).toMatchObject({
    runtime: { status: "ready" },
    limitAvailability: "reported",
    limit: {
      status: "allowed",
      resetsAt: GEMINI_FIVE_HOUR_EPOCH,
      rateLimitType: "five_hour",
      utilization: 0.5,
      windows: GEMINI_WINDOWS,
    },
  });
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

  await settled(async () => {
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

  await settled(() => {
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
  await settled(() => {
    expect(rig.probeContainer.contained).toHaveLength(1);
  });
  const probe = probeProcess(rig, 0);
  probe.holdStops();

  const starting = rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });
  await settled(() => {
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
    await settled(() => {
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
  await settled(async () => {
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
  await settled(() => {
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
  await settled(() => {
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
  await settled(async () => {
    expect((await viewOf(rig, ACCOUNT_CODEX_A.id)).limit).toMatchObject({
      status: "rejected",
      resetsAt: LATER_RESET_AT,
    });
  });

  await rig.call("session/prompt", { text: "again" });

  await settled(async () => {
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
    await settled(() => {
      expect(rig.probeContainer.contained).toHaveLength(firstPass + 1);
    });
    const probe = probeProcess(rig, firstPass);
    probe.holdStops();
    gate.resolve(undefined);
    await settled(() => {
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
  await settled(() => {
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
  await settled(() => {
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

  await settled(async () => {
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
