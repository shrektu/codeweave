import type { JSX } from "react";

import type { TokenCounts } from "../../domain/events";
import type { ProviderId } from "../../domain/types";
import { usageTotalsOf, type UsageTotals } from "../../domain/usageLedger";
import { PROVIDER_DISPLAY_NAMES } from "../../shared/constants";
import type { UsageLedgerView } from "../../shared/views";
import { usageCostText, usageTokensText } from "../format";

import { USAGE_SUMMARY_STRINGS } from "./usageSummaryStrings";

export interface UsageSummaryProps {
  readonly usage: UsageLedgerView;
  readonly provider: ProviderId;
}

interface TokenRow {
  readonly key: keyof TokenCounts;
  readonly label: string;
}

const TOKEN_ROWS: readonly TokenRow[] = [
  { key: "input", label: USAGE_SUMMARY_STRINGS.input },
  { key: "output", label: USAGE_SUMMARY_STRINGS.output },
  { key: "cacheRead", label: USAGE_SUMMARY_STRINGS.cacheRead },
  { key: "cacheWrite", label: USAGE_SUMMARY_STRINGS.cacheWrite },
  { key: "reasoning", label: USAGE_SUMMARY_STRINGS.reasoning },
];

const TOKEN_VALUE_LOCALE = "en-US";
const SUMMARY_SEPARATOR = " · ";

function summaryText(totals: UsageTotals): string {
  const tokensText = totals.tokensReported
    ? usageTokensText(totals.tokens)
    : null;
  const costText = totals.costReported ? usageCostText(totals.costs) : null;
  if (tokensText !== null && costText !== null) {
    return `${tokensText}${SUMMARY_SEPARATOR}${costText}`;
  }
  return tokensText ?? costText ?? USAGE_SUMMARY_STRINGS.noUsageYet;
}

function Breakdown({ tokens }: { readonly tokens: TokenCounts }): JSX.Element {
  return (
    <dl>
      {TOKEN_ROWS.map((row) => (
        <div key={row.key}>
          <dt>{row.label}</dt>
          <dd>{tokens[row.key].toLocaleString(TOKEN_VALUE_LOCALE)}</dd>
        </div>
      ))}
    </dl>
  );
}

function notedProviders(
  usage: UsageLedgerView,
  active: ProviderId,
): readonly ProviderId[] {
  const reporters = Object.keys(usage.reporters) as ProviderId[];
  return [active, ...reporters.filter((provider) => provider !== active)];
}

function providerNotes(
  usage: UsageLedgerView,
  provider: ProviderId,
  totals: UsageTotals,
): readonly string[] {
  const name = PROVIDER_DISPLAY_NAMES[provider];
  const reporter = usage.reporters[provider];
  if (reporter === undefined) {
    return totals.tokensReported || totals.costReported
      ? [
          USAGE_SUMMARY_STRINGS.tokensNotReported(name),
          USAGE_SUMMARY_STRINGS.costNotReported(name),
        ]
      : [USAGE_SUMMARY_STRINGS.usageNotReported(name)];
  }
  return [
    ...(reporter.tokens ? [] : [USAGE_SUMMARY_STRINGS.tokensNotReported(name)]),
    ...(reporter.cost ? [] : [USAGE_SUMMARY_STRINGS.costNotReported(name)]),
  ];
}

function ProviderNotes({
  usage,
  provider,
  totals,
}: {
  readonly usage: UsageLedgerView;
  readonly provider: ProviderId;
  readonly totals: UsageTotals;
}): JSX.Element {
  const notes = notedProviders(usage, provider).flatMap((noted) =>
    providerNotes(usage, noted, totals),
  );
  return (
    <>
      {totals.costReported && (
        <p className="usage-summary-cost">{usageCostText(totals.costs)}</p>
      )}
      {notes.map((note) => (
        <p key={note} className="usage-summary-note">
          {note}
        </p>
      ))}
    </>
  );
}

export function UsageSummary({
  usage,
  provider,
}: UsageSummaryProps): JSX.Element {
  const totals = usageTotalsOf(usage);
  return (
    <details
      className="usage-summary"
      aria-label={USAGE_SUMMARY_STRINGS.usageLabel}
    >
      <summary>{summaryText(totals)}</summary>
      <div className="usage-summary-body">
        {totals.tokensReported && <Breakdown tokens={totals.tokens} />}
        <ProviderNotes usage={usage} provider={provider} totals={totals} />
      </div>
    </details>
  );
}
