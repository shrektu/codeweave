import { ArrowUp } from "lucide-react";
import { useId, useRef, useState, type JSX, type RefObject } from "react";

import { parseTaskClass, TASK_CLASS_ORDER } from "../../domain/taskClass";
import { ProviderId } from "../../domain/types";
import type { ParamsMap } from "../../shared/protocol";
import type {
  AccountView,
  AttachmentView,
  SessionView,
} from "../../shared/views";
import { canSendAttachments } from "../attachments";
import { errorMessage } from "../errorMessage";
import {
  compactPath,
  folderLabel,
  formatLocalTime,
  isSessionLive,
  MS_PER_SECOND,
  PROVIDER_LABELS,
  shownSessionOf,
} from "../format";
import { modelSuggestions, TASK_CLASS_LABELS } from "../routingText";
import { useApp } from "../services";
import {
  matchSlashItems,
  parseSlashInput,
  resolvePromptText,
  type SlashArgumentOption,
  type SlashBuiltin,
} from "../slashCommands";
import type { AppState, AppStore } from "../store";
import { useAsyncAction } from "../useAsyncAction";

import { PromptInput } from "./PromptInput";
import { SLASH_COMMAND_STRINGS } from "./slashCommandStrings";

type PromptParams = ParamsMap["session/prompt"];

const AUTO_CLASS_VALUE = "";
const AUTO_CLASS_LABEL = "Auto";
const MODEL_PLACEHOLDER = "Model: auto";
const RESUME_OPTION_LIMIT = 20;
const NO_RESUME_TITLE = "";

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

function modelOptionsOf(
  suggestions: readonly string[],
  query: string,
  onChoose: (model: string) => void,
): readonly SlashArgumentOption[] {
  const named = suggestions.map((model) => ({ name: model }));
  return matchSlashItems(query, named).map(({ name }) => ({
    key: `model:${name}`,
    label: name,
    run: () => {
      onChoose(name);
    },
  }));
}

function resumeOptionsOf(
  state: AppState,
  store: AppStore,
  query: string,
): readonly SlashArgumentOption[] {
  const liveIds = new Set(
    (state.snapshot?.sessions ?? [])
      .filter(isSessionLive)
      .map((session) => session.id),
  );
  const available = state.history
    .filter(
      (entry) =>
        !entry.archived &&
        entry.id !== state.activeSessionId &&
        !liveIds.has(entry.id),
    )
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, RESUME_OPTION_LIMIT)
    .map((entry) => ({
      name: `${entry.title} ${folderLabel(entry.cwd)}`,
      entry,
    }));
  return matchSlashItems(query, available).map(({ entry }) => ({
    key: `resume:${entry.id}`,
    label:
      entry.title === NO_RESUME_TITLE ? folderLabel(entry.cwd) : entry.title,
    description: SLASH_COMMAND_STRINGS.resumeOptionDescription(
      compactPath(entry.cwd),
      formatLocalTime(entry.updatedAt / MS_PER_SECOND),
    ),
    run: () => {
      store.activateSession(entry.id);
    },
  }));
}

