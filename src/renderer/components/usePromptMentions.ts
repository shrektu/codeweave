import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";

import type { FileCompletionItem } from "../../shared/views";
import type { IpcClient } from "../ipc";
import { activeMention, applyMention } from "../mentions";

import type { ListboxOption } from "./MentionListbox";
import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";

interface CompletionResult {
  readonly key: string;
  readonly items: readonly FileCompletionItem[];
}

interface CompletionView {
  readonly items: readonly FileCompletionItem[];
  readonly loading: boolean;
  readonly blocked: boolean;
}

interface Selection {
  readonly key: string;
  readonly index: number;
}

export interface CursorRequest {
  readonly position: number;
  readonly revision: number;
}

export interface ListKeys {
  readonly listOpen: boolean;
  readonly activeKey: string | null;
  readonly onMove: (delta: number) => void;
  readonly onChoose: (key: string) => void;
  readonly onDismiss: () => void;
}

export interface PromptMenu {
  readonly listId: string;
  readonly listOpen: boolean;
  readonly loading: boolean;
  readonly label: string;
  readonly emptyText: string;
  readonly statusText: string | null;
  readonly options: readonly ListboxOption[];
  readonly activeIndex: number;
  readonly onChoose: (key: string) => void;
  readonly onDismiss: () => void;
  readonly onMove: (delta: number) => void;
}

export interface PromptEditing {
  readonly caret: number | null;
  readonly cursor: CursorRequest;
  readonly onTextChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onCaretMove: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  readonly onArrowMove: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly applyText: (text: string, caret: number) => void;
}

export interface MentionController {
  readonly menu: PromptMenu;
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly clearDismissalOutside: (value: string, caret: number) => void;
}

const MENTION_DEBOUNCE_MS = 120;

interface CompletionQuery {
  readonly key: string;
  readonly query: string;
}

const EMPTY_ITEMS: readonly FileCompletionItem[] = [];
const EMPTY_COMPLETION: CompletionView = {
  items: EMPTY_ITEMS,
  loading: false,
  blocked: false,
};

function optionKeyOf(item: FileCompletionItem): string {
  return `${item.kind}:${item.path}`;
}

function completionQueryOf(
  mention: ReturnType<typeof activeMention>,
): CompletionQuery | null {
  if (mention === null) {
    return null;
  }
  return {
    key: `${mention.start.toString()}:${mention.query}`,
    query: mention.query,
  };
}

interface CompletionRequest {
  readonly client: IpcClient;
  readonly params:
    | { readonly query: string }
    | { readonly cwd: string; readonly query: string };
  readonly key: string;
  readonly sequence: number;
  readonly sequenceRef: RefObject<number>;
  readonly onItems: (items: readonly FileCompletionItem[]) => void;
  readonly onFailed: (key: string) => void;
}

function requestCompletion(request: CompletionRequest): void {
  request.client
    .request("files/complete", request.params)
    .then((result) => {
      if (request.sequenceRef.current === request.sequence) {
        request.onItems(result.items);
      }
    })
    .catch((caught: unknown) => {
      if (request.sequenceRef.current !== request.sequence) {
        return;
      }
      console.warn("file completion failed", caught);
      request.onFailed(request.key);
    });
}

function useMentionCompletion(
  client: IpcClient,
  cwd: string | undefined,
  query: CompletionQuery | null,
): CompletionView {
  const [completion, setCompletion] = useState<CompletionResult | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  const key = query?.key ?? null;
  const text = query?.query ?? null;

  useEffect(() => {
    sequenceRef.current += 1;
    if (key === null || text === null) {
      return;
    }
    const sequence = sequenceRef.current;
    const params = cwd === undefined ? { query: text } : { cwd, query: text };
    const timer = window.setTimeout(() => {
      requestCompletion({
        client,
        params,
        key,
        sequence,
        sequenceRef,
        onItems: (items) => {
          setCompletion({ key, items });
        },
        onFailed: setFailedKey,
      });
    }, MENTION_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [client, cwd, key, text]);

  if (key === null) {
    return EMPTY_COMPLETION;
  }
  return {
    items: completion?.key === key ? completion.items : EMPTY_ITEMS,
    loading: failedKey !== key && completion?.key !== key,
    blocked: failedKey === key,
  };
}

export function useCaretRestore(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  cursor: CursorRequest,
): void {
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null || cursor.revision === 0) {
      return;
    }
    node.focus();
    node.setSelectionRange(cursor.position, cursor.position);
  }, [textareaRef, cursor]);
}

