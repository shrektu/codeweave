import { X } from "lucide-react";
import { useState, type JSX } from "react";

import type { AccountRuntimeView, SessionView } from "../../shared/views";
import {
  formatLocalTime,
  isSessionLive,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  shownSessionOf,
} from "../format";
import { useApp } from "../services";
import { useNow } from "../useNow";

export interface SidebarProps {
  onManageAccounts: () => void;
  onOpenSession?: () => void;
}

const NO_FOLDER_LABEL = "No folder";
const PATH_SEPARATOR = /[\\/]/;

function sessionLabel(session: SessionView): string {
  if (!session.explicitFolder) {
    return NO_FOLDER_LABEL;
  }
  return (
    session.cwd.split(PATH_SEPARATOR).filter(Boolean).at(-1) ?? session.cwd
  );
}

function sessionStatus(session: SessionView): string {
  if (!isSessionLive(session)) {
    return session.phase.phase === "stopped" ? "Stopped" : "Failed";
  }
  if (session.permissions.length > 0) {
    return "Needs permission";
  }
  return session.turnInFlight ? "Running" : "Idle";
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

function SessionsSection({
  onOpenSession,
}: {
  onOpenSession?: (() => void) | undefined;
}): JSX.Element {
  const { client, store, state } = useApp();
  const [closingId, setClosingId] = useState<string | null>(null);
  const sessions = [...(state.snapshot?.sessions ?? [])].toReversed();

  const closeSession = async (sessionId: string): Promise<void> => {
    setClosingId(sessionId);
    try {
      await client.request("session/close", { sessionId });
    } finally {
      setClosingId((current) => (current === sessionId ? null : current));
    }
  };

  return (
    <section className="sidebar-section" aria-label="Sessions">
      <div className="sidebar-head">
        <h2 className="sec">Sessions</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            store.activateSession(null);
            onOpenSession?.();
          }}
        >
          New session
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="empty">No sessions yet</p>
      ) : (
        <ul>
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === state.activeSessionId}
              closing={closingId === session.id}
              onSelect={() => {
                store.activateSession(session.id);
                onOpenSession?.();
              }}
              onClose={() => {
                void closeSession(session.id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionRow({
  session,
  active,
  closing,
  onSelect,
  onClose,
}: {
  session: SessionView;
  active: boolean;
  closing: boolean;
  onSelect: () => void;
  onClose: () => void;
}): JSX.Element {
  const live = isSessionLive(session);
  return (
    <li
      className="item session-item"
      data-provider={session.provider}
      aria-current={active ? "true" : undefined}
    >
      <button type="button" className="session-pick" onClick={onSelect}>
        <span className="dot" />
        <span className="item-label">{sessionLabel(session)}</span>
        {session.orchestrate && <span className="badge">Orchestrator</span>}
        <small>{sessionStatus(session)}</small>
      </button>
      {!live && (
        <button
          type="button"
          className="icon-btn session-close"
          aria-label="Close session"
          title="Close session"
          disabled={closing}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function AccountsSection({
  onManageAccounts,
}: {
  onManageAccounts: () => void;
}): JSX.Element {
  const { state } = useApp();
  const now = useNow(MS_PER_MINUTE);
  const accounts = state.snapshot?.accounts ?? [];
  const activeAccountId =
    shownSessionOf(state.snapshot, state.activeSessionId, state.focusedRunId)
      .session?.activeAccountId ?? null;

  return (
    <section className="sidebar-section" aria-label="Accounts">
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

export function Sidebar({
  onManageAccounts,
  onOpenSession,
}: SidebarProps): JSX.Element {
  return (
    <aside className="glass panel sidebar">
      <SessionsSection onOpenSession={onOpenSession} />
      <AccountsSection onManageAccounts={onManageAccounts} />
    </aside>
  );
}
