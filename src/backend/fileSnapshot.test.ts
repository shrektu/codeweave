import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DIFF_MAX_FILE_BYTES } from "./constants";
import { readFileSnapshot, readStampedSnapshot } from "./fileSnapshot";

const FIFO_DEADLINE_MS = 2000;
const SHORT_READ_BYTES = 4;

const fsHooks = vi.hoisted(() => ({
  stat: undefined as ((path: string) => Promise<unknown>) | undefined,
  open: undefined as
    ((path: string, flags: number) => Promise<unknown>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: string, options?: { readonly bigint?: boolean }) =>
      fsHooks.stat === undefined
        ? actual.stat(path, options)
        : fsHooks.stat(path),
    open: (path: string, flags: number): Promise<unknown> =>
      fsHooks.open === undefined
        ? actual.open(path, flags)
        : fsHooks.open(path, flags),
  };
});

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snapshot-"));
});

afterEach(async () => {
  fsHooks.stat = undefined;
  fsHooks.open = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function shortReadHandle(path: string, flags: number): Promise<unknown> {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const handle = await actual.open(path, flags);
  return {
    read: (buffer: Buffer, offset: number, length: number, position: number) =>
      handle.read(buffer, offset, Math.min(length, SHORT_READ_BYTES), position),
    stat: () => handle.stat(),
    close: () => handle.close(),
  };
}

async function releaseFifoReader(fifo: string): Promise<void> {
  try {
    const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    await writer.close();
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENXIO"
    )) {
      throw error;
    }
  }
}

it("path_swapped_to_fifo_after_check_does_not_block", async () => {
  if (process.platform === "win32") {
    return;
  }
  const regular = join(dir, "regular.txt");
  const fifo = join(dir, "pipe");
  await writeFile(regular, "x");
  execFileSync("mkfifo", [fifo]);
  const regularStats = await stat(regular);
  fsHooks.stat = () => Promise.resolve(regularStats);

  const result = await Promise.race([
    readFileSnapshot(fifo),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, FIFO_DEADLINE_MS),
    ),
  ]);
  await releaseFifoReader(fifo);

  expect(result).toEqual({ kind: "binary" });
});

it("path_deleted_after_check_is_missing", async () => {
  const regular = join(dir, "regular.txt");
  await writeFile(regular, "x");
  const regularStats = await stat(regular);
  fsHooks.stat = () => Promise.resolve(regularStats);

  expect(await readFileSnapshot(join(dir, "gone.txt"))).toEqual({
    kind: "missing",
  });
});

it("short_reads_are_completed", async () => {
  const content = "first line\nsecond line\nthird line\n";
  await writeFile(join(dir, "short.txt"), content);
  fsHooks.open = shortReadHandle;

  expect(await readFileSnapshot(join(dir, "short.txt"))).toEqual({
    kind: "text",
    text: content,
  });
});

it("missing_file_is_missing", async () => {
  expect(await readFileSnapshot(join(dir, "nope.txt"))).toEqual({
    kind: "missing",
  });
});

it("path_below_a_file_is_missing", async () => {
  await writeFile(join(dir, "plain.txt"), "x");

  expect(await readFileSnapshot(join(dir, "plain.txt", "child"))).toEqual({
    kind: "missing",
  });
});

it("empty_file_is_empty_text", async () => {
  await writeFile(join(dir, "empty.txt"), "");

  expect(await readFileSnapshot(join(dir, "empty.txt"))).toEqual({
    kind: "text",
    text: "",
  });
});

it("exactly_max_bytes_is_text", async () => {
  await writeFile(join(dir, "max.txt"), "a".repeat(DIFF_MAX_FILE_BYTES));

  const snapshot = await readFileSnapshot(join(dir, "max.txt"));

  expect(snapshot.kind).toBe("text");
});

it("one_byte_over_max_is_too_large", async () => {
  await writeFile(join(dir, "big.txt"), "a".repeat(DIFF_MAX_FILE_BYTES + 1));

  expect(await readFileSnapshot(join(dir, "big.txt"))).toEqual({
    kind: "too_large",
  });
});

it("nul_byte_is_binary", async () => {
  await writeFile(join(dir, "nul.bin"), Buffer.from([0x61, 0x00, 0x62]));

  expect(await readFileSnapshot(join(dir, "nul.bin"))).toEqual({
    kind: "binary",
  });
});

it("invalid_utf8_is_binary", async () => {
  await writeFile(join(dir, "bad.txt"), Buffer.from([0x61, 0xff, 0xfe]));

  expect(await readFileSnapshot(join(dir, "bad.txt"))).toEqual({
    kind: "binary",
  });
});

it("directory_is_binary", async () => {
  await mkdir(join(dir, "sub"));

  expect(await readFileSnapshot(join(dir, "sub"))).toEqual({
    kind: "binary",
  });
});

it.skipIf(process.platform === "win32")("fifo_path_is_not_read", async () => {
  const fifo = join(dir, "pipe");
  execFileSync("mkfifo", [fifo]);

  const snapshot = await Promise.race([
    readFileSnapshot(fifo),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, FIFO_DEADLINE_MS),
    ),
  ]);

  expect(snapshot).toEqual({ kind: "binary" });
});

it("crlf_and_missing_newline_round_trip", async () => {
  await writeFile(join(dir, "crlf.txt"), "one\r\ntwo\r\nthree");

  expect(await readFileSnapshot(join(dir, "crlf.txt"))).toEqual({
    kind: "text",
    text: "one\r\ntwo\r\nthree",
  });
});

it("bom_is_preserved", async () => {
  await writeFile(join(dir, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));

  expect(await readFileSnapshot(join(dir, "bom.txt"))).toEqual({
    kind: "text",
    text: "﻿a",
  });
});

it("stamp_describes_the_read_file", async () => {
  const file = join(dir, "stamped.txt");
  await writeFile(file, "stamped\n");
  const stats = await stat(file, { bigint: true });

  const { stamp } = await readStampedSnapshot(file);

  expect(stamp).toEqual({
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  });
});

it("write_between_stat_and_read_gives_no_stamp", async () => {
  const file = join(dir, "swapped.txt");
  await writeFile(file, "before\n");
  let statCalls = 0;
  fsHooks.open = async (path: string, flags: number) => {
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const handle = await actual.open(path, flags);
    return {
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => handle.read(buffer, offset, length, position),
      stat: async () => {
        const stats = await handle.stat({ bigint: true });
        statCalls += 1;
        if (statCalls === 1) {
          await writeFile(file, "after\n");
        }
        return stats;
      },
      close: () => handle.close(),
    };
  };

  const { snapshot, stamp } = await readStampedSnapshot(file);

  expect(stamp).toBeUndefined();
  expect(snapshot).toEqual({ kind: "text", text: "after\n" });
});
