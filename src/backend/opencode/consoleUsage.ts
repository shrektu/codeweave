import { z } from "zod";

import { MS_PER_SECOND } from "../../domain/constants";
import { LimitPeriod, type LimitWindow } from "../../domain/limitWindows";

import {
  parseJsonOutput,
  runOpencodeProbe,
  type ConsoleLoginDeps,
  type ConsoleLoginInput,
  type JsonBounds,
} from "./consoleLogin";

export const USAGE_LIMITS_ARGS: readonly string[] = [
  "api",
  "experimental.usage.limits",
  "--standalone",
];

const OBJECT_BOUNDS: JsonBounds = { open: "{", close: "}" };
const PERCENT_SCALE = 100;
const BUDGET_ID_PREFIX = "budget:";
const MONEY_DECIMALS = 2;

const MeterSchema = z.looseObject({
  percent: z.number(),
  limited: z.boolean(),
  resetsAt: z.number(),
});
type Meter = z.infer<typeof MeterSchema>;

const BudgetSchema = z.looseObject({
  id: z.string(),
  limit: z.number(),
  spent: z.number(),
  resetsAt: z.number(),
});
type Budget = z.infer<typeof BudgetSchema>;

const UsageOutputSchema = z.looseObject({
  data: z.nullable(
    z.looseObject({
      go: z
        .looseObject({
          rolling: MeterSchema,
          weekly: MeterSchema,
          monthly: MeterSchema,
        })
        .optional(),
      budgets: z.array(BudgetSchema).default([]),
    }),
  ),
});

export type ConsoleUsageResult =
  | { readonly kind: "limits"; readonly windows: readonly LimitWindow[] }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

export type ConsoleUsageProbe = (
  input: ConsoleLoginInput,
) => Promise<ConsoleUsageResult>;

const NONE: ConsoleUsageResult = { kind: "none" };
const FAILED: ConsoleUsageResult = { kind: "failed" };

function secondsOf(epochMillis: number): number {
  return Math.floor(epochMillis / MS_PER_SECOND);
}

function meterWindow(period: string, meter: Meter): LimitWindow {
  return {
    id: period,
    scope: null,
    period,
    utilization: meter.percent / PERCENT_SCALE,
    resetsAt: secondsOf(meter.resetsAt),
    exhausted: meter.limited,
  };
}

function money(amount: number): string {
  return Number.isInteger(amount)
    ? String(amount)
    : amount.toFixed(MONEY_DECIMALS);
}

function budgetWindow(budget: Budget): LimitWindow {
  const capped = budget.limit > 0;
  return {
    id: `${BUDGET_ID_PREFIX}${budget.id}`,
    scope: `Budget $${money(budget.spent)} of $${money(budget.limit)}`,
    period: LimitPeriod.monthly,
    utilization: capped ? budget.spent / budget.limit : null,
    resetsAt: secondsOf(budget.resetsAt),
    exhausted: capped && budget.spent >= budget.limit,
  };
}

export async function probeConsoleUsage(
  deps: ConsoleLoginDeps,
  input: ConsoleLoginInput,
): Promise<ConsoleUsageResult> {
  const stdout = await runOpencodeProbe(
    deps,
    input,
    USAGE_LIMITS_ARGS,
    "console usage",
  );
  if (stdout === null) {
    return FAILED;
  }
  const output = parseJsonOutput(stdout, UsageOutputSchema, OBJECT_BOUNDS);
  if (output === null) {
    console.warn("the opencode console usage output is unreadable");
    return FAILED;
  }
  const { go, budgets } = output.data ?? { go: undefined, budgets: [] };
  const windows = [
    ...(go === undefined
      ? []
      : [
          meterWindow(LimitPeriod.fiveHour, go.rolling),
          meterWindow(LimitPeriod.sevenDay, go.weekly),
          meterWindow(LimitPeriod.monthly, go.monthly),
        ]),
    ...budgets.map(budgetWindow),
  ];
  return windows.length === 0 ? NONE : { kind: "limits", windows };
}

export function createConsoleUsageProbe(
  deps: ConsoleLoginDeps,
): ConsoleUsageProbe {
  return (input) => probeConsoleUsage(deps, input);
}
