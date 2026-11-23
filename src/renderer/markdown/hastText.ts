import type { Element, Nodes } from "hast";

const LANGUAGE_CLASS_PREFIX = "language-";
const TRAILING_NEWLINE = /\n$/;

export function hastText(node: Nodes): string {
  if (node.type === "text") {
    return node.value;
  }
  return "children" in node ? node.children.map(hastText).join("") : "";
}

export function codeLanguageOf(pre: Element): string | null {
  for (const child of pre.children) {
    if (child.type !== "element" || child.tagName !== "code") {
      continue;
    }
    const classes = child.properties.className;
    if (!Array.isArray(classes)) {
      return null;
    }
    const tag = classes.find(
      (name) =>
        typeof name === "string" && name.startsWith(LANGUAGE_CLASS_PREFIX),
    );
    return typeof tag === "string"
      ? tag.slice(LANGUAGE_CLASS_PREFIX.length)
      : null;
  }
  return null;
}

export function codeTextOf(pre: Element): string {
  return hastText(pre).replace(TRAILING_NEWLINE, "");
}
