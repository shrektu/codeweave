import { expect, it } from "vitest";

import type { FileDiff } from "../domain/events";

import { reverseApply } from "./checkpointPlan";
import { computeFileDiff } from "./fileDiff";
import { SnapshotKind, type FileSnapshot } from "./fileSnapshot";

const PATH = "/repo/src/app.ts";
const BEFORE = "line one\nline two\nline three\n";
const AFTER = "line one\nline TWO\nline three\n";
const CODEX_PATCH = "@@ -1,2 +1,2 @@\n-alpha\n-beta\n+gamma\n+delta";

function text(value: string): FileSnapshot {
  return { kind: SnapshotKind.text, text: value };
}

function patchOf(diff: FileDiff | null): string {
  if (diff === null || !("patch" in diff)) {
    throw new Error("expected a patch diff");
  }
  return diff.patch;
}

it("reverseApply restores the before text of a computeFileDiff patch", () => {
  const patch = patchOf(computeFileDiff(PATH, text(BEFORE), text(AFTER)));

  expect(reverseApply(patch, AFTER)).toBe(BEFORE);
});

it("reverseApply restores the before text of a codex hunks-only patch", () => {
  expect(reverseApply(CODEX_PATCH, "gamma\ndelta\n")).toBe("alpha\nbeta\n");
});

it("reverseApply returns null when the file changed after the edit", () => {
  const patch = patchOf(computeFileDiff(PATH, text(BEFORE), text(AFTER)));

  expect(reverseApply(patch, "line one\nchanged\nline three\n")).toBeNull();
});
