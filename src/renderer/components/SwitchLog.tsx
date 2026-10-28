import type { JSX } from "react";

import { SwitchReason } from "../../domain/types";
import { accountLabel, formatLocalTime, MS_PER_SECOND } from "../format";
import { useApp } from "../services";

const REASON_LABELS: Record<SwitchReason, string> = {
  [SwitchReason.rateLimit]: "rate limit",
  [SwitchReason.needsLogin]: "needs login",
  [SwitchReason.resetReached]: "reset reached",
};

const NO_TARGET_LABEL = "none";

export function SwitchLog(): JSX.Element {
  const { state } = useApp();
  const accounts = state.snapshot?.accounts ?? [];
  const entries = (state.snapshot?.switchLog ?? []).toSorted(
    (a, b) => b.at - a.at,
  );

  return (
    <section className="glass panel" aria-label="Switch log">
      <h2 className="sec">Switch log</h2>
      {entries.length === 0 ? (
        <p className="empty">No switches yet</p>
      ) : (
        <ul className="log">
          {entries.map((entry) => {
            const to =
              entry.to === null
                ? NO_TARGET_LABEL
                : accountLabel(accounts, entry.to);
            const time = formatLocalTime(entry.at / MS_PER_SECOND);
            return (
              <li
                key={`${entry.at.toString()}-${entry.sessionId}-${entry.from}-${entry.reason}`}
                className="log-item"
              >
                {`${time} ${accountLabel(accounts, entry.from)} → ${to} · ${REASON_LABELS[entry.reason]}`}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
