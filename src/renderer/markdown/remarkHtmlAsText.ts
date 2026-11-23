import type { Html, Nodes, Parents, Root, Text } from "mdast";

const FLOW_PARENTS: ReadonlySet<Nodes["type"]> = new Set([
  "root",
  "blockquote",
  "listItem",
]);

function asText(node: Html): Text {
  return { type: "text", value: node.value };
}

function replacementFor(parent: Parents, node: Html): Nodes {
  const text = asText(node);
  return FLOW_PARENTS.has(parent.type)
    ? { type: "paragraph", children: [text] }
    : text;
}

function rewriteHtml(parent: Parents): void {
  const children: Nodes[] = parent.children;
  children.forEach((child, index) => {
    if (child.type === "html") {
      children[index] = replacementFor(parent, child);
    } else if ("children" in child) {
      rewriteHtml(child);
    }
  });
}

export function remarkHtmlAsText(): (tree: Root) => void {
  return (tree) => {
    rewriteHtml(tree);
  };
}
