import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import { isValidElement, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

export const MAX_HIGHLIGHT_CHARS = 20_000;

const lowlight = createLowlight(common);

export function highlightedCode(
  language: string | null,
  text: string,
): ReactNode {
  const name = language?.toLowerCase();
  if (
    name === undefined ||
    text.length > MAX_HIGHLIGHT_CHARS ||
    !lowlight.registered(name)
  ) {
    return text;
  }
  const element: unknown = toJsxRuntime(lowlight.highlight(name, text), {
    Fragment,
    jsx,
    jsxs,
  });
  return isValidElement(element) ? element : text;
}
