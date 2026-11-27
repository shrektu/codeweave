import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/domain/events";
import { UsageReportMode } from "../../src/domain/events";
import { ProviderId } from "../../src/domain/types";
import {
  applyUsageReport,
  emptyUsageLedger,
} from "../../src/domain/usageLedger";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import type { SessionView, UsageLedgerView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeSession,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
} from "../fakes/fakeIpcClient";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

type UsageReport = Extract<AgentEvent, { type: "usage_report" }>;

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
} as const;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(cleanup);

function usageOf(reports: readonly UsageReport[]): UsageLedgerView {
  return reports.reduce(applyUsageReport, emptyUsageLedger());
}

function renderSession(session: SessionView): void {
  renderWithServices(
    <SessionStream />,
    createFakeIpcClient(),
    staticStore(
      readyState(
        makeSnapshot({ accounts: [makeAccount()], sessions: [session] }),
      ),
    ),
  );
}

function usageSummary(): HTMLElement {
  const summary = screen
    .getByRole("group", { name: "Usage" })
    .querySelector("summary");
  if (summary === null) {
    throw new Error("usage summary element is missing");
  }
  return summary;
}

function detailsPanel(summaryText: string): HTMLElement {
  const summary = screen.getByText(summaryText);
  const details = summary.closest("details");
  expect(details).not.toBeNull();
  return details as HTMLElement;
}

it("claude_usage_shows_tokens_and_dollar_cost", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.claude,
      usage: usageOf([
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "claude-acp",
          mode: UsageReportMode.cumulative,
          tokens: {
            input: 1_000,
            output: 500,
            cacheRead: 200,
            cacheWrite: 100,
            reasoning: 300,
          },
          cost: { amount: 0.5, currency: "USD" },
        },
      ]),
    }),
  );

  const summary = usageSummary();
  expect(summary.textContent).toBe("2.1K tokens · $0.50");

  const panel = within(detailsPanel("2.1K tokens · $0.50"));
  const rows = [
    ["Input", "1,000"],
    ["Output", "500"],
    ["Cache read", "200"],
    ["Cache write", "100"],
    ["Reasoning", "300"],
  ] as const;
  for (const [label, value] of rows) {
    expect(panel.getByText(label)).toBeTruthy();
    expect(panel.getByText(value)).toBeTruthy();
  }
  expect(panel.getAllByText("$0.50")).toHaveLength(1);
});

it("codex_usage_says_cost_not_reported", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.codex,
      usage: usageOf([
        {
          type: "usage_report",
          provider: ProviderId.codex,
          key: "codex-thread",
          mode: UsageReportMode.cumulative,
          tokens: { ...ZERO_TOKENS, input: 1_000, output: 500 },
          cost: null,
        },
      ]),
    }),
  );

  expect(usageSummary().textContent).toBe("1.5K tokens");
  expect(
    screen.getByText("Codex has not reported cost for this session"),
  ).toBeTruthy();
  expect(screen.queryAllByText(/\$/u)).toHaveLength(0);
});

it("agy_usage_says_usage_not_reported", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.gemini,
      usage: emptyUsageLedger(),
    }),
  );

  expect(usageSummary().textContent).toBe("No usage reported yet");
  expect(
    screen.getByText("Gemini has not reported usage for this session"),
  ).toBeTruthy();
  expect(screen.queryByText("Input")).toBeNull();
});

it("mixed_currencies_are_listed_separately", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.claude,
      usage: usageOf([
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "claude-acp",
          mode: UsageReportMode.cumulative,
          tokens: { ...ZERO_TOKENS, input: 500 },
          cost: { amount: 0.5, currency: "USD" },
        },
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "credits-source",
          mode: UsageReportMode.cumulative,
          tokens: null,
          cost: { amount: 12.5, currency: "credits" },
        },
      ]),
    }),
  );

  expect(usageSummary().textContent).toBe("500 tokens · $0.50 + 12.50 credits");
  expect(screen.queryByText("$13.00")).toBeNull();
});

it("ledger_sources_are_summed_into_one_total", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.claude,
      usage: usageOf([
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "claude-acp",
          mode: UsageReportMode.delta,
          tokens: { ...ZERO_TOKENS, input: 1_000 },
          cost: { amount: 0.5, currency: "USD" },
        },
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "rotated-acp",
          mode: UsageReportMode.cumulative,
          tokens: { ...ZERO_TOKENS, input: 500 },
          cost: { amount: 0.25, currency: "USD" },
        },
      ]),
    }),
  );

  expect(usageSummary().textContent).toBe("1.5K tokens · $0.75");
});

it("session_header_usage_is_announced_with_totals", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.claude,
      usage: usageOf([
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "claude-acp",
          mode: UsageReportMode.cumulative,
          tokens: { ...ZERO_TOKENS, input: 1_000, output: 500 },
          cost: { amount: 0.5, currency: "USD" },
        },
      ]),
    }),
  );

  const summary = usageSummary();
  expect(summary.hasAttribute("aria-label")).toBe(false);
  expect(summary.textContent).toBe("1.5K tokens · $0.50");
  expect(screen.getByRole("group", { name: "Usage" })).toBe(
    summary.closest("details"),
  );
});

it("rotated_session_names_provider_without_cost", () => {
  renderSession(
    makeSession({
      activeProvider: ProviderId.codex,
      usage: usageOf([
        {
          type: "usage_report",
          provider: ProviderId.claude,
          key: "claude-acp",
          mode: UsageReportMode.cumulative,
          tokens: { ...ZERO_TOKENS, input: 1_000 },
          cost: { amount: 0.5, currency: "USD" },
        },
        {
          type: "usage_report",
          provider: ProviderId.codex,
          key: "codex-thread",
          mode: UsageReportMode.cumulative,
          tokens: { ...ZERO_TOKENS, input: 500 },
          cost: null,
        },
      ]),
    }),
  );

  expect(
    screen.getByText("Codex has not reported cost for this session"),
  ).toBeTruthy();
  expect(screen.queryByText(/Claude has not reported/u)).toBeNull();
});
