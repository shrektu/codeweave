import { X } from "lucide-react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  JSX,
  KeyboardEvent,
  RefObject,
  SyntheticEvent,
} from "react";

import type { AttachmentView } from "../../shared/views";

import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { Icon, ICON_SIZE_SMALL_PX } from "./Icon";
import { optionIdOf, PromptListbox } from "./MentionListbox";
import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";
import type { PromptMenu } from "./usePromptMentions";

export function PromptTextArea({
  value,
  placeholder,
  ariaLabel,
  disabled,
  menu,
  textareaRef,
  onChange,
  onSelect,
  onKeyUp,
  onKeyDown,
  onBlur,
  onPaste,
  onDragOver,
  onDrop,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly ariaLabel: string | undefined;
  readonly disabled: boolean | undefined;
  readonly menu: PromptMenu;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  readonly onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onBlur: () => void;
  readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
}): JSX.Element {
  return (
    <>
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        aria-autocomplete="list"
        aria-expanded={menu.listOpen}
        aria-controls={menu.listOpen ? menu.listId : undefined}
        aria-activedescendant={
          menu.listOpen && menu.options.length > 0
            ? optionIdOf(menu.listId, menu.activeIndex)
            : undefined
        }
        onChange={onChange}
        onSelect={onSelect}
        onKeyUp={onKeyUp}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
      <PromptListbox
        listId={menu.listId}
        listOpen={menu.listOpen}
        loading={menu.loading}
        items={menu.options}
        activeIndex={menu.activeIndex}
        label={menu.label}
        emptyText={menu.emptyText}
        statusText={menu.statusText}
        onChoose={menu.onChoose}
      />
    </>
  );
}

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  readonly attachments: readonly AttachmentView[];
  readonly onRemove: (id: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul
      className="prompt-input-attachments"
      aria-label={PROMPT_INPUT_STRINGS.attachmentListLabel}
    >
      {attachments.map((attachment) => (
        <li key={attachment.id} className="prompt-input-chip">
          <AttachmentThumbnail attachment={attachment} />
          <button
            type="button"
            className="prompt-input-remove"
            aria-label={PROMPT_INPUT_STRINGS.removeAttachment(attachment.name)}
            title={PROMPT_INPUT_STRINGS.removeAttachment(attachment.name)}
            onClick={() => {
              onRemove(attachment.id);
            }}
          >
            <Icon icon={X} size={ICON_SIZE_SMALL_PX} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PromptMessages({
  notice,
  error,
  onDismiss,
}: {
  readonly notice: string | null;
  readonly error: string | null;
  readonly onDismiss: () => void;
}): JSX.Element | null {
  if (notice === null && error === null) {
    return null;
  }
  return (
    <>
      {notice !== null && (
        <p className="prompt-input-notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <div className="prompt-input-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="prompt-input-dismiss"
            aria-label={PROMPT_INPUT_STRINGS.dismissError}
            title={PROMPT_INPUT_STRINGS.dismissError}
            onClick={onDismiss}
          >
            <Icon icon={X} size={ICON_SIZE_SMALL_PX} />
          </button>
        </div>
      )}
    </>
  );
}
