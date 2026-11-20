import { type ParseEntry } from "shell-quote";

import { FD_PREFIX_PATTERN, REDIRECT_OPERATORS } from "./permissionRules";

export interface Redirection {
  readonly op: string;
  readonly target: string;
}

export type BoundToken = ParseEntry | Redirection;

function redirectOperator(token: ParseEntry | undefined): string | null {
  return token !== undefined &&
    typeof token !== "string" &&
    "op" in token &&
    !("pattern" in token) &&
    REDIRECT_OPERATORS.includes(token.op)
    ? token.op
    : null;
}

export function bindRedirections(
  tokens: readonly ParseEntry[],
  fdFlags: readonly boolean[],
): BoundToken[] | null {
  const bound: BoundToken[] = [];
  let consumed = 0;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const target = tokens[index + 1];
    const op = redirectOperator(token);
    if (token === undefined || op === null) {
      bound.push(token ?? "");
      index += 1;
      continue;
    }
    if (typeof target !== "string") {
      return null;
    }
    const previous = bound.at(-1);
    if (
      fdFlags[consumed] === true &&
      typeof previous === "string" &&
      FD_PREFIX_PATTERN.test(previous)
    ) {
      bound.pop();
    }
    bound.push({ op, target });
    consumed += 1;
    index += 2;
  }
  return consumed === fdFlags.length ? bound : null;
}

const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKSLASH = "\\";
const AMPERSAND = "&";
const WORD_BOUNDARY_PATTERN = /[\s;|&()<>]/;
const DIGIT_PATTERN = /\d/;
const REDIRECT_OPERATOR_PATTERN = /<<<|<<|<&|<>|<|>>|>&|>\||>|&>/y;
const UNTRUSTED = -1;

function closingQuote(command: string, open: number): number {
  const quote = command.charAt(open);
  let index = open + 1;
  while (index < command.length) {
    const char = command.charAt(index);
    if (char === quote) {
      return index;
    }
    index += char === BACKSLASH && quote === DOUBLE_QUOTE ? 2 : 1;
  }
  return UNTRUSTED;
}

function operatorAt(command: string, index: number): string | null {
  REDIRECT_OPERATOR_PATTERN.lastIndex = index;
  return REDIRECT_OPERATOR_PATTERN.exec(command)?.[0] ?? null;
}

function hasFdPrefix(command: string, index: number): boolean {
  let start = index;
  while (start > 0 && DIGIT_PATTERN.test(command.charAt(start - 1))) {
    start -= 1;
  }
  return (
    start < index &&
    (start === 0 || WORD_BOUNDARY_PATTERN.test(command.charAt(start - 1)))
  );
}

function nextIndex(command: string, index: number, flags: boolean[]): number {
  const char = command.charAt(index);
  if (char === BACKSLASH) {
    return index + 2;
  }
  if (char === SINGLE_QUOTE || char === DOUBLE_QUOTE) {
    const close = closingQuote(command, index);
    return close === UNTRUSTED ? UNTRUSTED : close + 1;
  }
  const operator = operatorAt(command, index);
  if (operator === null) {
    return index + 1;
  }
  flags.push(!operator.startsWith(AMPERSAND) && hasFdPrefix(command, index));
  return index + operator.length;
}

export function fdRedirectionFlags(command: string): readonly boolean[] | null {
  const flags: boolean[] = [];
  let index = 0;
  while (index < command.length) {
    index = nextIndex(command, index, flags);
    if (index === UNTRUSTED) {
      return null;
    }
  }
  return flags;
}
