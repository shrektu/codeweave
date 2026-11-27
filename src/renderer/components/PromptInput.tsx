import { useRef, type JSX, type KeyboardEvent } from "react";

import type { AttachmentView } from "../../shared/views";
import { useApp } from "../services";
import type { SlashBuiltin } from "../slashCommands";

import {
  AttachmentChips,
  PromptMessages,
  PromptTextArea,
} from "./PromptInputParts";
import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";
import { useAttachmentStaging } from "./useAttachmentStaging";
import {
  handleSubmitKey,
  useCaretRestore,
  useMentionController,
  usePromptEditing,
} from "./usePromptMentions";
import { useSlashController } from "./useSlashMenu";

export { PROMPT_INPUT_STRINGS };

const EMPTY_BUILTINS: readonly SlashBuiltin[] = [];

export interface PromptInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (() => void) | undefined;
  readonly placeholder: string;
  readonly ariaLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly cwd: string | undefined;
  readonly attachments: readonly AttachmentView[];
  readonly onAttachmentsChange: (
    update: (current: readonly AttachmentView[]) => readonly AttachmentView[],
  ) => void;
  readonly generation: number;
  readonly onPendingChange: (pending: boolean) => void;
  readonly imageInput: boolean;
  readonly providerLabel: string;
  readonly builtins?: readonly SlashBuiltin[] | undefined;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  ariaLabel,
  disabled,
  className,
  cwd,
  attachments,
  onAttachmentsChange,
  generation,
  onPendingChange,
  imageInput,
  providerLabel,
  builtins = EMPTY_BUILTINS,
}: PromptInputProps): JSX.Element {
  const { client } = useApp();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editing = usePromptEditing(onChange);
  const mention = useMentionController({ client, cwd, value, editing });
  const slash = useSlashController({
    client,
    cwd,
    value,
    editing,
    builtins,
  });
  useCaretRestore(textareaRef, editing.cursor);
  const menu = slash.menu.listOpen ? slash.menu : mention.menu;
  const staging = useAttachmentStaging({
    client,
    attachments,
    onAttachmentsChange,
    generation,
    onPendingChange,
  });
  const notice =
    attachments.length > 0 && !imageInput
      ? PROMPT_INPUT_STRINGS.imagesUnsupported(providerLabel)
      : null;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slash.handleKey(event) || mention.handleKey(event)) {
      return;
    }
    handleSubmitKey(event, onSubmit);
  };
  const clearDismissalsOutside = (
    nextValue: string,
    nextCaret: number,
  ): void => {
    mention.clearDismissalOutside(nextValue, nextCaret);
    slash.clearDismissalOutside(nextValue, nextCaret);
  };
  return (
    <div
      className={
        className === undefined ? "prompt-input" : `prompt-input ${className}`
      }
    >
      <PromptTextArea
        value={value}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        disabled={disabled}
        menu={menu}
        textareaRef={textareaRef}
        onChange={(event) => {
          editing.onTextChange(event);
          clearDismissalsOutside(
            event.target.value,
            event.target.selectionStart,
          );
        }}
        onSelect={(event) => {
          editing.onCaretMove(event);
          clearDismissalsOutside(value, event.currentTarget.selectionStart);
        }}
        onKeyUp={(event) => {
          editing.onArrowMove(event);
          if (event.key.startsWith("Arrow")) {
            clearDismissalsOutside(value, event.currentTarget.selectionStart);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          mention.menu.onDismiss();
          slash.menu.onDismiss();
        }}
        onPaste={staging.onPaste}
        onDragOver={staging.onDragOver}
        onDrop={staging.onDrop}
      />
      <AttachmentChips attachments={attachments} onRemove={staging.onRemove} />
      <PromptMessages
        notice={notice}
        error={staging.error}
        onDismiss={staging.dismiss}
      />
    </div>
  );
}
