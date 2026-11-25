import { structuredPatch, type StructuredPatchHunk } from "diff";

import { DiffOmission, FileChange, type FileDiff } from "../domain/events";

import {
  DIFF_CONTEXT_LINES,
  DIFF_MAX_EDIT_LENGTH,
  DIFF_MAX_PATCH_CHARS,
  DIFF_TIMEOUT_MS,
} from "./constants";
import { SnapshotKind, type FileSnapshot } from "./fileSnapshot";

const LINE_SEPARATOR = "\n";

function changeOf(before: FileSnapshot, after: FileSnapshot): FileChange {
  if (before.kind === SnapshotKind.missing) {
    return FileChange.created;
  }
  return after.kind === SnapshotKind.missing
    ? FileChange.deleted
    : FileChange.modified;
}

function omissionOf(
  before: FileSnapshot,
  after: FileSnapshot,
): DiffOmission | null {
  const kinds: readonly SnapshotKind[] = [before.kind, after.kind];
  if (kinds.includes(SnapshotKind.binary)) {
    return DiffOmission.binary;
  }
  return kinds.includes(SnapshotKind.tooLarge) ? DiffOmission.tooLarge : null;
}

function textOf(snapshot: FileSnapshot): string {
  return snapshot.kind === SnapshotKind.text ? snapshot.text : "";
}

function rangeOf(start: number, lines: number): string {
  return `${String(lines === 0 ? 0 : start)},${String(lines)}`;
}

function formatHunk(hunk: StructuredPatchHunk): string {
  const old = rangeOf(hunk.oldStart, hunk.oldLines);
  const added = rangeOf(hunk.newStart, hunk.newLines);
  const header = `@@ -${old} +${added} @@`;
  return [header, ...hunk.lines].join(LINE_SEPARATOR);
}

export interface PositionedDiffInput {
  readonly before: FileSnapshot;
  readonly after: FileSnapshot;
  readonly line: number;
}

type StructuredResult =
  | { readonly hunks: readonly StructuredPatchHunk[] }
  | { readonly omitted: DiffOmission }
  | null;

function structuredHunksOf(
  before: FileSnapshot,
  after: FileSnapshot,
): StructuredResult {
  const omitted = omissionOf(before, after);
  if (omitted !== null) {
    return { omitted };
  }
  const beforeText = textOf(before);
  const afterText = textOf(after);
  if (
    before.kind === SnapshotKind.text &&
    after.kind === SnapshotKind.text &&
    beforeText === afterText
  ) {
    return null;
  }
  const structured = structuredPatch("", "", beforeText, afterText, "", "", {
    context: DIFF_CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
    maxEditLength: DIFF_MAX_EDIT_LENGTH,
  });
  return structured === undefined
    ? { omitted: DiffOmission.tooLarge }
    : { hunks: structured.hunks };
}

function finalizePatch(
  path: string,
  change: FileChange,
  hunkStrings: readonly string[],
): FileDiff {
  const patch = hunkStrings.join(LINE_SEPARATOR);
  return patch.length > DIFF_MAX_PATCH_CHARS
    ? { path, change, omitted: DiffOmission.tooLarge }
    : { path, change, patch };
}

export function computeFileDiff(
  path: string,
  before: FileSnapshot,
  after: FileSnapshot,
): FileDiff | null {
  if (
    before.kind === SnapshotKind.missing &&
    after.kind === SnapshotKind.missing
  ) {
    return null;
  }
  const change = changeOf(before, after);
  const result = structuredHunksOf(before, after);
  if (result === null) {
    return null;
  }
  if ("omitted" in result) {
    return { path, change, omitted: result.omitted };
  }
  return finalizePatch(path, change, result.hunks.map(formatHunk));
}

export function computePositionedFileDiff(
  path: string,
  inputs: readonly PositionedDiffInput[],
): FileDiff | null {
  const hunkStrings: string[] = [];
  let delta = 0;
  for (const input of inputs) {
    const result = structuredHunksOf(input.before, input.after);
    if (result === null) {
      continue;
    }
    if ("omitted" in result) {
      return { path, change: FileChange.modified, omitted: result.omitted };
    }
    const oldOffset = input.line - 1 - delta;
    const newOffset = input.line - 1;
    let inputDelta = 0;
    for (const hunk of result.hunks) {
      const shifted: StructuredPatchHunk = {
        ...hunk,
        oldStart: hunk.oldStart + oldOffset,
        newStart: hunk.newStart + newOffset,
      };
      hunkStrings.push(formatHunk(shifted));
      inputDelta += hunk.newLines - hunk.oldLines;
    }
    delta += inputDelta;
  }
  return hunkStrings.length === 0
    ? null
    : finalizePatch(path, FileChange.modified, hunkStrings);
}
