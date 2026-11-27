import { ArrowUp, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";

import { PROVIDER_IMAGE_INPUT } from "../../domain/attachments";
import { RewindMode } from "../../domain/checkpoints";
import { ProviderId } from "../../domain/types";
import type {
  AccountView,
  AttachmentView,
  FlowRef,
  FlowRunView,
  FlowsList,
  MessageView,
  PermissionView,
  PromptView,
  RotationPhaseView,
  RewindResultView,
  SessionView,
  ToolCallView,
  TurnRouteView,
} from "../../shared/views";
import { canSendAttachments } from "../attachments";
import {
  accountLabel,
  focusedRunOf,
  formatLocalTime,
  historyOnlyIdOf,
  isSelectable,
  isSessionLive,
  PROVIDER_LABELS,
  providerOf,
  resumeFailureVisible,
  shownSessionOf,
  storedSessionView,
  type ResumeFailure,
  type SelectableProvider,
} from "../format";
import { errorMessage } from "../errorMessage";
import { sessionModelText, turnBadge } from "../routingText";
import { useApp, useServices } from "../services";
import { resolvePromptText } from "../slashCommands";
import type { AppState } from "../store";
import { useAsyncAction, type AsyncAction } from "../useAsyncAction";
import { useRecentFolders } from "../useRecentFolders";

import { Markdown } from "../markdown/Markdown";

import { Composer } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { Icon, ICON_SIZE_SMALL_PX } from "./Icon";
import { PathField } from "./PathField";
import { PermissionCard } from "./PermissionCard";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { PromptInput } from "./PromptInput";
import {
  REWIND_STRINGS,
  RewindDialog,
  rewindReportSummary,
} from "./RewindDialog";
import { ToolCard } from "./ToolCard";
import { UsageSummary } from "./UsageSummary";

const IDENTITY_SEPARATOR = " · ";
const NO_ACCOUNT_LABEL = "—";

interface UnsentDraft {
  readonly id: number;
  readonly sessionId: string | null;
  readonly text: string;
  readonly attachments: readonly AttachmentView[];
}

function unsentBelongsTo(
  unsent: UnsentDraft | null,
  sessionId: string,
): boolean {
  return (
    unsent !== null &&
    (unsent.sessionId === null || unsent.sessionId === sessionId)
  );
}

function unsentTextFor(unsent: UnsentDraft | null, sessionId: string): string {
  return unsentBelongsTo(unsent, sessionId) && unsent !== null
    ? unsent.text
    : "";
}

function unsentAttachmentsFor(
  unsent: UnsentDraft | null,
  sessionId: string,
): readonly AttachmentView[] {
  return unsentBelongsTo(unsent, sessionId) && unsent !== null
    ? unsent.attachments
    : [];
}

interface StartDraft {
  readonly task: string;
  readonly setTask: (task: string) => void;
  readonly unsent: UnsentDraft | null;
  readonly setUnsent: (unsent: UnsentDraft | null) => void;
  readonly saveUnsent: (
    sessionId: string | null,
    text: string,
    attachments: readonly AttachmentView[],
  ) => void;
  readonly clearUnsent: () => void;
  readonly start: AsyncAction;
}

interface SessionBodyProps {
  draft: StartDraft;
  session: SessionView;
  runId: string | null;
  accounts: readonly AccountView[];
  historyOnly: boolean;
  promptError: string | null;
  reportSummary: string | null;
  onResumeFailure: (
    text: string,
    message: string,
    attachments: readonly AttachmentView[],
  ) => void;
  onRewind: (prompt: PromptView) => void;
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
  | { readonly kind: "prompt"; readonly prompt: PromptView }
  | { readonly kind: "message"; readonly message: MessageView }
  | { readonly kind: "tool"; readonly tool: ToolCallView }
  | { readonly kind: "permission"; readonly permission: PermissionView }
  | { readonly kind: "turn"; readonly turn: TurnRouteView }
);

function streamItems(session: SessionView): StreamItem[] {
  const items: StreamItem[] = [
    ...session.prompts.map((prompt): StreamItem => ({
      kind: "prompt",
      key: `prompt-${prompt.seq.toString()}`,
      seq: prompt.seq,
      prompt,
    })),
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
  sessionId,
  runId,
  onRewind,
}: {
  item: StreamItem;
  sessionId: string;
  runId: string | null;
  onRewind: ((prompt: PromptView) => void) | undefined;
}): JSX.Element {
  switch (item.kind) {
    case "turn":
      return <TurnBadgeEntry turn={item.turn} />;
    case "prompt":
      return (
        <li className="card msg prompt" aria-label="You">
          <Markdown text={item.prompt.text} />
          {item.prompt.attachments.length > 0 && (
            <ul className="prompt-attachments">
              {item.prompt.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <AttachmentThumbnail
                    attachment={attachment}
                    sessionId={sessionId}
                  />
                </li>
              ))}
            </ul>
          )}
          {onRewind !== undefined && (
            <button
              type="button"
              className="prompt-rewind"
              aria-label={REWIND_STRINGS.rewindButton}
              title={REWIND_STRINGS.rewindButton}
              onClick={() => {
                onRewind(item.prompt);
              }}
            >
              <Icon icon={RotateCcw} size={ICON_SIZE_SMALL_PX} />
            </button>
          )}
        </li>
      );
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
          <PermissionCard
            permission={item.permission}
            sessionId={sessionId}
            runId={runId}
          />
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

function defaultProviderOf(
  accounts: readonly AccountView[],
): SelectableProvider | undefined {
  const ordered = accounts.toSorted(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
  const first = ordered.at(0);
  return first !== undefined && isSelectable(first.provider)
    ? first.provider
    : undefined;
}

interface TaskStartProps {
  readonly draft: StartDraft;
  readonly provider: SelectableProvider | undefined;
  readonly orchestrating: boolean;
  readonly providerLabel: string;
  readonly imageInput: boolean;
}

function TaskStart({
  draft,
  provider,
  orchestrating,
  providerLabel,
  imageInput,
}: TaskStartProps): JSX.Element {
  const { client, store, state } = useApp();
  const { task, setTask, setUnsent, saveUnsent, start } = draft;
  const [attachments, setAttachments] = useState<readonly AttachmentView[]>([]);
  const [generation, setGeneration] = useState(0);
  const [staging, setStaging] = useState(false);
  const workspace = state.snapshot?.settings.defaultWorkspaceResolved;
  const attachmentsAllowed = canSendAttachments(attachments, imageInput);
  const startBlocked = start.pending || staging;

  const startWithTask = (): void => {
    if (staging) {
      return;
    }
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
        store.activateSession(started.id);
        const promptText = await resolvePromptText(client, workspace, text);
        await client.request("session/prompt", {
          sessionId: started.id,
          text: promptText,
          ...(attachments.length === 0
            ? {}
            : { attachments: [...attachments] }),
        });
      } catch (error: unknown) {
        saveUnsent(sessionId, text, attachments);
        throw error;
      }
      setTask("");
      setAttachments([]);
      setGeneration((current) => current + 1);
    });
  };

  return (
    <>
      <PromptInput
        ariaLabel="Task"
        placeholder="What should the agent do?"
        value={task}
        onChange={setTask}
        disabled={start.pending}
        cwd={workspace}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        generation={generation}
        onPendingChange={setStaging}
        imageInput={imageInput}
        providerLabel={providerLabel}
      />
      <button
        type="button"
        className="btn pri"
        disabled={startBlocked || task.trim() === "" || !attachmentsAllowed}
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
  const { client, store, state } = useApp();
  const { start, setUnsent } = draft;
  const recent = useRecentFolders();
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [chosen, setChosen] = useState(NO_CHOICE);
  const [picked, setPicked] = useState<SelectableProvider | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);
  const providers = distinctProviders(state.snapshot?.accounts ?? []);
  const provider = providers.find((id) => id === picked) ?? providers[0];
  const startProvider =
    provider ?? defaultProviderOf(state.snapshot?.accounts ?? []);
  const imageInput =
    startProvider === undefined ? true : PROVIDER_IMAGE_INPUT[startProvider];
  const providerLabel =
    startProvider === undefined
      ? PROVIDER_LABELS[ProviderId.claude]
      : PROVIDER_LABELS[startProvider];
  const orchestrateBlocked = provider === ProviderId.gemini;
  const orchestrating = orchestrate && !orchestrateBlocked;

  const startSession = async (
    cwd: string | undefined,
    flowRef: FlowRef | undefined,
  ): Promise<void> => {
    const started = await client.request("session/start", {
      ...(cwd === undefined ? {} : { cwd }),
      ...(provider === undefined ? {} : { provider }),
      ...(flowRef === undefined ? {} : { flowRef }),
      ...(orchestrating ? { orchestrate: true } : {}),
    });
    store.activateSession(started.id);
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
        providerLabel={providerLabel}
        imageInput={imageInput}
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

function ResumeComposer({
  sessionId,
  cwd,
  provider,
  initialText,
  initialAttachments,
  onSent,
  onFailure,
}: {
  sessionId: string;
  cwd: string;
  provider: ProviderId;
  initialText: string;
  initialAttachments: readonly AttachmentView[];
  onSent: () => void;
  onFailure: (
    text: string,
    message: string,
    attachments: readonly AttachmentView[],
  ) => void;
}): JSX.Element {
  const { client } = useApp();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] =
    useState<readonly AttachmentView[]>(initialAttachments);
  const [generation, setGeneration] = useState(0);
  const [staging, setStaging] = useState(false);
  const send = useAsyncAction();
  const imageInput = PROVIDER_IMAGE_INPUT[provider];
  const attachmentsAllowed = canSendAttachments(attachments, imageInput);
  const ready =
    !send.pending && !staging && text.trim() !== "" && attachmentsAllowed;

  const submit = async (): Promise<void> => {
    if (!ready) {
      return;
    }
    const sent = await send.run(async () => {
      await client.request("session/resume", { sessionId });
      try {
        const promptText = await resolvePromptText(client, cwd, text);
        await client.request("session/prompt", {
          sessionId,
          text: promptText,
          ...(attachments.length === 0
            ? {}
            : { attachments: [...attachments] }),
        });
      } catch (error: unknown) {
        onFailure(text, errorMessage(error), attachments);
        throw error;
      }
    });
    if (sent) {
      setText("");
      setAttachments([]);
      setGeneration((current) => current + 1);
      onSent();
    }
  };

  return (
    <div className="composer">
      <PromptInput
        value={text}
        onChange={setText}
        onSubmit={() => {
          void submit();
        }}
        placeholder="Describe the task"
        disabled={send.pending}
        cwd={cwd}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        generation={generation}
        onPendingChange={setStaging}
        imageInput={imageInput}
        providerLabel={PROVIDER_LABELS[provider]}
      />
      {send.error !== null && <p className="error">{send.error}</p>}
      <button
        type="button"
        className="send"
        aria-label="Send"
        title="Send"
        disabled={!ready}
        onClick={() => {
          void submit();
        }}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function SessionBody({
  draft,
  session,
  runId,
  accounts,
  historyOnly,
  promptError,
  reportSummary,
  onResumeFailure,
  onRewind,
}: SessionBodyProps): JSX.Element {
  const { client } = useApp();
  const stop = useAsyncAction();
  const live = isSessionLive(session);
  const unsentText = unsentTextFor(draft.unsent, session.id);
  const unsentAttachments = unsentAttachmentsFor(draft.unsent, session.id);
  const unsentId =
    draft.unsent !== null &&
    (draft.unsent.sessionId === null || draft.unsent.sessionId === session.id)
      ? draft.unsent.id
      : 0;
  const rewindable = runId === null && !session.turnInFlight;
  const latestPrompt = session.prompts.at(-1);
  const rewindLatest =
    rewindable && latestPrompt !== undefined
      ? (): void => {
          onRewind(latestPrompt);
        }
      : undefined;
  const requestStop = (): Promise<unknown> =>
    runId === null
      ? client.request("session/stop", { sessionId: session.id })
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
        <UsageSummary usage={session.usage} provider={session.activeProvider} />
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
          <StreamEntry
            key={item.key}
            item={item}
            sessionId={session.id}
            runId={runId}
            onRewind={rewindable ? onRewind : undefined}
          />
        ))}
      </ul>
      {reportSummary !== null && <p role="status">{reportSummary}</p>}
      {!live && !historyOnly && <StartPrompt draft={draft} />}
      {live && draft.start.error !== null && (
        <p className="error">{draft.start.error}</p>
      )}
      {promptError !== null && <p className="error">{promptError}</p>}
      {historyOnly ? (
        <ResumeComposer
          key={`${session.id}:${String(unsentId)}`}
          sessionId={session.id}
          cwd={session.cwd}
          provider={session.activeProvider}
          initialText={unsentText}
          initialAttachments={unsentAttachments}
          onSent={draft.clearUnsent}
          onFailure={onResumeFailure}
        />
      ) : (
        <Composer
          key={`${session.id}:${String(unsentId)}`}
          initialText={unsentText}
          initialAttachments={unsentAttachments}
          onSent={draft.clearUnsent}
          onRewindLatest={rewindLatest}
        />
      )}
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