export function handleListKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  keys: ListKeys,
): boolean {
  if (event.nativeEvent.isComposing || !keys.listOpen) {
    return false;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    keys.onMove(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    keys.onMove(-1);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    if (keys.activeKey === null) {
      return false;
    }
    event.preventDefault();
    keys.onChoose(keys.activeKey);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    keys.onDismiss();
    return true;
  }
  return false;
}

export function handleSubmitKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onSubmit: (() => void) | undefined,
): void {
  if (
    event.nativeEvent.isComposing ||
    onSubmit === undefined ||
    event.key !== "Enter" ||
    event.shiftKey
  ) {
    return;
  }
  event.preventDefault();
  onSubmit();
}

export function usePromptEditing(
  onChange: (value: string) => void,
): PromptEditing {
  const [caret, setCaret] = useState<number | null>(null);
  const [cursor, setCursor] = useState<CursorRequest>({
    position: 0,
    revision: 0,
  });

  return {
    caret,
    cursor,
    applyText: (text, position) => {
      onChange(text);
      setCaret(position);
      setCursor((current) => ({
        position,
        revision: current.revision + 1,
      }));
    },
    onTextChange: (event) => {
      onChange(event.target.value);
      setCaret(event.target.selectionStart);
    },
    onCaretMove: (event) => {
      setCaret(event.currentTarget.selectionStart);
    },
    onArrowMove: (event) => {
      if (event.key.startsWith("Arrow")) {
        setCaret(event.currentTarget.selectionStart);
      }
    },
  };
}

export function useSuggestionSelection(
  key: string | null,
  count: number,
): { readonly activeIndex: number; readonly move: (delta: number) => void } {
  const [selection, setSelection] = useState<Selection | null>(null);
  const activeIndex =
    selection !== null && selection.key === key && count > 0
      ? Math.min(selection.index, count - 1)
      : 0;
  const move = (delta: number): void => {
    if (key === null || count === 0) {
      return;
    }
    setSelection({
      key,
      index: (activeIndex + delta + count) % count,
    });
  };
  return { activeIndex, move };
}

export function useMentionController({
  client,
  cwd,
  value,
  editing,
}: {
  readonly client: IpcClient;
  readonly cwd: string | undefined;
  readonly value: string;
  readonly editing: PromptEditing;
}): MentionController {
  const listId = useId();
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const mention = activeMention(value, editing.caret ?? value.length);
  const query = completionQueryOf(mention);
  const completion = useMentionCompletion(client, cwd, query);
  const listOpen =
    query !== null && query.key !== closedKey && !completion.blocked;
  const items = listOpen ? completion.items : EMPTY_ITEMS;
  const { activeIndex, move } = useSuggestionSelection(
    query?.key ?? null,
    items.length,
  );
  const options: readonly ListboxOption[] = items.map((item) => ({
    key: optionKeyOf(item),
    label: item.kind === "dir" ? `${item.path}/` : item.path,
    description:
      item.kind === "dir" ? PROMPT_INPUT_STRINGS.folderSuffixHint : undefined,
  }));

  const choose = (key: string): void => {
    const item = items.find((candidate) => optionKeyOf(candidate) === key);
    if (item === undefined || mention === null) {
      return;
    }
    const applied = applyMention(value, mention, item);
    editing.applyText(applied.text, applied.caret);
    setClosedKey(null);
  };

  const dismiss = (): void => {
    setClosedKey(query?.key ?? null);
  };

  const clearDismissalOutside = (nextValue: string, caret: number): void => {
    if (activeMention(nextValue, caret) === null) {
      setClosedKey(null);
    }
  };

  return {
    menu: {
      listId,
      listOpen,
      loading: listOpen && completion.loading,
      label: PROMPT_INPUT_STRINGS.mentionListLabel,
      emptyText: PROMPT_INPUT_STRINGS.mentionEmpty,
      statusText: null,
      options,
      activeIndex,
      onChoose: choose,
      onDismiss: dismiss,
      onMove: move,
    },
    handleKey: (event) =>
      handleListKey(event, {
        listOpen,
        activeKey: options[activeIndex]?.key ?? null,
        onMove: move,
        onChoose: choose,
        onDismiss: dismiss,
      }),
    clearDismissalOutside,
  };
}
