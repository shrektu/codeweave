import { applyPatch } from "diff";
import { expect, it } from "vitest";

import { DIFF_MAX_PATCH_CHARS } from "./constants";
import { computeFileDiff, computePositionedFileDiff } from "./fileDiff";
import { type FileSnapshot } from "./fileSnapshot";

const PATH = "src/app.ts";
const MISSING: FileSnapshot = { kind: "missing" };
const BINARY: FileSnapshot = { kind: "binary" };
const TOO_LARGE: FileSnapshot = { kind: "too_large" };
const RANDOM_CASES = 300;
const BUDGET_BLOWING_LINES = 25_000;

function text(value: string): FileSnapshot {
  return { kind: "text", text: value };
}

function fullPatch(hunks: string): string {
  return `--- a\n+++ b\n${hunks}\n`;
}

type Rng = (bound: number) => number;

function makeRng(initial: number): Rng {
  let seed = initial;
  return (bound) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed % bound;
  };
}

function applyRandomEdit(lines: string[], next: Rng): void {
  const at = next(lines.length + 1);
  const action = next(3);
  if (action === 0) {
    lines.splice(at, 0, `new ${String(next(1000))}`);
  } else if (action === 1) {
    lines.splice(at, 1);
  } else if (at < lines.length) {
    lines[at] = `changed ${String(next(1000))}`;
  }
}

function joinLines(lines: readonly string[], eol: string, next: Rng): string {
  if (lines.length === 0) {
    return "";
  }
  return lines.join(eol) + (next(2) === 0 ? eol : "");
}

function randomPair(next: Rng): { before: string; after: string } {
  const eol = next(2) === 0 ? "\n" : "\r\n";
  const lines = Array.from(
    { length: next(30) },
    (_, i) => `row ${String(i)} ${String(next(5))}`,
  );
  const edited = [...lines];
  const edits = 1 + next(5);
  for (let edit = 0; edit < edits; edit += 1) {
    applyRandomEdit(edited, next);
  }
  return {
    before: joinLines(lines, eol, next),
    after: joinLines(edited, eol, next),
  };
}

it("created_file_patch_adds_all_lines", () => {
  expect(computeFileDiff(PATH, MISSING, text("a\nb\n"))).toEqual({
    path: PATH,
    change: "created",
    patch: "@@ -0,0 +1,2 @@\n+a\n+b",
  });
});

it("deleted_file_patch_removes_all_lines", () => {
  expect(computeFileDiff(PATH, text("a\nb\n"), MISSING)).toEqual({
    path: PATH,
    change: "deleted",
    patch: "@@ -1,2 +0,0 @@\n-a\n-b",
  });
});

it("modified_file_patch_has_hunk_header", () => {
  expect(computeFileDiff(PATH, text("a\nb\nc\n"), text("a\nB\nc\n"))).toEqual({
    path: PATH,
    change: "modified",
    patch: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c",
  });
});

it("identical_text_returns_null", () => {
  expect(computeFileDiff(PATH, text("same\n"), text("same\n"))).toBeNull();
});

it("both_missing_returns_null", () => {
  expect(computeFileDiff(PATH, MISSING, MISSING)).toBeNull();
});

it("binary_side_is_omitted", () => {
  expect(computeFileDiff(PATH, text("a"), BINARY)).toEqual({
    path: PATH,
    change: "modified",
    omitted: "binary",
  });
  expect(computeFileDiff(PATH, MISSING, BINARY)).toEqual({
    path: PATH,
    change: "created",
    omitted: "binary",
  });
});

it("binary_wins_over_too_large", () => {
  expect(computeFileDiff(PATH, TOO_LARGE, BINARY)).toEqual({
    path: PATH,
    change: "modified",
    omitted: "binary",
  });
});

it("too_large_side_is_omitted", () => {
  expect(computeFileDiff(PATH, TOO_LARGE, text("a"))).toEqual({
    path: PATH,
    change: "modified",
    omitted: "too_large",
  });
  expect(computeFileDiff(PATH, TOO_LARGE, MISSING)).toEqual({
    path: PATH,
    change: "deleted",
    omitted: "too_large",
  });
});

it("missing_final_newline_is_marked", () => {
  expect(computeFileDiff(PATH, text("a\nb"), text("a\nb\n"))).toEqual({
    path: PATH,
    change: "modified",
    patch: "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b",
  });
});

it("edit_budget_exceeded_is_too_large", () => {
  const before = Array.from(
    { length: BUDGET_BLOWING_LINES },
    (_, i) => `a${String(i)}`,
  );
  const after = Array.from(
    { length: BUDGET_BLOWING_LINES },
    (_, i) => `b${String(i)}`,
  );

  expect(
    computeFileDiff(PATH, text(before.join("\n")), text(after.join("\n"))),
  ).toEqual({ path: PATH, change: "modified", omitted: "too_large" });
});

it("patch_over_cap_is_too_large", () => {
  const lines = Array.from(
    { length: 2000 },
    (_, i) => `line number ${String(i)} ${"x".repeat(40)}`,
  );
  const content = lines.join("\n");
  expect(content.length).toBeGreaterThan(DIFF_MAX_PATCH_CHARS);

  expect(computeFileDiff(PATH, MISSING, text(content))).toEqual({
    path: PATH,
    change: "created",
    omitted: "too_large",
  });
});

it("patch_round_trips_over_seeded_random_edits", () => {
  const next = makeRng(20_261_102);
  for (let round = 0; round < RANDOM_CASES; round += 1) {
    const { before, after } = randomPair(next);

    const diff = computeFileDiff(PATH, text(before), text(after));

    if (before === after) {
      expect(diff).toBeNull();
    } else {
      expect(diff).toHaveProperty("patch");
      const patch = diff !== null && "patch" in diff ? diff.patch : "";
      expect(applyPatch(before, fullPatch(patch))).toBe(after);
    }
  }
});

const SPLIT_SNIPPET_BEFORE = [
  "L1",
  "u1",
  "u2",
  "u3",
  "u4",
  "u5",
  "u6",
  "u7",
  "u8",
  "old",
  "",
].join("\n");

const SPLIT_SNIPPET_AFTER = [
  "L1",
  "ins",
  "u1",
  "u2",
  "u3",
  "u4",
  "u5",
  "u6",
  "u7",
  "u8",
  "new",
  "",
].join("\n");

it("positioned_diff_keeps_old_start_for_split_snippet", () => {
  const diff = computePositionedFileDiff(PATH, [
    {
      before: text(SPLIT_SNIPPET_BEFORE),
      after: text(SPLIT_SNIPPET_AFTER),
      line: 50,
    },
  ]);

  expect(diff).toEqual({
    path: PATH,
    change: "modified",
    patch: [
      "@@ -50,4 +50,5 @@",
      " L1",
      "+ins",
      " u1",
      " u2",
      " u3",
      "@@ -56,4 +57,4 @@",
      " u6",
      " u7",
      " u8",
      "-old",
      "+new",
    ].join("\n"),
  });
});