function failureStillLive(failure: ResumeFailure, state: AppState): boolean {
  const live =
    state.snapshot?.sessions.some((item) => item.id === failure.sessionId) ??
    false;
  return live && state.activeSessionId === failure.sessionId;
}

interface RewindTarget {
  readonly sessionId: string;
  readonly prompt: PromptView;
}

interface RewindNotice {
  readonly sessionId: string;
  readonly text: string;
}

export function SessionStream(): JSX.Element {
  const { state, store } = useApp();
  const [task, setTask] = useState("");
  const start = useAsyncAction();
  const [unsent, setUnsent] = useState<UnsentDraft | null>(null);
  const [rewinding, setRewinding] = useState<RewindTarget | null>(null);
  const [rewindNotice, setRewindNotice] = useState<RewindNotice | null>(null);
  const draftSeq = useRef(0);
  const saveUnsent = (
    sessionId: string | null,
    text: string,
    attachments: readonly AttachmentView[],
  ): void => {
    draftSeq.current += 1;
    setUnsent({ id: draftSeq.current, sessionId, text, attachments });
  };
  const clearUnsent = (): void => {
    setUnsent(null);
    setRewindNotice(null);
  };
  const [resumeFailure, setResumeFailure] = useState<ResumeFailure | null>(
    null,
  );
  const shown = shownSessionOf(
    state.snapshot,
    state.activeSessionId,
    state.focusedRunId,
  );
  const historyOnlyId = historyOnlyIdOf(
    state.snapshot,
    state.activeSessionId,
    state.history,
  );
  const stored =
    historyOnlyId === null
      ? undefined
      : state.historyTranscripts[historyOnlyId];
  useEffect(() => {
    if (historyOnlyId !== null && stored === undefined) {
      void store.loadTranscript(historyOnlyId);
    }
  }, [historyOnlyId, stored, store]);
  useEffect(
    () =>
      store.subscribe(() => {
        const current = store.getState();
        setRewindNotice((notice) =>
          notice !== null && notice.sessionId !== current.activeSessionId
            ? null
            : notice,
        );
        setRewinding((target) =>
          target !== null && target.sessionId !== current.activeSessionId
            ? null
            : target,
        );
        setResumeFailure((failure) => {
          if (failure === null) {
            return failure;
          }
          return failureStillLive(failure, current) ? failure : null;
        });
      }),
    [store],
  );
  const historyOnly = shown.session === null && historyOnlyId !== null;
  const session =
    shown.session ?? (stored === undefined ? null : storedSessionView(stored));
  const failureActive = resumeFailureVisible(
    resumeFailure,
    shown.session,
    state.activeSessionId,
  );
  const staleResumeUnsent =
    resumeFailure !== null &&
    !failureActive &&
    unsent?.sessionId === resumeFailure.sessionId;
  const draft: StartDraft = {
    task,
    setTask,
    unsent: staleResumeUnsent ? null : unsent,
    setUnsent,
    saveUnsent,
    clearUnsent,
    start,
  };
  const focusedRun = focusedRunOf(
    state.snapshot,
    state.activeSessionId,
    state.focusedRunId,
  );
  const bannerRun = focusedRun?.runId === shown.runId ? focusedRun : null;
  const reportSummary =
    rewindNotice !== null &&
    session !== null &&
    rewindNotice.sessionId === session.id
      ? rewindNotice.text
      : null;
  const handleRewound = (result: RewindResultView, mode: RewindMode): void => {
    const sessionId = rewinding?.sessionId;
    if (sessionId === undefined) {
      return;
    }
    setRewindNotice(
      result.report === null
        ? null
        : {
            sessionId,
            text: rewindReportSummary(result.report),
          },
    );
    if (mode !== RewindMode.files) {
      saveUnsent(sessionId, result.promptText, []);
    }
  };

  return (
    <section className="glass panel" aria-label="Session">
      <h2 className="sec">Session</h2>
      {bannerRun !== null && <FocusBanner run={bannerRun} />}
      {session === null ? (
        historyOnly ? (
          <p className="empty">Loading session…</p>
        ) : (
          <StartPrompt draft={draft} />
        )
      ) : (
        <SessionBody
          draft={draft}
          session={session}
          runId={shown.runId}
          accounts={state.snapshot?.accounts ?? []}
          historyOnly={historyOnly}
          promptError={
            failureActive && resumeFailure !== null
              ? resumeFailure.message
              : null
          }
          reportSummary={reportSummary}
          onRewind={(prompt) => {
            setRewinding({ sessionId: session.id, prompt });
          }}
          onResumeFailure={(text, message, attachments) => {
            saveUnsent(session.id, text, attachments);
            setResumeFailure({
              sessionId: session.id,
              message,
              promptCount: session.prompts.length,
            });
          }}
        />
      )}
      {rewinding !== null && (
        <RewindDialog
          sessionId={rewinding.sessionId}
          prompt={rewinding.prompt}
          onClose={() => {
            setRewinding(null);
          }}
          onRewound={handleRewound}
        />
      )}
    </section>
  );
}
