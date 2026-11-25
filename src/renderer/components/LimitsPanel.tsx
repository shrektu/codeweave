import type { JSX } from "react";

import { RATE_LIMIT_STATUS_REJECTED } from "../../domain/constants";
import { mergeLimitWindows } from "../../domain/limitWindows";
import type {
  AccountView,
  LimitView,
  LimitWindowView,
} from "../../shared/views";
import {
  accountLabel,
  COUNTDOWN_NOW,
  formatCountdown,
  formatLocalTime,
  isStale,
  limitPercent,
  limitWindowLabel,
  MS_PER_MINUTE,
  shownSessionOf,
  missingLimitText,
  PERCENT_SCALE,
} from "../format";
import { useApp } from "../services";
import { useNow } from "../useNow";

interface LimitRowProps {
  limit: LimitView;
  accounts: readonly AccountView[];
  activeAccountId: string | null;
  now: number;
}

interface AccountBlockProps {
  label: string;
  windows: readonly LimitWindowView[];
  limit: LimitView;
  activeAccountId: string | null;
  now: number;
}

interface WindowMeterProps {
  label: string;
  window: LimitWindowView;
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
  const percent = limitPercent(limit.utilization, exhausted);
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
        aria-valuemax={PERCENT_SCALE}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent.toString()}%` }} />
      </div>
      {limit.resetsAt !== null && <span>{resetText(limit.resetsAt, now)}</span>}
    </div>
  );
}

function WindowMeter({ label, window, now }: WindowMeterProps): JSX.Element {
  const windowLabel = limitWindowLabel(window);
  const percent = limitPercent(window.utilization, window.exhausted);
  return (
    <div
      className="meter"
      data-status={window.exhausted ? RATE_LIMIT_STATUS_REJECTED : undefined}
    >
      <div className="meter-head">
        <span>{windowLabel}</span>
        <span>{window.exhausted ? "Exhausted" : `${percent.toString()}%`}</span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={`${label} ${windowLabel}`}
        aria-valuemin={0}
        aria-valuemax={PERCENT_SCALE}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent.toString()}%` }} />
      </div>
      {window.resetsAt !== null && (
        <span>{resetText(window.resetsAt, now)}</span>
      )}
    </div>
  );
}

function AccountBlock({
  label,
  windows,
  limit,
  activeAccountId,
  now,
}: AccountBlockProps): JSX.Element {
  const exhausted = limit.status === RATE_LIMIT_STATUS_REJECTED;
  return (
    <div className="limit-block">
      <div className="meter-head">
        <span>{label}</span>
        <span>
          {!exhausted && isStale(limit, now, activeAccountId) && (
            <span className="badge">stale</span>
          )}
          {exhausted && "Exhausted"}
        </span>
        {exhausted && limit.resetsAt !== null && (
          <span>{resetText(limit.resetsAt, now)}</span>
        )}
      </div>
      {windows.map((window) => (
        <WindowMeter key={window.id} label={label} window={window} now={now} />
      ))}
    </div>
  );
}

function MissingBlock({ account }: { account: AccountView }): JSX.Element {
  return (
    <div className="limit-block">
      <div className="meter-head">
        <span>{account.label}</span>
      </div>
      <p className="empty">{missingLimitText(account)}</p>
    </div>
  );
}

export function LimitsPanel(): JSX.Element {
  const { state } = useApp();
  const now = useNow(MS_PER_MINUTE);
  const accounts = state.snapshot?.accounts ?? [];
  const { session } = shownSessionOf(
    state.snapshot,
    state.activeSessionId,
    state.focusedRunId,
  );
  const sessionLimits = session?.limits ?? [];
  const activeAccountId = session?.activeAccountId ?? null;
  const unlisted = sessionLimits.filter(
    (limit) => !accounts.some((account) => account.id === limit.accountId),
  );

  function blockOf(account: AccountView): JSX.Element {
    const sessionLimit =
      sessionLimits.find((limit) => limit.accountId === account.id) ?? null;
    const limit = sessionLimit ?? account.limit;
    if (limit === null) {
      return <MissingBlock key={account.id} account={account} />;
    }
    const windows = mergeLimitWindows(
      account.limit?.windows ?? [],
      sessionLimit?.windows ?? [],
    );
    return windows.length === 0 ? (
      <LimitRow
        key={account.id}
        limit={limit}
        accounts={accounts}
        activeAccountId={activeAccountId}
        now={now}
      />
    ) : (
      <AccountBlock
        key={account.id}
        label={account.label}
        windows={windows}
        limit={limit}
        activeAccountId={activeAccountId}
        now={now}
      />
    );
  }

  return (
    <section className="glass panel" aria-label="Limits">
      <h2 className="sec">Limits</h2>
      {accounts.length === 0 && unlisted.length === 0 ? (
        <p className="empty">No limit data yet</p>
      ) : (
        <>
          {accounts.map(blockOf)}
          {unlisted.map((limit) => (
            <LimitRow
              key={limit.accountId}
              limit={limit}
              accounts={accounts}
              activeAccountId={activeAccountId}
              now={now}
            />
          ))}
        </>
      )}
    </section>
  );
}
