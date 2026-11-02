import { relative, sep } from "node:path";

import type { FileDiff } from "../../domain/events";
import { computeFileDiff } from "../fileDiff";
import { readFileSnapshot } from "../fileSnapshot";

import {
  laterSnapshotOf,
  takeStepSnapshot,
  type StepSnapshotRecord,
} from "./snapshots";

const POSIX_SEPARATOR = "/";

type SnapshotEntry = StepSnapshotRecord["entries"][number];

export interface StepDiffRequest {
  readonly dir: string;
  readonly cwd: string;
  readonly conversationId: string;
  readonly stepIdx: number;
}

async function diffOfEntry(
  request: StepDiffRequest,
  entry: SnapshotEntry,
): Promise<FileDiff | null> {
  const { dir, cwd, conversationId, stepIdx } = request;
  const after = await readFileSnapshot(entry.path);
  const later = await laterSnapshotOf(dir, conversationId, stepIdx, entry.path);
  return computeFileDiff(
    relative(cwd, entry.path).split(sep).join(POSIX_SEPARATOR),
    entry.snapshot,
    later ?? after,
  );
}

export async function stepDiffsOf(
  request: StepDiffRequest,
): Promise<FileDiff[]> {
  const record = await takeStepSnapshot(
    request.dir,
    request.conversationId,
    request.stepIdx,
  );
  if (record === null) {
    return [];
  }
  const diffs: FileDiff[] = [];
  for (const entry of record.entries) {
    try {
      const diff = await diffOfEntry(request, entry);
      if (diff !== null) {
        diffs.push(diff);
      }
    } catch (error) {
      console.error(`agy diff skipped ${entry.path}`, error);
    }
  }
  return diffs;
}
