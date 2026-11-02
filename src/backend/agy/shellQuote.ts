const SINGLE_QUOTE = "'";
const ESCAPED_SINGLE_QUOTE = "'\\''";

export function posixQuote(text: string): string {
  return `${SINGLE_QUOTE}${text.replaceAll(SINGLE_QUOTE, ESCAPED_SINGLE_QUOTE)}${SINGLE_QUOTE}`;
}
