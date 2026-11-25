import { useState, type JSX } from "react";

import { ProviderId } from "../../domain/types";
import type {
  AccountView,
  FlowRef,
  FlowRunView,
  FlowsList,
  MessageView,
  PermissionView,
  RotationPhaseView,
  SessionView,
  ToolCallView,
  TurnRouteView,
} from "../../shared/views";
import {
  accountLabel,
  focusedRunOf,
  formatLocalTime,
  isSelectable,
  isSessionLive,
  PROVIDER_LABELS,
  providerOf,
  shownSessionOf,
  type SelectableProvider,
} from "../format";
import { sessionModelText, turnBadge } from "../routingText";
import { useApp, useServices } from "../services";
import { useAsyncAction, type AsyncAction } from "../useAsyncAction";
import { useRecentFolders } from "../useRecentFolders";

import { Markdown } from "../markdown/Markdown";

import { Composer } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { PathField } from "./PathField";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";

const IDENTITY_SEPARATOR = " · ";
const NO_ACCOUNT_LABEL = "—";

interface UnsentDraft {
  readonly sessionId: string | null;
  readonly text: string;
}

function unsentTextFor(unsent: UnsentDraft | null, sessionId: string): string {
  const belongs =
    unsent !== null &&
    (unsent.sessionId === null || unsent.sessionId === sessionId);
  return belongs ? unsent.text : "";
}

interface StartDraft {
  readonly task: string;
  readonly setTask: (task: string) => void;
  readonly unsent: UnsentDraft | null;
  readonly setUnsent: (unsent: UnsentDraft | null) => void;
  readonly start: AsyncAction;
}

interface SessionBodyProps {
  draft: StartDraft;
  session: SessionView;
  runId: string | null;
  accounts: readonly AccountView[];
}

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
  | { readonly kind: "turn"; readonly turn: TurnRouteView }
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
    ...session.turns.map((turn): StreamItem => ({
      kind: "turn",
      key: `turn-${turn.promptSeq.toString()}`,
      seq: turn.promptSeq,
      turn,
    })),
  ];
  return items.toSorted((left, right) => left.seq - right.seq);
}

function TurnBadgeEntry({ turn }: { turn: TurnRouteView }): JSX.Element {
  const badge = turnBadge(turn);
  return (
    <li
      className="turn-badge"
      title={badge.description}
      aria-label={badge.description}
    >
      {badge.text}
    </li>
  );
}

