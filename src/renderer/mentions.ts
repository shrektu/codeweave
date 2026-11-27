import type { FileCompletionItem } from "../shared/views";

export interface MentionToken {
  readonly start: number;
  readonly query: string;
}

export interface MentionEdit {
  readonly text: string;
  readonly caret: number;
}

const MENTION_MARKER = "@";
const QUOTE = '"';
const WHITESPACE = /\s/;

function quotedAt(text: string, start: number): boolean {
  return text.at(start + 1) === QUOTE;
}

function replacementOf(item: FileCompletionItem): string {
  const quoted = WHITESPACE.test(item.path)
    ? `${MENTION_MARKER}${QUOTE}${item.path}${QUOTE}`
    : `${MENTION_MARKER}${item.path}`;
  return item.kind === "dir" ? `${quoted}/` : `${quoted} `;
}

export function activeMention(
  text: string,
  caret: number,
): MentionToken | null {
  const position = Math.min(Math.max(caret, 0), text.length);
  if (position === 0) {
    return null;
  }
  const start = text.lastIndexOf(MENTION_MARKER, position - 1);
  if (start === -1) {
    return null;
  }
  const previous = start === 0 ? undefined : text.at(start - 1);
  if (previous !== undefined && !WHITESPACE.test(previous)) {
    return null;
  }
  const raw = text.slice(start + 1, position);
  if (raw.startsWith(QUOTE)) {
    const body = raw.slice(1);
    return body.includes(QUOTE) ? null : { start, query: body };
  }
  if (WHITESPACE.test(raw)) {
    return null;
  }
  return { start, query: raw };
}

export function applyMention(
  text: string,
  mention: MentionToken,
  item: FileCompletionItem,
): MentionEdit {
  const offset = quotedAt(text, mention.start) ? 2 : 1;
  const end = mention.start + offset + mention.query.length;
  const replacement = replacementOf(item);
  return {
    text: `${text.slice(0, mention.start)}${replacement}${text.slice(end)}`,
    caret: mention.start + replacement.length,
  };
}
