import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

const RENDERER_DIR = import.meta.dirname;
const POLISH_LETTERS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const OLD_LABELS = [
  "Konta",
  "Sesja",
  "Limity",
  "Efekty",
  "niskie",
  "pełne",
  "łączenie",
  "brak połączenia",
  'lang="pl"',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(tsx?|css|html)$/.test(entry.name) &&
      !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

it("renderer_has_no_polish_strings", () => {
  const files = sourceFiles(RENDERER_DIR);
  expect(files.length).toBeGreaterThan(0);

  const offenders = files.filter((file) => {
    const text = readFileSync(file, "utf8");
    return (
      POLISH_LETTERS.test(text) ||
      OLD_LABELS.some((label) => text.includes(label))
    );
  });

  expect(offenders).toEqual([]);
});
