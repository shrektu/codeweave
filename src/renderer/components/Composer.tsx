import { ArrowUp } from "lucide-react";
import { useId, useState, type JSX, type KeyboardEvent } from "react";

import { parseTaskClass, TASK_CLASS_ORDER } from "../../domain/taskClass";
import type { ParamsMap } from "../../shared/protocol";
import type { AccountView, SessionView } from "../../shared/views";
import { shownSessionOf } from "../format";
import { modelSuggestions, TASK_CLASS_LABELS } from "../routingText";
import { useApp } from "../services";
import type { AppState } from "../store";
import { useAsyncAction } from "../useAsyncAction";

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
  text: string,
  session: SessionView | null,
  account: AccountView | null,
  classValue: string,
  model: string,
): PromptParams {
  const taskClass = parseTaskClass(classValue);
  const trimmed = model.trim();
  return {
    text,
    ...(taskClass === null ? {} : { taskClass }),
    ...(trimmed === "" || session === null
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
}

export function Composer({ initialText = "" }: ComposerProps): JSX.Element {
  const { state } = useApp();
  return (
    <SessionComposer
      initialText={initialText}
      key={
        shownSessionOf(state.snapshot, state.focusedRunId).session?.id ?? null
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
}: {
  initialText: string;
}): JSX.Element {
  const { client, state } = useApp();
  const [text, setText] = useState(initialText);
  const [classValue, setClassValue] = useState(AUTO_CLASS_VALUE);
  const [model, setModel] = useState("");
  const send = useAsyncAction();
  const { session, runId } = shownSessionOf(state.snapshot, state.focusedRunId);
  const account = runningAccount(session, state.snapshot?.accounts ?? []);
  const suggestions = modelSuggestions(account);
  const enabled =
    runId === null && canCompose(state.connection, session, send.pending);

  const submit = async (): Promise<void> => {
    if (!enabled || text.trim() === "") {
      return;
    }
    const params = promptParams(text, session, account, classValue, model);
    const sent = await send.run(() => client.request("session/prompt", params));
    if (sent) {
      setText("");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        placeholder="Describe the task"
        value={text}
        disabled={!enabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
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
        disabled={!enabled || text.trim() === ""}
        onSend={() => {
          void submit();
        }}
      />
    </div>
  );
}