function RoutingControls({
  classValue,
  model,
  suggestions,
  inputRef,
  onClassChange,
  onModelChange,
}: {
  classValue: string;
  model: string;
  suggestions: readonly string[];
  inputRef: RefObject<HTMLInputElement | null>;
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
        ref={inputRef}
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
  readonly onRewindLatest?: (() => void) | undefined;
}

export function Composer({
  initialText = "",
  initialAttachments = [],
  onSent = () => undefined,
  onRewindLatest,
}: ComposerProps): JSX.Element {
  const { state } = useApp();
  return (
    <SessionComposer
      initialText={initialText}
      initialAttachments={initialAttachments}
      onSent={onSent}
      onRewindLatest={onRewindLatest}
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

const EMPTY_BUILTINS: readonly SlashBuiltin[] = [];

function SessionComposer({
  initialText,
  initialAttachments,
  onSent,
  onRewindLatest,
}: {
  initialText: string;
  initialAttachments: readonly AttachmentView[];
  onSent: () => void;
  onRewindLatest: (() => void) | undefined;
}): JSX.Element {
  const { client, state, store } = useApp();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] =
    useState<readonly AttachmentView[]>(initialAttachments);
  const [generation, setGeneration] = useState(0);
  const [staging, setStaging] = useState(false);
  const [classValue, setClassValue] = useState(AUTO_CLASS_VALUE);
  const [model, setModel] = useState("");
  const modelInputRef = useRef<HTMLInputElement | null>(null);
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

  const resetPrompt = (): void => {
    setText("");
    setAttachments([]);
    setGeneration((current) => current + 1);
  };

  const runClear = async (target: SessionView): Promise<boolean> =>
    send.run(async () => {
      try {
        const started = await client.request("session/start", {
          ...(target.explicitFolder ? { cwd: target.cwd } : {}),
          provider: target.provider,
          profile: target.profile,
          ...(target.orchestrate ? { orchestrate: true } : {}),
          ...(model.trim() === ""
            ? {}
            : {
                model: {
                  provider: account?.provider ?? target.provider,
                  model: model.trim(),
                },
              }),
        });
        store.activateSession(started.id);
      } catch (caught: unknown) {
        throw new Error(
          SLASH_COMMAND_STRINGS.clearFailed(errorMessage(caught)),
          {
            cause: caught,
          },
        );
      }
    });

  const runCompact = async (target: SessionView): Promise<boolean> =>
    send.run(async () => {
      try {
        await client.request("session/compact", { sessionId: target.id });
      } catch (caught: unknown) {
        throw new Error(
          SLASH_COMMAND_STRINGS.compactFailed(errorMessage(caught)),
          { cause: caught },
        );
      }
    });

  const builtins: readonly SlashBuiltin[] =
    session === null
      ? EMPTY_BUILTINS
      : [
          ...(isSessionLive(session) && session.flowRef === null
            ? [
                {
                  name: "clear",
                  description: SLASH_COMMAND_STRINGS.builtinDescription.clear,
                  run: () => runClear(session),
                } satisfies SlashBuiltin,
              ]
            : []),
          ...(session.canCompact && enabled
            ? [
                {
                  name: "compact",
                  description: SLASH_COMMAND_STRINGS.builtinDescription.compact,
                  run: () => runCompact(session),
                } satisfies SlashBuiltin,
              ]
            : []),
          {
            name: "model",
            description: SLASH_COMMAND_STRINGS.builtinDescription.model,
            run: (args: string) => {
              const trimmed = args.trim();
              if (trimmed === "") {
                modelInputRef.current?.focus();
              } else {
                setModel(trimmed);
              }
              return true;
            },
            argument: {
              options: (query) => modelOptionsOf(suggestions, query, setModel),
            },
          },
          {
            name: "resume",
            description: SLASH_COMMAND_STRINGS.builtinDescription.resume,
            run: () => false,
            argument: {
              options: (query) => resumeOptionsOf(state, store, query),
            },
          },
          ...(onRewindLatest !== undefined && session.prompts.length > 0
            ? [
                {
                  name: "rewind",
                  description: SLASH_COMMAND_STRINGS.builtinDescription.rewind,
                  run: () => {
                    onRewindLatest();
                    return true;
                  },
                } satisfies SlashBuiltin,
              ]
            : []),
        ];

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
    const parsed = parseSlashInput(text);
    const builtin =
      parsed === null
        ? undefined
        : builtins.find((candidate) => candidate.name === parsed.name);
    if (builtin !== undefined && parsed !== null) {
      const succeeded = await builtin.run(parsed.args);
      if (succeeded) {
        setText("");
      }
      return;
    }
    const resolvedParams = async (): Promise<PromptParams> => {
      const resolved = await resolvePromptText(client, session.cwd, text);
      return promptParams(
        session.id,
        resolved,
        session,
        account,
        classValue,
        model,
        attachments,
      );
    };
    const sent = await send.run(async () => {
      await client.request("session/prompt", await resolvedParams());
    });
    if (sent) {
      resetPrompt();
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
        builtins={builtins}
      />
      <RoutingControls
        classValue={classValue}
        model={model}
        suggestions={suggestions}
        inputRef={modelInputRef}
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
