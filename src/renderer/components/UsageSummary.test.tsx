import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { AgentEvent } from "../../domain/events";
import { UsageReportMode } from "../../domain/events";
import { ProviderId } from "../../domain/types";
import { applyUsageReport, emptyUsageLedger } from "../../domain/usageLedger";
import type { UsageLedgerView } from "../../shared/views";

import { UsageSummary } from "./UsageSummary";

type UsageReport = Extract<AgentEvent, { type: "usage_report" }>;

afterEach(cleanup);

function usageOf(reports: readonly UsageReport[]): UsageLedgerView {
  return reports.reduce(applyUsageReport, emptyUsageLedger());
}

const COST_ONLY = usageOf([
  {
    type: "usage_report",
    provider: ProviderId.codex,
    key: "claude-acp",
    mode: UsageReportMode.cumulative,
    tokens: null,
    cost: { amount: 1.25, currency: "USD" },
  },
]);

const TOKENS = {
  input: 1_000,
  output: 500,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

const CLAUDE_REPORT: UsageReport = {
  type: "usage_report",
  provider: ProviderId.claude,
  key: "claude-acp",
  mode: UsageReportMode.cumulative,
  tokens: TOKENS,
  cost: { amount: 0.5, currency: "USD" },
};

const CODEX_REPORT: UsageReport = {
  type: "usage_report",
  provider: ProviderId.codex,
  key: "codex-thread",
  mode: UsageReportMode.cumulative,
  tokens: TOKENS,
  cost: null,
};

function summaryOf(container: HTMLElement): HTMLElement {
  const summary = container.querySelector("summary");
  if (summary === null) {
    throw new Error("usage summary element is missing");
  }
  return summary;
}

it("usage_summary_announces_totals", () => {
  const { container } = render(
    <UsageSummary
      usage={usageOf([CLAUDE_REPORT])}
      provider={ProviderId.claude}
    />,
  );

  const summary = summaryOf(container);
  expect(summary.hasAttribute("aria-label")).toBe(false);
  expect(summary.hasAttribute("aria-labelledby")).toBe(false);
  expect(summary.textContent).toContain("1.5K tokens");
  expect(summary.textContent).toContain("$0.50");
  expect(screen.getByRole("group", { name: "Usage" })).toBe(
    summary.closest("details"),
  );
});

it("rotation_to_provider_without_cost_says_cost_not_reported", () => {
  const rotated = usageOf([CLAUDE_REPORT, CODEX_REPORT]);

  render(<UsageSummary usage={rotated} provider={ProviderId.codex} />);

  expect(
    screen.getByText("Codex has not reported cost for this session"),
  ).toBeTruthy();
  expect(screen.queryByText(/Claude has not reported/u)).toBeNull();
});

it("cost_only_shows_tokens_not_reported", () => {
  render(<UsageSummary usage={COST_ONLY} provider={ProviderId.codex} />);

  expect(
    screen.getByRole("group", { name: "Usage" }).querySelector("summary")
      ?.textContent,
  ).toBe("$1.25");
  expect(
    screen.getByText("Codex has not reported tokens for this session"),
  ).toBeTruthy();
});

it("token_rows_hidden_when_tokens_not_reported", () => {
  const { container } = render(
    <UsageSummary usage={COST_ONLY} provider={ProviderId.codex} />,
  );

  expect(screen.queryByText("Input")).toBeNull();
  expect(screen.queryByText("Cache read")).toBeNull();
  expect(container.querySelector("dl")).toBeNull();
  expect(screen.getAllByText("$1.25")).toHaveLength(2);
});
