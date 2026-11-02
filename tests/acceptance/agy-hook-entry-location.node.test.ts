import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..", "..", "src");
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const MAIN_ENTRY = join(SRC, "main", "index.ts");
const BACKEND_ENTRY = join(SRC, "backend", "index.ts");
const HOOK_ENTRY = join(SRC, "backend", "agy", "hook.ts");
const HOOK_CONFIG = join(SRC, "backend", "agy", "hookConfig.ts");

function sourceFileOf(base: string): string | null {
  return (
    [`${base}.ts`, join(base, "index.ts")].find((candidate) =>
      existsSync(candidate),
    ) ?? null
  );
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      const next =
        specifier === undefined
          ? null
          : sourceFileOf(resolve(dirname(file), specifier));
      if (next !== null) {
        pending.push(next);
      }
    }
  }
  return seen;
}

it("locate_agy_hook_entry_from_main_bundle", () => {
  expect(reachableFrom(BACKEND_ENTRY).has(HOOK_CONFIG)).toBe(true);
  expect(reachableFrom(MAIN_ENTRY).has(HOOK_CONFIG)).toBe(false);
  expect(reachableFrom(HOOK_ENTRY).has(HOOK_CONFIG)).toBe(false);
});
