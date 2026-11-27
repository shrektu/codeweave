import type { JSX } from "react";

import type { FileCompletionItem } from "../../shared/views";

import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";

const OPTION_ID_SUFFIX = "-option-";

export function optionIdOf(listId: string, index: number): string {
  return `${listId}${OPTION_ID_SUFFIX}${index.toString()}`;
}

function MentionOption({
  id,
  item,
  selected,
  onChoose,
}: {
  readonly id: string;
  readonly item: FileCompletionItem;
  readonly selected: boolean;
  readonly onChoose: (item: FileCompletionItem) => void;
}): JSX.Element {
  const label = item.kind === "dir" ? `${item.path}/` : item.path;
  const description =
    item.kind === "dir" ? PROMPT_INPUT_STRINGS.folderSuffixHint : undefined;
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-description={description}
      className="prompt-input-option"
      onMouseDown={(event) => {
        event.preventDefault();
        onChoose(item);
      }}
    >
      {label}
    </li>
  );
}

export function MentionListbox({
  listId,
  listOpen,
  loading,
  items,
  activeIndex,
  onChoose,
}: {
  readonly listId: string;
  readonly listOpen: boolean;
  readonly loading: boolean;
  readonly items: readonly FileCompletionItem[];
  readonly activeIndex: number;
  readonly onChoose: (item: FileCompletionItem) => void;
}): JSX.Element | null {
  if (!listOpen) {
    return null;
  }
  const status = loading
    ? PROMPT_INPUT_STRINGS.mentionLoading
    : items.length === 0
      ? PROMPT_INPUT_STRINGS.mentionEmpty
      : null;
  return (
    <ul
      className="prompt-input-list"
      role="listbox"
      aria-label={PROMPT_INPUT_STRINGS.mentionListLabel}
      id={listId}
    >
      {status !== null && <li className="prompt-input-status">{status}</li>}
      {items.map((item, index) => (
        <MentionOption
          key={`${item.kind}:${item.path}`}
          id={optionIdOf(listId, index)}
          item={item}
          selected={index === activeIndex}
          onChoose={onChoose}
        />
      ))}
    </ul>
  );
}
