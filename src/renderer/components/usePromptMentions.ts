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

interface CursorRequest {
  readonly position: number;
  readonly revision: number;
}

interface MentionKeys {
  readonly listOpen: boolean;
  readonly items: readonly FileCompletionItem[];
  readonly activeIndex: number;
  readonly onMove: (delta: number) => void;
  readonly onChoose: (item: FileCompletionItem) => void;
  readonly onDismiss: () => void;
}

export interface MentionController {
  readonly listId: string;
  readonly listOpen: boolean;
  readonly items: readonly FileCompletionItem[];
  readonly loading: boolean;
  readonly activeIndex: number;
  readonly onChoose: (item: FileCompletionItem) => void;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  readonly onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onBlur: () => void;
}

const MENTION_DEBOUNCE_MS = 120;

interface CompletionQuery {
  readonly key: string;
  readonly query: string;
}

interface EditingState {
  readonly query: CompletionQuery | null;
  readonly closedKey: string | null;
  readonly cursor: CursorRequest;
  readonly onTextChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onCaretMove: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  readonly onArrowMove: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly close: () => void;
  readonly apply: (item: FileCompletionItem) => void;
}

const EMPTY_ITEMS: readonly FileCompletionItem[] = [];
const EMPTY_COMPLETION: CompletionView = {
  items: EMPTY_ITEMS,
  loading: false,
  blocked: false,
};

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

function useCaretRestore(
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

function handleMentionKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  keys: MentionKeys,
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
    event.preventDefault();
    const item = keys.items[keys.activeIndex];
    if (item !== undefined) {
      keys.onChoose(item);
    }
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    keys.onDismiss();
    return true;
  }
  return false;
}

function handleSubmitKey(
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

function useMentionEditing(
  value: string,
  onChange: (value: string) => void,
): EditingState {
  const [caret, setCaret] = useState<number | null>(null);
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorRequest>({
    position: 0,
    revision: 0,
  });
  const mention = activeMention(value, caret ?? value.length);
  const query = completionQueryOf(mention);

  const apply = (item: FileCompletionItem): void => {
    if (mention === null) {
      return;
    }
    const applied = applyMention(value, mention, item);
    onChange(applied.text);
    setCaret(applied.caret);
    setCursor((current) => ({
      position: applied.caret,
      revision: current.revision + 1,
    }));
    setClosedKey(null);
  };

  return {
    query,
    closedKey,
    cursor,
    apply,
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
    close: () => {
      setClosedKey(query?.key ?? null);
    },
  };
}

function useSuggestionSelection(
  query: CompletionQuery | null,
  items: readonly FileCompletionItem[],
): { readonly activeIndex: number; readonly move: (delta: number) => void } {
  const [selection, setSelection] = useState<Selection | null>(null);
  const activeIndex =
    selection !== null && selection.key === query?.key && items.length > 0
      ? Math.min(selection.index, items.length - 1)
      : 0;
  const move = (delta: number): void => {
    if (query === null || items.length === 0) {
      return;
    }
    setSelection({
      key: query.key,
      index: (activeIndex + delta + items.length) % items.length,
    });
  };
  return { activeIndex, move };
}

export function useMentionController({
  client,
  cwd,
  value,
  onChange,
  onSubmit,
  textareaRef,
}: {
  readonly client: IpcClient;
  readonly cwd: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (() => void) | undefined;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}): MentionController {
  const listId = useId();
  const editing = useMentionEditing(value, onChange);
  const completion = useMentionCompletion(client, cwd, editing.query);
  const listOpen =
    editing.query !== null &&
    editing.query.key !== editing.closedKey &&
    !completion.blocked;
  const items = listOpen ? completion.items : EMPTY_ITEMS;
  const { activeIndex, move } = useSuggestionSelection(editing.query, items);
  useCaretRestore(textareaRef, editing.cursor);

  return {
    listId,
    listOpen,
    items,
    loading: listOpen && completion.loading,
    activeIndex,
    onChoose: editing.apply,
    onBlur: editing.close,
    onSelect: editing.onCaretMove,
    onKeyUp: editing.onArrowMove,
    onChange: editing.onTextChange,
    onKeyDown: (event) => {
      const handled = handleMentionKey(event, {
        listOpen,
        items,
        activeIndex,
        onMove: move,
        onChoose: editing.apply,
        onDismiss: editing.close,
      });
      if (!handled) {
        handleSubmitKey(event, onSubmit);
      }
    },
  };
}
