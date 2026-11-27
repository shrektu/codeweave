import { applyPatch, parsePatch, reversePatch } from "diff";
import { z } from "zod";

import { RestoreAction, RestoreSkipReason } from "../domain/checkpoints";
import { FileChange } from "../domain/events";
import type { RestorePlanFileView, RestorePlanView } from "../shared/views";

import { SnapshotStampSchema } from "./fileSnapshot";

export const BlobRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({
    kind: z.literal("stored"),
    hash: z.string(),
    bytes: z.int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    reason: z.enum(RestoreSkipReason),
  }),
]);
export type BlobRef = z.infer<typeof BlobRefSchema>;

export const CheckpointEntrySchema = z.strictObject({
  editKey: z.string(),
  promptSeq: z.int(),
  path: z.string(),
  before: BlobRefSchema,
  after: BlobRefSchema,
  order: z.int(),
  change: z.enum(FileChange).optional(),
  patch: z.string().optional(),
  lateReadOf: z.string().optional(),
  afterStamp: SnapshotStampSchema.optional(),
});
export type CheckpointEntry = z.infer<typeof CheckpointEntrySchema>;

export function reverseApply(patch: string, afterText: string): string | null {
  try {
    const [parsed] = parsePatch(patch);
    if (parsed === undefined || parsed.hunks.length === 0) {
      return null;
    }
    const applied = applyPatch(afterText, reversePatch(parsed));
    return applied === false ? null : applied;
  } catch (error) {
    console.warn("a checkpoint patch could not be reversed", error);
    return null;
  }
}

export function sameRef(a: BlobRef, b: BlobRef): boolean {
  if (a.kind === "missing" || b.kind === "missing") {
    return a.kind === b.kind;
  }
  if (a.kind !== "stored" || b.kind !== "stored") {
    return false;
  }
  return a.hash === b.hash;
}

export interface PlanRestoreInput {
  readonly sessionId: string;
  readonly promptSeq: number;
  readonly entries: readonly CheckpointEntry[];
  readonly current: ReadonlyMap<string, BlobRef>;
  readonly isProtected: (path: string) => boolean;
}

interface PathRewind {
  readonly path: string;
  readonly target: BlobRef;
  readonly lastAfter: BlobRef;
}

function comparePaths(a: PathRewind, b: PathRewind): number {
  if (a.path === b.path) {
    return 0;
  }
  return a.path < b.path ? -1 : 1;
}

function rewindsOf(
  entries: readonly CheckpointEntry[],
  promptSeq: number,
): readonly PathRewind[] {
  const byPath = new Map<string, CheckpointEntry[]>();
  for (const entry of entries) {
    const list = byPath.get(entry.path);
    if (list === undefined) {
      byPath.set(entry.path, [entry]);
    } else {
      list.push(entry);
    }
  }
  const rewinds: PathRewind[] = [];
  for (const [path, pathEntries] of byPath) {
    const ordered = pathEntries.toSorted((a, b) => a.order - b.order);
    const first = ordered.find((entry) => entry.promptSeq >= promptSeq);
    const last = ordered.at(-1);
    if (first === undefined || last === undefined) {
      continue;
    }
    rewinds.push({ path, target: first.before, lastAfter: last.after });
  }
  return rewinds.toSorted(comparePaths);
}

function actionFor(target: BlobRef): RestoreAction {
  if (target.kind === "missing") {
    return RestoreAction.delete;
  }
  return target.kind === "stored" ? RestoreAction.write : RestoreAction.none;
}

function planFile(
  rewind: PathRewind,
  input: PlanRestoreInput,
): RestorePlanFileView {
  const { path, target, lastAfter } = rewind;
  const action = actionFor(target);
  const current = input.current.get(path) ?? { kind: "missing" };
  if (input.isProtected(path)) {
    return { path, action, skip: RestoreSkipReason.protected };
  }
  if (target.kind === "unknown") {
    return { path, action: RestoreAction.none, skip: target.reason };
  }
  if (sameRef(current, target)) {
    return { path, action: RestoreAction.none, skip: null };
  }
  if (lastAfter.kind === "unknown") {
    return { path, action, skip: RestoreSkipReason.unverifiable };
  }
  if (!sameRef(current, lastAfter)) {
    return { path, action, skip: RestoreSkipReason.conflict };
  }
  return { path, action, skip: null };
}

export function planRestore(input: PlanRestoreInput): RestorePlanView {
  return {
    sessionId: input.sessionId,
    promptSeq: input.promptSeq,
    files: rewindsOf(input.entries, input.promptSeq).map((rewind) =>
      planFile(rewind, input),
    ),
  };
}

export function rewindTargets(
  entries: readonly CheckpointEntry[],
  promptSeq: number,
): ReadonlyMap<string, BlobRef> {
  const targets = new Map<string, BlobRef>();
  for (const rewind of rewindsOf(entries, promptSeq)) {
    targets.set(rewind.path, rewind.target);
  }
  return targets;
}
