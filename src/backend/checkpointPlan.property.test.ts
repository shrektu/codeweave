import * as fc from "fast-check";
import { expect, it } from "vitest";

import { RestoreAction } from "../domain/checkpoints";

import {
  planRestore,
  type BlobRef,
  type CheckpointEntry,
} from "./checkpointPlan";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PATHS = ["/repo/a.txt", "/repo/b.txt", "/repo/c.txt"] as const;
const MAX_PROMPT = 4;
const RUNS = 150;
const HASH_PREFIX = "content:";

interface Edit {
  readonly path: string;
  readonly prompt: number;
  readonly text: string | null;
  readonly index: number;
}

interface Simulation {
  readonly entries: readonly CheckpointEntry[];
  readonly finalDisk: ReadonlyMap<string, string | null>;
  readonly contents: ReadonlyMap<string, string>;
  readonly ordered: readonly Edit[];
}

const pathArb = fc.constantFrom(...PATHS);
const editArb = fc.record({
  path: pathArb,
  prompt: fc.integer({ min: 1, max: MAX_PROMPT }),
  text: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
});
const editsArb = fc.array(editArb, { minLength: 1, maxLength: 12 });
const promptArb = fc.integer({ min: 1, max: MAX_PROMPT });

function orderedEdits(edits: readonly Omit<Edit, "index">[]): readonly Edit[] {
  return edits
    .map((edit, index) => ({ ...edit, index }))
    .toSorted((a, b) => a.prompt - b.prompt || a.index - b.index);
}

function refOf(text: string | null, contents: Map<string, string>): BlobRef {
  if (text === null) {
    return { kind: "missing" };
  }
  const hash = `${HASH_PREFIX}${text}`;
  contents.set(hash, text);
  return { kind: "stored", hash, bytes: Buffer.byteLength(text, "utf8") };
}

function simulate(ordered: readonly Edit[]): Simulation {
  const disk = new Map<string, string | null>(
    PATHS.map((path): [string, string | null] => [path, null]),
  );
  const contents = new Map<string, string>();
  const entries: CheckpointEntry[] = [];
  for (const [order, edit] of ordered.entries()) {
    const before = refOf(disk.get(edit.path) ?? null, contents);
    const after = refOf(edit.text, contents);
    entries.push({
      editKey: `e-${String(order)}`,
      promptSeq: edit.prompt,
      path: edit.path,
      before,
      after,
      order,
    });
    disk.set(edit.path, edit.text);
  }
  return { entries, finalDisk: disk, contents, ordered };
}

function diskAtPromptStart(
  ordered: readonly Edit[],
  promptSeq: number,
): ReadonlyMap<string, string | null> {
  const disk = new Map<string, string | null>(
    PATHS.map((path): [string, string | null] => [path, null]),
  );
  for (const edit of ordered) {
    if (edit.prompt < promptSeq) {
      disk.set(edit.path, edit.text);
    }
  }
  return disk;
}

function targetsOf(
  entries: readonly CheckpointEntry[],
  promptSeq: number,
): ReadonlyMap<string, BlobRef> {
  const targets = new Map<string, BlobRef>();
  for (const entry of entries.toSorted((a, b) => a.order - b.order)) {
    if (entry.promptSeq < promptSeq || targets.has(entry.path)) {
      continue;
    }
    targets.set(entry.path, entry.before);
  }
  return targets;
}

function applyPlan(
  simulation: Simulation,
  promptSeq: number,
): ReadonlyMap<string, string | null> {
  const current = new Map<string, BlobRef>(
    PATHS.map((path) => [
      path,
      refOf(simulation.finalDisk.get(path) ?? null, new Map()),
    ]),
  );
  const plan = planRestore({
    sessionId: SESSION_ID,
    promptSeq,
    entries: simulation.entries,
    current,
    isProtected: () => false,
  });
  const targets = targetsOf(simulation.entries, promptSeq);
  const result = new Map(simulation.finalDisk);
  for (const file of plan.files) {
    if (file.skip !== null) {
      throw new Error(`unexpected skip ${file.skip} for ${file.path}`);
    }
    if (file.action === RestoreAction.delete) {
      result.set(file.path, null);
    }
    if (file.action === RestoreAction.write) {
      const target = targets.get(file.path);
      if (target?.kind !== "stored") {
        throw new Error(`no stored target for ${file.path}`);
      }
      result.set(file.path, simulation.contents.get(target.hash) ?? null);
    }
  }
  return result;
}

it("planning a rewind reproduces the disk state at the start of the prompt", () => {
  fc.assert(
    fc.property(editsArb, promptArb, (edits, promptSeq) => {
      const simulation = simulate(orderedEdits(edits));

      expect(applyPlan(simulation, promptSeq)).toEqual(
        diskAtPromptStart(simulation.ordered, promptSeq),
      );
    }),
    { numRuns: RUNS },
  );
});
