import { ArrowUp } from "lucide-react";
import { useId, useState, type JSX } from "react";

import { parseTaskClass, TASK_CLASS_ORDER } from "../../domain/taskClass";
import { ProviderId } from "../../domain/types";
import type { ParamsMap } from "../../shared/protocol";
import type {
  AccountView,
  AttachmentView,
  SessionView,
} from "../../shared/views";
import { canSendAttachments } from "../attachments";
import { PROVIDER_LABELS, shownSessionOf } from "../format";
import { modelSuggestions, TASK_CLASS_LABELS } from "../routingText";
import { useApp } from "../services";
import type { AppState } from "../store";
import { useAsyncAction } from "../useAsyncAction";

import { PromptInput } from "./PromptInput";

type PromptParams = ParamsMap["session/prompt"];

const AUTO_CLASS_VALUE = "";
const AUTO_CLASS_LABEL = "Auto";
const MODEL_PLACEHOLDER = "Model: auto";

function runningAccount(
  session: SessionView | null,
  accounts: readonly AccountView[],
): AccountView | null {
  return accounts.find((item) => item.id === session?.activeAccountId) ?? null;
}

function canCompose(
  connection: AppState["connection"],
  session: SessionView | null,
  pending: boolean,
): boolean {
  return (
    connection === "ready" &&
    session?.phase.phase === "running" &&
    !session.turnInFlight &&
    !pending
  );
}

function promptParams(
  sessionId: string,
  text: string,
  session: SessionView,
  account: AccountView | null,
  classValue: string,
  model: string,
  attachments: readonly AttachmentView[],
): PromptParams {
  const taskClass = parseTaskClass(classValue);
  const trimmed = model.trim();
  return {
    sessionId,
    text,
    ...(taskClass === null ? {} : { taskClass }),
    ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
    ...(trimmed === ""
      ? {}
      : {
          model: {
            provider: account?.provider ?? session.provider,
            model: trimmed,
          },
        }),
  };
}

function RoutingControls({
  classValue,
  model,
  suggestions,
  onClassChange,
  onModelChange,
}: {
  classValue: string;
  model: string;
  suggestions: readonly string[];
  onClassChange: (value: string) => void;
  onModelChange: (value: string) => void;
}): JSX.Element {
  const listId = useId();
  return (
    <div className="composer-routing">
      <select
        aria-label="Task class"
        value={classValue}
        onChange={(event) => {
          onClassChange(event.target.value);
        }}
      >
        <option value={AUTO_CLASS_VALUE}>{AUTO_CLASS_LABEL}</option>
        {TASK_CLASS_ORDER.map((taskClass) => (
          <option key={taskClass} value={taskClass}>
            {TASK_CLASS_LABELS[taskClass]}
          </option>
        ))}
      </select>
      <input
        type="text"
        aria-label="Model override"
        placeholder={MODEL_PLACEHOLDER}
        list={suggestions.length > 0 ? listId : undefined}
        value={model}
        onChange={(event) => {
          onModelChange(event.target.value);
        }}
      />
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </div>
  );
}

interface ComposerProps {
  readonly initialText?: string;
  readonly initialAttachments?: readonly AttachmentView[];
  readonly onSent?: () => void;
}

export function Composer({
  initialText = "",
  initialAttachments = [],
  onSent = () => undefined,
}: ComposerProps): JSX.Element {
  const { state } = useApp();
  return (
    <SessionComposer
      initialText={initialText}
      initialAttachments={initialAttachments}
      onSent={onSent}
      key={
        shownSessionOf(
          state.snapshot,
          state.activeSessionId,
          state.focusedRunId,
        ).session?.id ?? null
      }
    />
  );
}

function SendButton({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="send"
      aria-label="Send"
      title="Send"
      disabled={disabled}
      onClick={onSend}
    >
      <ArrowUp size={16} aria-hidden="true" />
    </button>
  );
}

function SessionComposer({
  initialText,
  initialAttachments,
  onSent,
}: {
  initialText: string;
  initialAttachments: readonly AttachmentView[];
  onSent: () => void;
}): JSX.Element {
  const { client, state } = useApp();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] =
    useState<readonly AttachmentView[]>(initialAttachments);
  const [generation, setGeneration] = useState(0);
  const [staging, setStaging] = useState(false);
  const [classValue, setClassValue] = useState(AUTO_CLASS_VALUE);
  const [model, setModel] = useState("");
  const send = useAsyncAction();
  const { session, runId } = shownSessionOf(
    state.snapshot,
    state.activeSessionId,
    state.focusedRunId,
  );
  const account = runningAccount(session, state.snapshot?.accounts ?? []);
  const suggestions = modelSuggestions(account);
  const imageInput = session?.imageInput ?? true;
  const providerLabel =
    session === null
      ? PROVIDER_LABELS[ProviderId.claude]
      : PROVIDER_LABELS[session.activeProvider];
  const attachmentsAllowed = canSendAttachments(attachments, imageInput);
  const enabled =
    runId === null && canCompose(state.connection, session, send.pending);

  const submit = async (): Promise<void> => {
    if (
      !enabled ||
      !attachmentsAllowed ||
      staging ||
      session === null ||
      text.trim() === ""
    ) {
      return;
    }
    const params = promptParams(
      session.id,
      text,
      session,
      account,
      classValue,
      model,
      attachments,
    );
    const sent = await send.run(() => client.request("session/prompt", params));
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
        disabled={!enabled}
        cwd={session?.cwd}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        generation={generation}
        onPendingChange={setStaging}
        imageInput={imageInput}
        providerLabel={providerLabel}
      />
      <RoutingControls
        classValue={classValue}
        model={model}
        suggestions={suggestions}
        onClassChange={setClassValue}
        onModelChange={setModel}
      />
      {send.error !== null && <p className="error">{send.error}</p>}
      <SendButton
        disabled={
          !enabled || !attachmentsAllowed || staging || text.trim() === ""
        }
        onSend={() => {
          void submit();
        }}
      />
    </div>
  );
}
