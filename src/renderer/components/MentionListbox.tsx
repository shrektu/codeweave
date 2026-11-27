import type { JSX } from "react";

import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";

const OPTION_ID_SUFFIX = "-option-";

export interface ListboxOption {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

export function optionIdOf(listId: string, index: number): string {
  return `${listId}${OPTION_ID_SUFFIX}${index.toString()}`;
}

function ListboxRow({
  id,
  option,
  selected,
  onChoose,
}: {
  readonly id: string;
  readonly option: ListboxOption;
  readonly selected: boolean;
  readonly onChoose: (key: string) => void;
}): JSX.Element {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={option.label}
      aria-description={option.description}
      className="prompt-input-option"
      onMouseDown={(event) => {
        event.preventDefault();
        onChoose(option.key);
      }}
    >
      <span className="prompt-input-option-label">{option.label}</span>
      {option.description !== undefined && (
        <span className="prompt-input-option-description">
          {option.description}
        </span>
      )}
      {option.tags !== undefined && option.tags.length > 0 && (
        <span className="prompt-input-option-tags">
          {option.tags.map((tag) => (
            <span key={tag} className="prompt-input-option-tag">
              {tag}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}

export function PromptListbox({
  listId,
  listOpen,
  loading,
  items,
  activeIndex,
  label,
  emptyText,
  statusText,
  onChoose,
}: {
  readonly listId: string;
  readonly listOpen: boolean;
  readonly loading: boolean;
  readonly items: readonly ListboxOption[];
  readonly activeIndex: number;
  readonly label: string;
  readonly emptyText: string;
  readonly statusText: string | null;
  readonly onChoose: (key: string) => void;
}): JSX.Element | null {
  if (!listOpen) {
    return null;
  }
  const status = loading
    ? PROMPT_INPUT_STRINGS.mentionLoading
    : items.length === 0
      ? emptyText
      : null;
  return (
    <ul
      className="prompt-input-list"
      role="listbox"
      aria-label={label}
      id={listId}
    >
      {status !== null && <li className="prompt-input-status">{status}</li>}
      {items.map((option, index) => (
        <ListboxRow
          key={option.key}
          id={optionIdOf(listId, index)}
          option={option}
          selected={index === activeIndex}
          onChoose={onChoose}
        />
      ))}
      {statusText !== null && (
        <li className="prompt-input-status">{statusText}</li>
      )}
    </ul>
  );
}
