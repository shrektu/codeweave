import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSnapshots,
  discardStepSnapshot,
  laterSnapshotOf,
  recordName,
  snapshotTargets,
  takeStepSnapshot,
  writeStepSnapshot,
  type StepSnapshotRequest,
} from "./snapshots";

const drive = vi.hoisted(() => ({ alias: "", real: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const resolved = (path: string): string =>
    drive.alias !== "" && path.startsWith(drive.alias)
      ? `${drive.real}${path.slice(drive.alias.length)}`
      : path;
  return {
    ...actual,
    lstat: (path: string) => actual.lstat(resolved(path)),
    realpath: (path: string) => actual.realpath(resolved(path)),
  };
});

const CONV = "conv-1";
const FILE = "a.txt";

let root = "";
let outside = "";
let snapDir = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agy-snap-root-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "agy-snap-out-")));
  snapDir = await mkdtemp(join(tmpdir(), "agy-snap-dir-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  drive.alias = "";
  drive.real = "";
  await Promise.all(
    [root, outside, snapDir].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

function requestFor(
  stepIdx: number,
  paths: readonly string[],
  conversationId = CONV,
): StepSnapshotRequest {
  return {
    dir: snapDir,
    conversationId,
    stepIdx,
    paths,
    worktreeRoot: root,
  };
}

describe("agy step snapshot records", () => {
  it("record_round_trips_and_take_deletes", async () => {
    const path = join(root, FILE);
    await writeFile(path, "hi\n");

    await writeStepSnapshot(requestFor(3, [path]));

    expect(await readdir(snapDir)).toEqual(["conv-1~3.json"]);
    expect(await takeStepSnapshot(snapDir, CONV, 3)).toEqual({
      entries: [{ path, snapshot: { kind: "text", text: "hi\n" } }],
    });
    expect(await readdir(snapDir)).toEqual([]);
    expect(await takeStepSnapshot(snapDir, CONV, 3)).toBeNull();
  });

  it("unsafe_conversation_id_is_not_written", async () => {
    const path = join(root, FILE);
    await writeFile(path, "hi\n");

    await writeStepSnapshot(requestFor(1, [path], "../evil"));

    expect(recordName("../evil", 1)).toBeNull();
    expect(recordName("a~b", 1)).toBeNull();
    expect(await readdir(snapDir)).toEqual([]);
    expect(await takeStepSnapshot(snapDir, "../evil", 1)).toBeNull();
  });

  it("corrupt_record_is_null_and_removed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(join(snapDir, "conv-1~1.json"), "{not json");
    await writeFile(join(snapDir, "conv-1~2.json"), '{"entries":[{"path":1}]}');

    expect(await takeStepSnapshot(snapDir, CONV, 1)).toBeNull();
    expect(await takeStepSnapshot(snapDir, CONV, 2)).toBeNull();
    expect(await readdir(snapDir)).toEqual([]);
  });

  it("clear_removes_only_records", async () => {
    await writeFile(join(snapDir, "conv-1~1.json"), "{}");
    await writeFile(join(snapDir, "conv-2~7.json"), "{}");
    await writeFile(join(snapDir, "keep.txt"), "x");

    await clearSnapshots(snapDir);

    expect(await readdir(snapDir)).toEqual(["keep.txt"]);
  });

  it("discard_removes_one_record", async () => {
    const path = join(root, FILE);
    await writeFile(path, "hi\n");
    await writeStepSnapshot(requestFor(1, [path]));
    await writeStepSnapshot(requestFor(2, [path]));

    await discardStepSnapshot(snapDir, CONV, 1);

    expect(await readdir(snapDir)).toEqual(["conv-1~2.json"]);
  });
});

describe("agy later step snapshots", () => {
  it("later_snapshot_picks_earliest_later_step_with_path", async () => {
    const path = join(root, FILE);
    const other = join(root, "b.txt");
    await writeFile(other, "other\n");
    await writeFile(path, "v1\n");
    await writeStepSnapshot(requestFor(1, [path]));
    await writeFile(path, "v2\n");
    await writeStepSnapshot(requestFor(2, [other]));
    await writeStepSnapshot(requestFor(3, [path]));
    await writeFile(path, "v3\n");
    await writeStepSnapshot(requestFor(4, [path]));
    await writeStepSnapshot(requestFor(3, [path], "conv-2"));

    expect(await laterSnapshotOf(snapDir, CONV, 1, path)).toEqual({
      kind: "text",
      text: "v2\n",
    });
    expect(await laterSnapshotOf(snapDir, CONV, 3, path)).toEqual({
      kind: "text",
      text: "v3\n",
    });
    expect(await laterSnapshotOf(snapDir, CONV, 4, path)).toBeNull();
    expect(await readdir(snapDir)).toHaveLength(5);
  });

  it("later_snapshot_is_null_for_a_missing_dir", async () => {
    await rm(snapDir, { recursive: true, force: true });

    expect(
      await laterSnapshotOf(snapDir, CONV, 1, join(root, FILE)),
    ).toBeNull();
  });
});

describe("agy snapshot targets", () => {
  it("new_file_in_new_subdir_is_included", async () => {
    const path = join(root, "new", "deep", "f.txt");

    expect(await snapshotTargets([path], root)).toEqual([path]);
    await writeStepSnapshot(requestFor(1, [path]));
    expect(await takeStepSnapshot(snapDir, CONV, 1)).toEqual({
      entries: [{ path, snapshot: { kind: "missing" } }],
    });
  });

  it("path_outside_worktree_is_skipped", async () => {
    const targets = await snapshotTargets(
      [join(outside, FILE), join(root, "..", "x.txt"), root],
      root,
    );

    expect(targets).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "symlink_resolving_outside_is_skipped",
    async () => {
      await writeFile(join(outside, "secret.txt"), "s\n");
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
      await symlink(outside, join(root, "linkdir"));

      const targets = await snapshotTargets(
        [join(root, "link.txt"), join(root, "linkdir", "secret.txt")],
        root,
      );

      expect(targets).toEqual([]);
    },
  );

  it("aliased_worktree_root_keeps_targets_confined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    drive.alias = join(tmpdir(), "agy-snap-alias-drive");
    drive.real = root;
    await writeFile(join(root, FILE), "x\n");
    const existing = join(drive.alias, FILE);
    const created = join(drive.alias, "new", "f.txt");

    const targets = await snapshotTargets(
      [existing, created, join(outside, FILE), join(drive.alias, "..", "x")],
      drive.alias,
    );

    expect(targets).toEqual([existing, created]);
  });

  it.skipIf(process.platform === "win32")(
    "dangling_symlink_inside_worktree_is_skipped",
    async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await symlink(join(root, "gone.txt"), join(root, "dangling.txt"));

      expect(await snapshotTargets([join(root, "dangling.txt")], root)).toEqual(
        [],
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "symlink_resolving_inside_is_kept_and_root_behind_symlink_works",
    async () => {
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real", FILE), "x\n");
      await symlink(join(root, "real", FILE), join(root, "inner.txt"));
      const rootLink = join(outside, "root-link");
      await symlink(root, rootLink);

      expect(await snapshotTargets([join(root, "inner.txt")], root)).toEqual([
        join(root, "inner.txt"),
      ]);
      expect(await snapshotTargets([join(rootLink, FILE)], rootLink)).toEqual([
        join(rootLink, FILE),
      ]);
    },
  );
});
