import { useRef, type JSX } from "react";

import type { AttachmentView } from "../../shared/views";
import { useApp } from "../services";

import {
  AttachmentChips,
  PromptMessages,
  PromptTextArea,
} from "./PromptInputParts";
import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";
import { useAttachmentStaging } from "./useAttachmentStaging";
import { useMentionController } from "./usePromptMentions";

export { PROMPT_INPUT_STRINGS };

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
}: PromptInputProps): JSX.Element {
  const { client } = useApp();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mention = useMentionController({
    client,
    cwd,
    value,
    onChange,
    onSubmit,
    textareaRef,
  });
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
        mention={mention}
        textareaRef={textareaRef}
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
