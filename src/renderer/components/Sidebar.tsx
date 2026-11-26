import { X } from "lucide-react";
import { useState, type JSX } from "react";

import type {
  AccountRuntimeView,
  SessionHistoryEntry,
  SessionView,
} from "../../shared/views";
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
const SAVED_LABEL = "Saved";
const ARCHIVED_LABEL = "Archived";
const PATH_SEPARATOR = /[\\/]/;

function sessionLabel(session: SessionView): string {
  if (!session.explicitFolder) {
    return NO_FOLDER_LABEL;
  }
  return folderLabel(session.cwd);
}

function folderLabel(cwd: string): string {
  return cwd.split(PATH_SEPARATOR).filter(Boolean).at(-1) ?? cwd;
}

interface SessionListItem {
  readonly id: string;
  readonly at: number;
  readonly view: SessionView | null;
  readonly history: SessionHistoryEntry | null;
}

function sessionListItems(
  sessions: readonly SessionView[],
  history: readonly SessionHistoryEntry[],
  showArchived: boolean,
): SessionListItem[] {
  const known = new Set(sessions.map((session) => session.id));
  const entries = new Map(history.map((entry) => [entry.id, entry]));
  const live: SessionListItem[] = sessions.map((view) => ({
    id: view.id,
    at: view.createdAt,
    view,
    history: entries.get(view.id) ?? null,
  }));
  const saved: SessionListItem[] = history
    .filter(
      (entry) => !known.has(entry.id) && (showArchived || !entry.archived),
    )
    .map((entry) => ({
      id: entry.id,
      at: entry.updatedAt,
      view: null,
      history: entry,
    }));
  return [...live, ...saved]
    .map((item, index) => ({ item, index }))
    .toSorted(
      (left, right) => right.item.at - left.item.at || right.index - left.index,
    )
    .map(({ item }) => item);
}

function itemLabel(item: SessionListItem): string {
  if (item.history !== null && item.history.title !== "") {
    return item.history.title;
  }
  if (item.view !== null) {
    return sessionLabel(item.view);
  }
  return item.history === null
    ? NO_FOLDER_LABEL
    : folderLabel(item.history.cwd);
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
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const items = sessionListItems(
    state.snapshot?.sessions ?? [],
    state.history,
    showArchived,
  );

  const run = async (
    sessionId: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    setBusyId(sessionId);
    try {
      await action();
    } finally {
      setBusyId((current) => (current === sessionId ? null : current));
    }
  };

  return (
    <nav className="sidebar-section" aria-label="Sessions">
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
      <label className="field archive-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => {
            setShowArchived(event.target.checked);
          }}
        />
        Show archived
      </label>
      {items.length === 0 ? (
        <p className="empty">No sessions yet</p>
      ) : (
        <ul>
          {items.map((item) => {
            const active = item.id === state.activeSessionId;
            const select = (): void => {
              store.activateSession(item.id);
              onOpenSession?.();
            };
            const closing = busyId === item.id;
            if (item.history !== null && item.view === null) {
              const entry = item.history;
              return (
                <HistoryRow
                  key={item.id}
                  entry={entry}
                  active={active}
                  closing={closing}
                  onSelect={select}
                  onArchive={() => {
                    void run(item.id, () =>
                      client.request("history/archive", {
                        sessionId: item.id,
                        archived: true,
                      }),
                    );
                  }}
                  onRestore={() => {
                    void run(item.id, () =>
                      client.request("history/archive", {
                        sessionId: item.id,
                        archived: false,
                      }),
                    );
                  }}
                />
              );
            }
            if (item.view === null) {
              return null;
            }
            return (
              <SessionRow
                key={item.id}
                session={item.view}
                title={itemLabel(item)}
                active={active}
                closing={closing}
                onSelect={select}
                onClose={() => {
                  void run(item.id, () =>
                    client.request("session/close", { sessionId: item.id }),
                  );
                }}
              />
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function SessionRow({
  session,
  title,
  active,
  closing,
  onSelect,
  onClose,
}: {
  session: SessionView;
  title: string;
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
        <span className="item-label">{title}</span>
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

function HistoryRow({
  entry,
  active,
  closing,
  onSelect,
  onArchive,
  onRestore,
}: {
  entry: SessionHistoryEntry;
  active: boolean;
  closing: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onRestore: () => void;
}): JSX.Element {
  const label = entry.title === "" ? folderLabel(entry.cwd) : entry.title;
  return (
    <li
      className="item session-item"
      data-provider={entry.provider}
      aria-current={active ? "true" : undefined}
    >
      <button type="button" className="session-pick" onClick={onSelect}>
        <span className="dot" />
        <span className="item-label">{label}</span>
        {entry.orchestrate && <span className="badge">Orchestrator</span>}
        <small>{entry.archived ? ARCHIVED_LABEL : SAVED_LABEL}</small>
      </button>
      {entry.archived ? (
        <button
          type="button"
          className="btn session-restore"
          disabled={closing}
          onClick={onRestore}
        >
          Restore
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn session-close"
          aria-label="Close session"
          title="Archive session"
          disabled={closing}
          onClick={onArchive}
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