function StreamEntry({
  item,
  runId,
}: {
  item: StreamItem;
  runId: string | null;
}): JSX.Element {
  switch (item.kind) {
    case "turn":
      return <TurnBadgeEntry turn={item.turn} />;
    case "message":
      return (
        <li className="card msg">
          <Markdown text={item.message.text} />
        </li>
      );
    case "tool":
      return (
        <li>
          <ToolCard tool={item.tool} />
        </li>
      );
    case "permission":
      return (
        <li>
          <PermissionCard permission={item.permission} runId={runId} />
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
const ORCHESTRATE_HINT = "The agent plans the task and runs flows for it.";
const ORCHESTRATE_BLOCKED_HINT =
  "Orchestrate is not available for Gemini (agy) yet.";

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

interface TaskStartProps {
  readonly draft: StartDraft;
  readonly provider: SelectableProvider | undefined;
  readonly orchestrating: boolean;
}

function TaskStart({
  draft,
  provider,
  orchestrating,
}: TaskStartProps): JSX.Element {
  const { client, state } = useApp();
  const { task, setTask, setUnsent, start } = draft;
  const workspace = state.snapshot?.settings.defaultWorkspaceResolved;

  const startWithTask = (): void => {
    const text = task.trim();
    setUnsent(null);
    void start.run(async () => {
      let sessionId: string | null = null;
      try {
        const started = await client.request("session/start", {
          ...(provider === undefined ? {} : { provider }),
          ...(orchestrating ? { orchestrate: true } : {}),
        });
        sessionId = started.id;
        await client.request("session/prompt", { text });
      } catch (error: unknown) {
        setUnsent({ sessionId, text });
        throw error;
      }
      setTask("");
    });
  };

  return (
    <>
      <textarea
        aria-label="Task"
        placeholder="What should the agent do?"
        value={task}
        onChange={(event) => {
          setTask(event.target.value);
        }}
      />
      <button
        type="button"
        className="btn pri"
        disabled={start.pending || task.trim() === ""}
        onClick={startWithTask}
      >
        Start
      </button>
      {workspace !== undefined && (
        <p className="empty">{`Starts in ${workspace}. The agent finds the repository itself.`}</p>
      )}
    </>
  );
}

function StartPrompt({ draft }: { draft: StartDraft }): JSX.Element {
  const { client, state } = useApp();
  const { start, setUnsent } = draft;
  const recent = useRecentFolders();
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [chosen, setChosen] = useState(NO_CHOICE);
  const [picked, setPicked] = useState<SelectableProvider | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);
  const providers = distinctProviders(state.snapshot?.accounts ?? []);
  const provider = providers.find((id) => id === picked) ?? providers[0];
  const orchestrateBlocked = provider === ProviderId.gemini;
  const orchestrating = orchestrate && !orchestrateBlocked;

  const startSession = async (
    cwd: string | undefined,
    flowRef: FlowRef | undefined,
  ): Promise<void> => {
    await client.request("session/start", {
      ...(cwd === undefined ? {} : { cwd }),
      ...(provider === undefined ? {} : { provider }),
      ...(flowRef === undefined ? {} : { flowRef }),
      ...(orchestrating ? { orchestrate: true } : {}),
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

  const chooseFolder = (cwd: string): void => {
    setUnsent(null);
    void start.run(async () => {
      const choices = orchestrating ? [] : await listChoices(cwd);
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
    setUnsent(null);
    void start.run(() => startSession(pending.cwd, choice?.flowRef));
  };

  return (
    <div className="empty-state">
      <p className="empty-title">No session</p>
      <p className="empty">Type a task to start, or choose a folder.</p>
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
      <label className="field">
        <input
          type="checkbox"
          checked={orchestrating}
          disabled={orchestrateBlocked}
          aria-describedby="orchestrate-hint"
          onChange={(event) => {
            setOrchestrate(event.target.checked);
            setPending(null);
          }}
        />
        Orchestrate
      </label>
      <p id="orchestrate-hint" className="empty">
        {orchestrateBlocked ? ORCHESTRATE_BLOCKED_HINT : ORCHESTRATE_HINT}
      </p>
      <TaskStart
        draft={draft}
        provider={provider}
        orchestrating={orchestrating}
      />
      <PathField
        value={null}
        kind="folder"
        label="Project folder"
        chooseLabel="Choose folder…"
        recent={recent}
        disabled={start.pending}
        onChange={chooseFolder}
      />
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

function SessionIdentity({
  session,
  accounts,
}: {
  session: SessionView;
  accounts: readonly AccountView[];
}): JSX.Element {
  const provider = PROVIDER_LABELS[session.activeProvider];
  const account =
    session.activeAccountId === null
      ? NO_ACCOUNT_LABEL
      : accountLabel(accounts, session.activeAccountId);
  const model = sessionModelText(session);
  return (
    <span
      className="session-identity"
      title={[provider, account, model].join(IDENTITY_SEPARATOR)}
    >
      <span className="session-provider">{provider}</span>
      {IDENTITY_SEPARATOR}
      <span className="session-account">{account}</span>
      {IDENTITY_SEPARATOR}
      <span className="session-model" aria-label="Model in use">
        {model}
      </span>
    </span>
  );
}

function SessionBody({
  draft,
  session,
  runId,
  accounts,
}: SessionBodyProps): JSX.Element {
  const { client } = useApp();
  const stop = useAsyncAction();
  const live = isSessionLive(session);
  const unsentText = unsentTextFor(draft.unsent, session.id);
  const requestStop = (): Promise<unknown> =>
    runId === null
      ? client.request("session/stop", {})
      : client.request("flow/stop", { runId });

  return (
    <>
      <div className="session-head">
        <span className="cwd">{session.cwd}</span>
        <SessionIdentity session={session} accounts={accounts} />
        <ContextMeter
          usage={session.contextUsage}
          provider={session.activeProvider}
        />
        <span className="phase">
          {phaseText(session.phase, accounts, session.turnInFlight)}
        </span>
        {session.phase.phase !== "stopped" && (
          <button
            type="button"
            className="btn"
            disabled={stop.pending}
            onClick={() => {
              void stop.run(requestStop);
            }}
          >
            {session.turnInFlight ? "Stop" : "End session"}
          </button>
        )}
      </div>
      {stop.error !== null && <p className="error">{stop.error}</p>}
      <ul className="stream">
        {streamItems(session).map((item) => (
          <StreamEntry key={item.key} item={item} runId={runId} />
        ))}
      </ul>
      {!live && <StartPrompt draft={draft} />}
      {live && draft.start.error !== null && (
        <p className="error">{draft.start.error}</p>
      )}
      <Composer key={`${session.id}:${unsentText}`} initialText={unsentText} />
    </>
  );
}

function FocusBanner({ run }: { run: FlowRunView }): JSX.Element {
  const { store } = useServices();
  return (
    <div className="focus-banner" role="status">
      <span>{`Node session of ${run.flowTitle}`}</span>
      <button
        type="button"
        className="btn"
        onClick={() => {
          store.focusRun(null);
        }}
      >
        Back to orchestrator
      </button>
    </div>
  );
}

export function SessionStream(): JSX.Element {
  const { state } = useApp();
  const [task, setTask] = useState("");
  const start = useAsyncAction();
  const [unsent, setUnsent] = useState<UnsentDraft | null>(null);
  const draft: StartDraft = { task, setTask, unsent, setUnsent, start };
  const { session, runId } = shownSessionOf(state.snapshot, state.focusedRunId);
  const focusedRun = focusedRunOf(state.snapshot, state.focusedRunId);
  const bannerRun = focusedRun?.runId === runId ? focusedRun : null;

  return (
    <section className="glass panel" aria-label="Session">
      <h2 className="sec">Session</h2>
      {bannerRun !== null && <FocusBanner run={bannerRun} />}
      {session === null ? (
        <StartPrompt draft={draft} />
      ) : (
        <SessionBody
          draft={draft}
          session={session}
          runId={runId}
          accounts={state.snapshot?.accounts ?? []}
        />
      )}
    </section>
  );
}
