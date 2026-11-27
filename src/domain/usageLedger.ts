import {
  UsageReportMode,
  type AgentEvent,
  type TokenCounts,
  type UsageCost,
} from "./events";
import type { ProviderId } from "./types";

export interface UsageTotals {
  readonly tokens: TokenCounts;
  readonly costs: Readonly<Record<string, number>>;
  readonly tokensReported: boolean;
  readonly costReported: boolean;
}

export interface UsageReporter {
  readonly tokens: boolean;
  readonly cost: boolean;
}

export interface UsageLedger {
  readonly base: UsageTotals;
  readonly sources: Readonly<Record<string, UsageTotals>>;
  readonly reporters: Readonly<Partial<Record<ProviderId, UsageReporter>>>;
}

type UsageReport = Extract<AgentEvent, { type: "usage_report" }>;

const ZERO_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

const ZERO_TOTALS: UsageTotals = {
  tokens: ZERO_TOKENS,
  costs: {},
  tokensReported: false,
  costReported: false,
};

const EMPTY_LEDGER: UsageLedger = {
  base: ZERO_TOTALS,
  sources: {},
  reporters: {},
};

export function emptyUsageLedger(): UsageLedger {
  return EMPTY_LEDGER;
}

function addTokens(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
  };
}

function isTokenCounts(tokens: TokenCounts): boolean {
  return [
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.reasoning,
  ].every((count) => Number.isInteger(count) && count >= 0);
}

function isCost(cost: UsageCost): boolean {
  return (
    Number.isFinite(cost.amount) &&
    cost.amount >= 0 &&
    cost.currency.trim() !== ""
  );
}

function withCost(
  totals: UsageTotals,
  currency: string,
  amount: number,
): UsageTotals {
  return {
    ...totals,
    costs: {
      ...totals.costs,
      [currency]: (totals.costs[currency] ?? 0) + amount,
    },
    costReported: true,
  };
}

function foldedTokens(base: UsageTotals, stored: UsageTotals): UsageTotals {
  return stored.tokensReported
    ? {
        ...base,
        tokens: addTokens(base.tokens, stored.tokens),
        tokensReported: true,
      }
    : base;
}

function foldedCost(
  base: UsageTotals,
  stored: UsageTotals,
  currency: string,
): UsageTotals {
  const amount = stored.costs[currency];
  return amount === undefined ? base : withCost(base, currency, amount);
}

function counterRestarted(tokens: TokenCounts, stored: TokenCounts): boolean {
  return (
    tokens.input < stored.input ||
    tokens.output < stored.output ||
    tokens.cacheRead < stored.cacheRead ||
    tokens.cacheWrite < stored.cacheWrite ||
    tokens.reasoning < stored.reasoning
  );
}

function applyDelta(
  ledger: UsageLedger,
  tokens: TokenCounts | null,
  cost: UsageCost | null,
): UsageLedger {
  let base = ledger.base;
  if (tokens !== null) {
    base = {
      ...base,
      tokens: addTokens(base.tokens, tokens),
      tokensReported: true,
    };
  }
  if (cost !== null) {
    base = withCost(base, cost.currency, cost.amount);
  }
  return { ...ledger, base };
}

function applyCumulative(
  ledger: UsageLedger,
  key: string,
  tokens: TokenCounts | null,
  cost: UsageCost | null,
): UsageLedger {
  const stored = ledger.sources[key] ?? ZERO_TOTALS;
  let base = ledger.base;
  let source = stored;
  if (tokens !== null) {
    if (counterRestarted(tokens, stored.tokens)) {
      base = foldedTokens(base, stored);
    }
    source = { ...source, tokens, tokensReported: true };
  }
  if (cost !== null) {
    const previous = stored.costs[cost.currency];
    if (previous !== undefined && cost.amount < previous) {
      base = foldedCost(base, stored, cost.currency);
    }
    source = {
      ...source,
      costs: { ...source.costs, [cost.currency]: cost.amount },
      costReported: true,
    };
  }
  return { ...ledger, base, sources: { ...ledger.sources, [key]: source } };
}

function withReporter(
  ledger: UsageLedger,
  provider: ProviderId,
  tokens: TokenCounts | null,
  cost: UsageCost | null,
): UsageLedger {
  const previous = ledger.reporters[provider];
  return {
    ...ledger,
    reporters: {
      ...ledger.reporters,
      [provider]: {
        tokens: (previous?.tokens ?? false) || tokens !== null,
        cost: (previous?.cost ?? false) || cost !== null,
      },
    },
  };
}

export function applyUsageReport(
  ledger: UsageLedger,
  report: UsageReport,
): UsageLedger {
  const tokens =
    report.tokens !== null && isTokenCounts(report.tokens)
      ? report.tokens
      : null;
  const cost = report.cost !== null && isCost(report.cost) ? report.cost : null;
  const reported = withReporter(ledger, report.provider, tokens, cost);
  if (tokens === null && cost === null) {
    return reported;
  }
  return report.mode === UsageReportMode.delta
    ? applyDelta(reported, tokens, cost)
    : applyCumulative(reported, report.key, tokens, cost);
}

export function usageTotalsOf(ledger: UsageLedger): UsageTotals {
  let tokens = ledger.base.tokens;
  let tokensReported = ledger.base.tokensReported;
  let costReported = ledger.base.costReported;
  const costs: Record<string, number> = { ...ledger.base.costs };
  for (const source of Object.values(ledger.sources)) {
    tokens = addTokens(tokens, source.tokens);
    for (const [currency, amount] of Object.entries(source.costs)) {
      costs[currency] = (costs[currency] ?? 0) + amount;
    }
    tokensReported ||= source.tokensReported;
    costReported ||= source.costReported;
  }
  return { tokens, costs, tokensReported, costReported };
}
