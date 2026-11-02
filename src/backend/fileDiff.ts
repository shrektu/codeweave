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
  const omitted = omissionOf(before, after);
  if (omitted !== null) {
    return { path, change, omitted };
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
  if (structured === undefined) {
    return { path, change, omitted: DiffOmission.tooLarge };
  }
  const patch = structured.hunks.map(formatHunk).join(LINE_SEPARATOR);
  if (patch.length > DIFF_MAX_PATCH_CHARS) {
    return { path, change, omitted: DiffOmission.tooLarge };
  }
  return { path, change, patch };
}
