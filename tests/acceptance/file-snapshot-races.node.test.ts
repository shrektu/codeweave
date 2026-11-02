import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { computeFileDiff } from "../../src/backend/fileDiff";
import { readFileSnapshot } from "../../src/backend/fileSnapshot";

const DEADLINE_MS = 2000;
const CHUNK_BYTES = 3;
const PATH = "src/app.ts";

const raceHooks = vi.hoisted(() => ({
  stat: undefined as ((path: string) => Promise<unknown>) | undefined,
  chunk: undefined as number | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: string): Promise<unknown> =>
      raceHooks.stat === undefined ? actual.stat(path) : raceHooks.stat(path),
    open: async (path: string, flags: number): Promise<unknown> => {
      const handle = await actual.open(path, flags);
      const chunk = raceHooks.chunk;
      if (chunk === undefined) {
        return handle;
      }
      return {
        read: (b: Buffer, o: number, l: number, p: number) =>
          handle.read(b, o, Math.min(l, chunk), p),
        stat: () => handle.stat(),
        close: () => handle.close(),
      };
    },
  };
});

async function releaseFifoReader(fifo: string): Promise<void> {
  try {
    const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    await writer.close();
  } catch (error) {
    const noReader = error instanceof Error && "code" in error;
    if (!noReader || error.code !== "ENXIO") {
      throw error;
    }
  }
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snapshot-races-"));
});

afterEach(async () => {
  raceHooks.stat = undefined;
  raceHooks.chunk = undefined;
  await rm(dir, { recursive: true, force: true });
});

it("fifo_swapped_in_after_check_yields_binary_omission", async () => {
  if (process.platform === "win32") {
    return;
  }
  const target = join(dir, "app.ts");
  await writeFile(target, "old\n");
  const before = await readFileSnapshot(target);
  const regularStats = await stat(target);
  await rm(target);
  execFileSync("mkfifo", [target]);
  raceHooks.stat = () => Promise.resolve(regularStats);

  const after = await Promise.race([
    readFileSnapshot(target),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, DEADLINE_MS),
    ),
  ]);
  await releaseFifoReader(target);

  expect(after).not.toBe("timeout");
  if (after === "timeout") {
    return;
  }
  expect(computeFileDiff(PATH, before, after)).toEqual({
    path: PATH,
    change: "modified",
    omitted: "binary",
  });
});

it("file_deleted_after_check_yields_deleted_patch", async () => {
  const target = join(dir, "app.ts");
  await writeFile(target, "old\n");
  const before = await readFileSnapshot(target);
  const regularStats = await stat(target);
  await rm(target);
  raceHooks.stat = () => Promise.resolve(regularStats);

  const after = await readFileSnapshot(target);

  expect(computeFileDiff(PATH, before, after)).toEqual({
    path: PATH,
    change: "deleted",
    patch: "@@ -1,1 +0,0 @@\n-old",
  });
});

it("short_reads_still_yield_the_full_created_patch", async () => {
  const target = join(dir, "app.ts");
  await writeFile(target, "alpha\nbeta\ngamma\n");
  raceHooks.chunk = CHUNK_BYTES;

  const after = await readFileSnapshot(target);

  expect(computeFileDiff(PATH, { kind: "missing" }, after)).toEqual({
    path: PATH,
    change: "created",
    patch: "@@ -0,0 +1,3 @@\n+alpha\n+beta\n+gamma",
  });
});
