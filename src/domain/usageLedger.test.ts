import { describe, expect, it } from "vitest";

import { UsageReportMode, type AgentEvent } from "./events";
import {
  applyUsageReport,
  emptyUsageLedger,
  usageTotalsOf,
  type UsageLedger,
} from "./usageLedger";
import { ProviderId } from "./types";

type UsageReport = Extract<AgentEvent, { type: "usage_report" }>;

const TOKENS = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  reasoning: 50,
};

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    type: "usage_report",
    provider: ProviderId.claude,
    key: "source",
    mode: UsageReportMode.delta,
    tokens: null,
    cost: null,
    ...overrides,
  };
}

function applyAll(
  reports: readonly UsageReport[],
  start: UsageLedger = emptyUsageLedger(),
): UsageLedger {
  return reports.reduce(applyUsageReport, start);
}

describe("usage ledger: deltas", () => {
  it("delta_reports_add_up", () => {
    const totals = usageTotalsOf(
      applyAll([
        report({ tokens: TOKENS, cost: { amount: 0.5, currency: "USD" } }),
        report({ tokens: TOKENS, cost: { amount: 0.25, currency: "USD" } }),
      ]),
    );

    expect(totals.tokens).toEqual({
      input: 20,
      output: 40,
      cacheRead: 60,
      cacheWrite: 80,
      reasoning: 100,
    });
    expect(totals.costs).toEqual({ USD: 0.75 });
    expect(totals.tokensReported).toBe(true);
    expect(totals.costReported).toBe(true);
  });

  it("mixed_currencies_are_kept_separate", () => {
    const totals = usageTotalsOf(
      applyAll([
        report({ cost: { amount: 0.5, currency: "USD" } }),
        report({ cost: { amount: 0.25, currency: "EUR" } }),
        report({ cost: { amount: 0.5, currency: "USD" } }),
      ]),
    );

    expect(totals.costs).toEqual({ USD: 1, EUR: 0.25 });
  });
});

describe("usage ledger: cumulative sources", () => {
  it("cumulative_counter_drop_folds_previous_value_into_base", () => {
    const totals = usageTotalsOf(
      applyAll([
        report({
          key: "acp",
          mode: UsageReportMode.cumulative,
          tokens: TOKENS,
        }),
        report({
          key: "acp",
          mode: UsageReportMode.cumulative,
          tokens: { ...TOKENS, input: 4 },
        }),
      ]),
    );

    expect(totals.tokens).toEqual({
      input: 14,
      output: 40,
      cacheRead: 60,
      cacheWrite: 80,
      reasoning: 100,
    });
    expect(totals.tokensReported).toBe(true);
  });
});

describe("usage ledger: cumulative costs and sources", () => {
  it("cumulative_cost_drop_folds_previous_value_into_base", () => {
    const totals = usageTotalsOf(
      applyAll([
        report({
          key: "acp",
          mode: UsageReportMode.cumulative,
          cost: { amount: 0.5, currency: "USD" },
        }),
        report({
          key: "acp",
          mode: UsageReportMode.cumulative,
          cost: { amount: 0.2, currency: "USD" },
        }),
      ]),
    );

    expect(totals.costs).toEqual({ USD: 0.7 });
    expect(totals.costReported).toBe(true);
  });

  it("cumulative_reports_for_separate_sources_are_summed", () => {
    const totals = usageTotalsOf(
      applyAll([
        report({
          key: "acc-a:session",
          mode: UsageReportMode.cumulative,
          tokens: TOKENS,
          cost: { amount: 0.5, currency: "USD" },
        }),
        report({
          key: "acc-b:session",
          mode: UsageReportMode.cumulative,
          tokens: TOKENS,
          cost: { amount: 0.2, currency: "USD" },
        }),
      ]),
    );

    expect(totals.tokens.input).toBe(20);
    expect(totals.costs).toEqual({ USD: 0.7 });
  });
});

describe("usage ledger: invalid input", () => {
  it("invalid_numbers_are_dropped", () => {
    const ledger = applyAll([
      report({ tokens: { ...TOKENS, input: -1 } }),
      report({ tokens: { ...TOKENS, output: 1.5 } }),
      report({ cost: { amount: Number.NaN, currency: "USD" } }),
      report({ cost: { amount: -0.1, currency: "USD" } }),
      report({ cost: { amount: 0.5, currency: "  " } }),
    ]);
    const totals = usageTotalsOf(ledger);

    expect(totals.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(totals.costs).toEqual({});
    expect(totals.tokensReported).toBe(false);
    expect(totals.costReported).toBe(false);
  });

  it("a_valid_part_survives_the_invalid_one", () => {
    const totals = usageTotalsOf(
      applyAll([
        report({
          tokens: { ...TOKENS, input: -1 },
          cost: { amount: 0.5, currency: "USD" },
        }),
      ]),
    );

    expect(totals.tokensReported).toBe(false);
    expect(totals.costs).toEqual({ USD: 0.5 });
    expect(totals.costReported).toBe(true);
  });
});

describe("usage ledger: reporters", () => {
  it("reporters_track_each_provider_separately", () => {
    const ledger = applyAll([
      report({
        provider: ProviderId.claude,
        key: "claude-acp",
        tokens: TOKENS,
        cost: { amount: 0.5, currency: "USD" },
      }),
      report({
        provider: ProviderId.codex,
        key: "codex-thread",
        tokens: TOKENS,
      }),
      report({ provider: ProviderId.gemini, key: "gemini-empty" }),
    ]);

    expect(ledger.reporters).toEqual({
      claude: { tokens: true, cost: true },
      codex: { tokens: true, cost: false },
      gemini: { tokens: false, cost: false },
    });
  });

  it("a_reporter_flag_is_never_cleared", () => {
    const ledger = applyAll([
      report({ cost: { amount: 0.5, currency: "USD" } }),
      report({ tokens: { ...TOKENS, input: -1 } }),
    ]);

    expect(ledger.reporters).toEqual({
      claude: { tokens: false, cost: true },
    });
  });
});
