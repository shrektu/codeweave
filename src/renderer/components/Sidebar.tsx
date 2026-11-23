import type { JSX } from "react";

import type { AccountRuntimeView } from "../../shared/views";
import {
  formatLocalTime,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  shownSessionOf,
} from "../format";
import { useApp } from "../services";
import { useNow } from "../useNow";

export interface SidebarProps {
  onManageAccounts: () => void;
}

function statusText(runtime: AccountRuntimeView, now: number): string {
  switch (runtime.status) {
    case "ready":
      return "Ready";
    case "exhausted":
      return runtime.resetsAt * MS_PER_SECOND <= now
        ? "Ready"
        : `Exhausted · ${formatLocalTime(runtime.resetsAt)}`;
    case "needs_login":
      return "Needs login";
  }
}

function statusTitle(
  runtime: AccountRuntimeView,
  now: number,
): string | undefined {
  return statusTone(runtime, now) === "exhausted" &&
    runtime.status === "exhausted"
    ? `Rate limited until ${formatLocalTime(runtime.resetsAt)}`
    : undefined;
}

function statusTone(runtime: AccountRuntimeView, now: number): string {
  if (
    runtime.status === "exhausted" &&
    runtime.resetsAt * MS_PER_SECOND > now
  ) {
    return "exhausted";
  }
  return runtime.status === "needs_login" ? "needs_login" : "ready";
}

export function Sidebar({ onManageAccounts }: SidebarProps): JSX.Element {
  const { state } = useApp();
  const now = useNow(MS_PER_MINUTE);
  const accounts = state.snapshot?.accounts ?? [];
  const activeAccountId =
    shownSessionOf(state.snapshot, state.focusedRunId).session
      ?.activeAccountId ?? null;

  return (
    <section className="glass panel sidebar" aria-label="Accounts">
      <h2 className="sec">Accounts</h2>
      {accounts.length === 0 ? (
        <p className="empty">No accounts yet</p>
      ) : (
        <ul>
          {accounts.map((account) => (
            <li
              key={account.id}
              className="item"
              data-provider={account.provider}
              aria-current={account.id === activeAccountId ? "true" : undefined}
            >
              <span className="dot" />
              <span className="item-label">{account.label}</span>
              <small
                data-status={statusTone(account.runtime, now)}
                title={statusTitle(account.runtime, now)}
              >
                {statusText(account.runtime, now)}
              </small>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" onClick={onManageAccounts}>
        Manage accounts
      </button>
    </section>
  );
}
