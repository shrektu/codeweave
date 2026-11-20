import { afterEach, expect, it, vi } from "vitest";

import type { ExecOptions, ExecText } from "../exec";

import type { ConsoleLoginDeps } from "./consoleLogin";
import { probeConsoleUsage, type ConsoleUsageResult } from "./consoleUsage";

const CONFIG_DIR = "/home/jane/.oc-console";
const EXECUTABLE = "/usr/bin/opencode";
const ANSI_GREEN = "\u001B[32m";
const ANSI_RESET = "\u001B[0m";

const ROLLING_RESET_MS = 1_700_003_600_999;
const WEEKLY_RESET_MS = 1_700_100_000_000;
const MONTHLY_RESET_MS = 1_702_000_000_000;
const BUDGET_RESET_MS = 1_701_000_000_000;

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions | undefined;
}

function outputOf(data: unknown): string {
  return JSON.stringify({ location: { directory: "/x" }, data });
}

function goData(monthlyLimited: boolean): unknown {
  return {
    workspace: { id: "wrk_1", name: "Personal", usageURL: "https://x" },
    go: {
      rolling: { percent: 12.5, limited: false, resetsAt: ROLLING_RESET_MS },
      weekly: { percent: 40, limited: false, resetsAt: WEEKLY_RESET_MS },
      monthly: {
        percent: monthlyLimited ? 100 : 55,
        limited: monthlyLimited,
        resetsAt: MONTHLY_RESET_MS,
      },
    },
    budgets: [],
  };
}

function depsReturning(output: string, calls: Call[] = []): ConsoleLoginDeps {
  const exec: ExecText = (file, args, options) => {
    calls.push({ file, args, options });
    return Promise.resolve(output);
  };
  return { exec, platform: "linux" };
}

function probe(
  deps: ConsoleLoginDeps,
  signal?: AbortSignal,
): Promise<ConsoleUsageResult> {
  return probeConsoleUsage(deps, {
    executable: EXECUTABLE,
    configDir: CONFIG_DIR,
    env: { PATH: "/usr/bin" },
    ...(signal === undefined ? {} : { signal }),
  });
}

function windowsOf(result: ConsoleUsageResult): readonly unknown[] {
  if (result.kind !== "limits") {
    throw new Error(`expected limits, got ${result.kind}`);
  }
  return result.windows;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("runs the usage command in the account directory", async () => {
  const calls: Call[] = [];

  await probe(depsReturning(outputOf(null), calls));

  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe(EXECUTABLE);
  expect(calls[0]?.args).toEqual([
    "api",
    "experimental.usage.limits",
    "--standalone",
  ]);
  expect(calls[0]?.options?.cwd).toBe(CONFIG_DIR);
});

it("usage_output_after_log_noise_parses", async () => {
  const noisy = `INFO  starting private server\n${ANSI_GREEN}${outputOf(goData(false))}${ANSI_RESET}\n`;

  const result = await probe(depsReturning(noisy));

  expect(windowsOf(result)).toEqual([
    {
      id: "five_hour",
      scope: null,
      period: "five_hour",
      utilization: 0.125,
      resetsAt: 1_700_003_600,
      exhausted: false,
    },
    {
      id: "seven_day",
      scope: null,
      period: "seven_day",
      utilization: 0.4,
      resetsAt: 1_700_100_000,
      exhausted: false,
    },
    {
      id: "monthly",
      scope: null,
      period: "monthly",
      utilization: 0.55,
      resetsAt: 1_702_000_000,
      exhausted: false,
    },
  ]);
});

it("data_null_is_none", async () => {
  expect(await probe(depsReturning(outputOf(null)))).toEqual({
    kind: "none",
  });
});

it("no_go_and_no_budgets_is_none", async () => {
  expect(await probe(depsReturning(outputOf({ budgets: [] })))).toEqual({
    kind: "none",
  });
});

it("service_unavailable_body_fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{"_tag":"ServiceUnavailableError","message":"OpenCode Console budgets are unavailable: timeout","service":"opencode"}\nHTTP 503 Service Unavailable\n';

  expect(await probe(depsReturning(body))).toEqual({ kind: "failed" });
});

it("unparsable_output_fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await probe(depsReturning("not json at all"))).toEqual({
    kind: "failed",
  });
});

it("non_zero_exit_fails_without_printing_stdout", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const failure = Object.assign(new Error("boom"), { code: 1 });

  const result = await probe({
    exec: () => Promise.reject(failure),
    platform: "linux",
  });

  expect(result).toEqual({ kind: "failed" });
  expect(warn).toHaveBeenCalledWith(
    "the opencode console usage probe failed: exit 1",
  );
});

it("aborted_probe_fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const controller = new AbortController();
  controller.abort();

  const result = await probe(
    { exec: () => new Promise<string>(() => undefined), platform: "linux" },
    controller.signal,
  );

  expect(result).toEqual({ kind: "failed" });
});

it("budget_with_zero_limit_has_no_utilization", async () => {
  const result = await probe(
    depsReturning(
      outputOf({
        budgets: [
          { id: "bud_Z", limit: 0, spent: 3, resetsAt: BUDGET_RESET_MS },
        ],
      }),
    ),
  );

  expect(windowsOf(result)).toEqual([
    {
      id: "budget:bud_Z",
      scope: "Budget $3 of $0",
      period: "monthly",
      utilization: null,
      resetsAt: 1_701_000_000,
      exhausted: false,
    },
  ]);
});

it("budget_at_its_limit_is_exhausted", async () => {
  const result = await probe(
    depsReturning(
      outputOf({
        budgets: [
          { id: "b1", limit: 20.5, spent: 20.5, resetsAt: BUDGET_RESET_MS },
        ],
      }),
    ),
  );

  expect(windowsOf(result)).toEqual([
    {
      id: "budget:b1",
      scope: "Budget $20.50 of $20.50",
      period: "monthly",
      utilization: 1,
      resetsAt: 1_701_000_000,
      exhausted: true,
    },
  ]);
});

it("limited_meter_is_exhausted_window", async () => {
  const result = await probe(depsReturning(outputOf(goData(true))));

  expect(windowsOf(result)).toContainEqual({
    id: "monthly",
    scope: null,
    period: "monthly",
    utilization: 1,
    resetsAt: 1_702_000_000,
    exhausted: true,
  });
});

it("epoch_millis_become_seconds", async () => {
  const result = await probe(depsReturning(outputOf(goData(false))));

  expect(windowsOf(result)[0]).toMatchObject({ resetsAt: 1_700_003_600 });
});
