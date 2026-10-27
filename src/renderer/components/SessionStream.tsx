import type { JSX } from "react";

import type {
  AccountView,
  MessageView,
  PermissionView,
  RotationPhaseView,
  SessionView,
  ToolCallView,
} from "../../shared/views";
import { accountLabel, formatLocalTime } from "../format";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

import { Composer } from "./Composer";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";

interface SessionBodyProps {
  session: SessionView;
  accounts: readonly AccountView[];
}

const RESTARTABLE_PHASES: readonly RotationPhaseView["phase"][] = [
  "stopped",
  "failed",
  "halted",
];

function phaseText(
  phase: RotationPhaseView,
  accounts: readonly AccountView[],
): string {
  switch (phase.phase) {
    case "running":
      return `Running on ${accountLabel(accounts, phase.accountId)}`;
    case "switching":
      return `Switching from ${accountLabel(accounts, phase.from)} to ${accountLabel(accounts, phase.to)}`;
    case "waiting":
      return `Waiting for ${accountLabel(accounts, phase.accountId)} until ${formatLocalTime(phase.until)}`;
    case "failed":
      return `Failed: ${phase.reason}`;
    case "halted":
      return "Halted: no usable accounts";
    case "stopped":
      return "Stopped";
  }
}

type StreamItem = { readonly key: string; readonly seq: number } & (
  | { readonly kind: "message"; readonly message: MessageView }
  | { readonly kind: "tool"; readonly tool: ToolCallView }
  | { readonly kind: "permission"; readonly permission: PermissionView }
);

function streamItems(session: SessionView): StreamItem[] {
  const items: StreamItem[] = [
    ...session.messages.map((message, index): StreamItem => ({
      kind: "message",
      key: `message-${index.toString()}`,
      seq: message.seq,
      message,
    })),
    ...session.toolCalls.map((tool): StreamItem => ({
      kind: "tool",
      key: `tool-${tool.toolCallId}`,
      seq: tool.seq,
      tool,
    })),
    ...session.permissions.map((permission): StreamItem => ({
      kind: "permission",
      key: `permission-${permission.requestId}`,
      seq: permission.seq,
      permission,
    })),
  ];
  return items.toSorted((left, right) => left.seq - right.seq);
}

function StreamEntry({ item }: { item: StreamItem }): JSX.Element {
  switch (item.kind) {
    case "message":
      return <li className="card">{item.message.text}</li>;
    case "tool":
      return (
        <li>
          <ToolCard tool={item.tool} />
        </li>
      );
    case "permission":
      return (
        <li>
          <PermissionCard permission={item.permission} />
        </li>
      );
  }
}

function StartPrompt(): JSX.Element {
  const { client, state } = useApp();
  const start = useAsyncAction();

  const chooseFolder = (): void => {
    void start.run(async () => {
      const cwd = await window.codeweave.pickFolder();
      if (cwd !== null) {
        await client.request("session/start", { cwd });
      }
    });
  };

  return (
    <div className="empty-state">
      <p className="empty-title">No session</p>
      <p className="empty">Choose a project folder to start.</p>
      <button
        type="button"
        className="btn pri"
        disabled={start.pending}
        onClick={chooseFolder}
      >
        Choose folder…
      </button>
      {start.error !== null && <p className="error">{start.error}</p>}
      {state.error !== null && <p className="error">{state.error}</p>}
    </div>
  );
}

function SessionBody({ session, accounts }: SessionBodyProps): JSX.Element {
  const { client } = useApp();
  const stop = useAsyncAction();

  return (
    <>
      <div className="session-head">
        <span className="cwd">{session.cwd}</span>
        <span className="phase">{phaseText(session.phase, accounts)}</span>
        {session.phase.phase !== "stopped" && (
          <button
            type="button"
            className="btn"
            disabled={stop.pending}
            onClick={() => {
              void stop.run(() => client.request("session/stop", {}));
            }}
          >
            Stop
          </button>
        )}
      </div>
      {stop.error !== null && <p className="error">{stop.error}</p>}
      <ul className="stream">
        {streamItems(session).map((item) => (
          <StreamEntry key={item.key} item={item} />
        ))}
      </ul>
      {RESTARTABLE_PHASES.includes(session.phase.phase) && <StartPrompt />}
      <Composer />
    </>
  );
}

export function SessionStream(): JSX.Element {
  const { state } = useApp();
  const session = state.snapshot?.session ?? null;

  return (
    <section className="glass panel" aria-label="Session">
      <h2 className="sec">Session</h2>
      {session === null ? (
        <StartPrompt />
      ) : (
        <SessionBody
          session={session}
          accounts={state.snapshot?.accounts ?? []}
        />
      )}
    </section>
  );
}
