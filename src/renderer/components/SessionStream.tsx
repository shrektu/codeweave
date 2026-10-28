import { useState, type JSX } from "react";

import type {
  AccountView,
  FlowRef,
  FlowsList,
  MessageView,
  PermissionView,
  RotationPhaseView,
  SessionView,
  ToolCallView,
} from "../../shared/views";
import {
  accountLabel,
  formatLocalTime,
  isSelectable,
  PROVIDER_LABELS,
  providerOf,
  type SelectableProvider,
} from "../format";
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
  turnInFlight: boolean,
): string {
  switch (phase.phase) {
    case "running":
      return `${turnInFlight ? "Working" : "Idle"} on ${accountLabel(accounts, phase.accountId)}`;
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

interface NodeChoice {
  flowRef: FlowRef;
  label: string;
}

interface PendingStart {
  cwd: string;
  choices: NodeChoice[];
}

const NO_CHOICE = "";

function nodeChoices(list: FlowsList): NodeChoice[] {
  return list.flows.flatMap((flow) =>
    flow.nodes.map((node) => ({
      flowRef: { flowId: flow.id, nodeId: node.id },
      label: `${flow.title} / ${node.id}`,
    })),
  );
}

function distinctProviders(
  accounts: readonly AccountView[],
): SelectableProvider[] {
  return [...new Set(accounts.map((account) => account.provider))].filter(
    isSelectable,
  );
}

function StartPrompt(): JSX.Element {
  const { client, state } = useApp();
  const start = useAsyncAction();
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [chosen, setChosen] = useState(NO_CHOICE);
  const [picked, setPicked] = useState<SelectableProvider | null>(null);
  const providers = distinctProviders(state.snapshot?.accounts ?? []);
  const provider = providers.find((id) => id === picked) ?? providers[0];

  const startSession = async (
    cwd: string,
    flowRef: FlowRef | undefined,
  ): Promise<void> => {
    await client.request("session/start", {
      cwd,
      ...(provider === undefined ? {} : { provider }),
      ...(flowRef === undefined ? {} : { flowRef }),
    });
    setPending(null);
    setChosen(NO_CHOICE);
  };

  const listChoices = async (cwd: string): Promise<NodeChoice[]> => {
    try {
      return nodeChoices(await client.request("flows/list", { cwd }));
    } catch (error: unknown) {
      console.error("Could not list flows", error);
      return [];
    }
  };

  const chooseFolder = (): void => {
    void start.run(async () => {
      const cwd = await window.codeweave.pickFolder();
      if (cwd === null) {
        return;
      }
      const choices = await listChoices(cwd);
      if (choices.length === 0) {
        await startSession(cwd, undefined);
        return;
      }
      setChosen(NO_CHOICE);
      setPending({ cwd, choices });
    });
  };

  const startChosen = (): void => {
    if (pending === null) {
      return;
    }
    const choice =
      chosen === NO_CHOICE ? undefined : pending.choices[Number(chosen)];
    void start.run(() => startSession(pending.cwd, choice?.flowRef));
  };

  return (
    <div className="empty-state">
      <p className="empty-title">No session</p>
      <p className="empty">Choose a project folder to start.</p>
      {providers.length > 1 && (
        <select
          aria-label="Agent"
          value={provider}
          onChange={(event) => {
            setPicked(providerOf(event.target.value));
          }}
        >
          {providers.map((id) => (
            <option key={id} value={id}>
              {PROVIDER_LABELS[id]}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="btn pri"
        disabled={start.pending}
        onClick={chooseFolder}
      >
        Choose folder…
      </button>
      {pending !== null && (
        <>
          <label className="field">
            Flow node
            <select
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            >
              <option value={NO_CHOICE}>None</option>
              {pending.choices.map((choice, index) => (
                <option
                  key={`${choice.flowRef.flowId}/${choice.flowRef.nodeId}`}
                  value={index.toString()}
                >
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn pri"
            disabled={start.pending}
            onClick={startChosen}
          >
            Start session
          </button>
        </>
      )}
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
        <span className="phase">
          {phaseText(session.phase, accounts, session.turnInFlight)}
        </span>
        {session.phase.phase !== "stopped" && (
          <button
            type="button"
            className="btn"
            disabled={stop.pending}
            onClick={() => {
              void stop.run(() => client.request("session/stop", {}));
            }}
          >
            {session.turnInFlight ? "Stop" : "End session"}
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
