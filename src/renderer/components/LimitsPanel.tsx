import type { JSX } from "react";

import { RATE_LIMIT_STATUS_REJECTED } from "../../domain/constants";
import type { AccountView, LimitView } from "../../shared/views";
import {
  accountLabel,
  COUNTDOWN_NOW,
  formatCountdown,
  formatLocalTime,
  isStale,
  MS_PER_MINUTE,
  shownSessionOf,
} from "../format";
import { useApp } from "../services";
import { useNow } from "../useNow";

const PERCENT = 100;

interface LimitRowProps {
  limit: LimitView;
  accounts: readonly AccountView[];
  activeAccountId: string | null;
  now: number;
}

function resetText(resetsAt: number, now: number): string {
  const countdown = formatCountdown(resetsAt, now);
  return countdown === COUNTDOWN_NOW
    ? "Resets now"
    : `Resets at ${formatLocalTime(resetsAt)} (${countdown})`;
}

function LimitRow({
  limit,
  accounts,
  activeAccountId,
  now,
}: LimitRowProps): JSX.Element {
  const label = accountLabel(accounts, limit.accountId);
  const exhausted = limit.status === RATE_LIMIT_STATUS_REJECTED;
  const percent = exhausted
    ? PERCENT
    : Math.round((limit.utilization ?? 0) * PERCENT);
  return (
    <div className="meter" data-status={limit.status}>
      <div className="meter-head">
        <span>{label}</span>
        <span>
          {!exhausted && isStale(limit, now, activeAccountId) && (
            <span className="badge">stale</span>
          )}
          {exhausted ? "Exhausted" : `${percent.toString()}%`}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={PERCENT}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent.toString()}%` }} />
      </div>
      {limit.resetsAt !== null && <span>{resetText(limit.resetsAt, now)}</span>}
    </div>
  );
}

export function LimitsPanel(): JSX.Element {
  const { state } = useApp();
  const now = useNow(MS_PER_MINUTE);
  const accounts = state.snapshot?.accounts ?? [];
  const { session } = shownSessionOf(state.snapshot, state.focusedRunId);
  const sessionLimits = session?.limits ?? [];
  const limits = [
    ...sessionLimits,
    ...accounts.flatMap(({ id, limit }) =>
      limit !== null && !sessionLimits.some((item) => item.accountId === id)
        ? [limit]
        : [],
    ),
  ];

  return (
    <section className="glass panel" aria-label="Limits">
      <h2 className="sec">Limits</h2>
      {limits.length === 0 ? (
        <p className="empty">No limit data yet</p>
      ) : (
        limits.map((limit) => (
          <LimitRow
            key={limit.accountId}
            limit={limit}
            accounts={accounts}
            activeAccountId={session?.activeAccountId ?? null}
            now={now}
          />
        ))
      )}
    </section>
  );
}
