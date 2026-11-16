import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml";

import {
  FRONTMATTER_PATTERN,
  type FlowDefinition,
  type ParseResult,
} from "./flows";

const CRLF = "\r\n";
const LF = "\n";
const FENCE = "---";
const MISSING_FRONTMATTER = "Missing YAML frontmatter";
const RECURSIVE_ALIASES =
  "Recursive YAML aliases in the flow front matter are not supported";
const REUSED_ANCHORS =
  "Reused YAML anchor names in the flow front matter are not supported";
const MANAGED_KEYS = ["title", "nodes", "edges", "maxRounds"] as const;

type Entry = Record<string, string | boolean>;

interface EntrySpec {
  readonly name: string;
  readonly managed: readonly string[];
  readonly identity: readonly string[];
}

const NODES_SPEC: EntrySpec = {
  name: "nodes",
  managed: ["id", "agent", "provider"],
  identity: ["id"],
};
const EDGES_SPEC: EntrySpec = {
  name: "edges",
  managed: ["from", "to", "kind", "gate"],
  identity: ["from", "to", "kind"],
};

function plainNodes(flow: FlowDefinition): Entry[] {
  return flow.nodes.map(({ id, agent, provider }) => ({
    id,
    agent,
    ...(provider === undefined ? {} : { provider }),
  }));
}

function plainEdges(flow: FlowDefinition): Entry[] {
  return flow.edges.map(({ from, to, kind, gate }) => ({
    from,
    to,
    kind,
    ...(gate === true ? { gate } : {}),
  }));
}

function sameIdentity(
  existing: YAMLMap,
  entry: Entry,
  identity: readonly string[],
): boolean {
  return identity.every((key) => existing.get(key) === entry[key]);
}

function updateInPlace(
  existing: YAMLMap,
  entry: Entry,
  managed: readonly string[],
): YAMLMap {
  for (const key of managed) {
    const value = entry[key];
    if (value === undefined) {
      existing.delete(key);
    } else {
      existing.set(key, value);
    }
  }
  return existing;
}

class UnsupportedAliasError extends Error {}

function collectNodes(root: unknown, inside: Set<unknown>): void {
  if (isNode(root)) {
    visit(root, {
      Node: (_key, node) => {
        inside.add(node);
      },
    });
  }
}

function managedNodes(document: Document): Set<unknown> {
  const inside = new Set<unknown>();
  if (!isMap(document.contents)) {
    return inside;
  }
  for (const pair of document.contents.items) {
    const { key } = pair;
    if (isScalar(key) && MANAGED_KEYS.some((name) => name === key.value)) {
      collectNodes(key, inside);
      collectNodes(pair.value, inside);
    }
  }
  return inside;
}

function hasReusedAnchorNames(document: Document): boolean {
  const names = new Set<string>();
  let reused = false;
  visit(document, {
    Node: (_key, node) => {
      if (node.anchor === undefined) {
        return;
      }
      reused ||= names.has(node.anchor);
      names.add(node.anchor);
    },
  });
  return reused;
}

function unanchoredCopy(source: Node): Node | undefined {
  const copy = source.clone();
  if (!isNode(copy)) {
    return undefined;
  }
  visit(copy, {
    Node: (_key, node) => {
      if (!isAlias(node)) {
        delete node.anchor;
      }
    },
  });
  return copy;
}

function inlineManagedAliases(document: Document): void {
  const inside = managedNodes(document);
  const reused = hasReusedAnchorNames(document);
  visit(document, {
    Alias: (_key, alias, path) => {
      const source = alias.resolve(document);
      if (source === undefined || !inside.has(source)) {
        return undefined;
      }
      if (reused) {
        throw new UnsupportedAliasError(REUSED_ANCHORS);
      }
      if (path.includes(source)) {
        throw new UnsupportedAliasError(RECURSIVE_ALIASES);
      }
      return unanchoredCopy(source);
    },
  });
}

function mergeEntries(
  document: Document,
  { name, managed, identity }: EntrySpec,
  entries: readonly Entry[],
): void {
  const sequence = document.get(name, true);
  if (!isSeq(sequence) || sequence.items.length === 0) {
    document.set(name, entries);
    return;
  }
  const unused = sequence.items.filter(isMap);
  sequence.items = entries.map((entry) => {
    const index = unused.findIndex((item) =>
      sameIdentity(item, entry, identity),
    );
    const [found] = index === -1 ? [] : unused.splice(index, 1);
    return found === undefined
      ? document.createNode(entry)
      : updateInPlace(found, entry, managed);
  });
}

export function serializeFlowFile(
  original: string,
  flow: FlowDefinition,
): ParseResult<string> {
  const match = FRONTMATTER_PATTERN.exec(original);
  if (match?.[1] === undefined) {
    return { ok: false, errors: [MISSING_FRONTMATTER] };
  }
  const document = parseDocument(match[1]);
  const [firstError] = document.errors;
  if (firstError !== undefined) {
    return {
      ok: false,
      errors: [`Invalid YAML frontmatter: ${firstError.message}`],
    };
  }
  try {
    inlineManagedAliases(document);
    document.set("title", flow.title);
    mergeEntries(document, NODES_SPEC, plainNodes(flow));
    mergeEntries(document, EDGES_SPEC, plainEdges(flow));
    if (flow.maxRounds === undefined) {
      document.delete("maxRounds");
    } else {
      document.set("maxRounds", flow.maxRounds);
    }
    const eol = match[0].includes(CRLF) ? CRLF : LF;
    const yaml = document
      .toString({ lineWidth: 0 })
      .trimEnd()
      .replaceAll(LF, eol);
    return {
      ok: true,
      value: `${FENCE}${eol}${yaml}${eol}${FENCE}${original.slice(match[0].length)}`,
    };
  } catch (error) {
    if (error instanceof UnsupportedAliasError) {
      return { ok: false, errors: [error.message] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`Cannot update frontmatter: ${message}`] };
  }
}
