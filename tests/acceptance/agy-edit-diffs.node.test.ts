import { existsSync, symlinkSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGY_SNAPSHOT_DIR_ENV,
  AgyToolName,
} from "../../src/backend/agy/constants";
import type { AgentEvent, FileDiff } from "../../src/domain/events";
import { PermissionProfile } from "../../src/domain/types";
import {
  AGY_RIG_GRACE_MS,
  CLOSE_STREAMS,
  HANG,
  at,
  createAgyRig,
  delayFor,
  exitNotice,
  exitWith,
  hookStep,
  initStep,
  removeAgyRigDirs,
  resultStep,
  startAgyHandle,
  toolStep,
  userInputStep,
  writeFileStep,
  type AgyRig,
  type AgyStep,
  type ToolRef,
} from "../fakes/fakeAgy";

const CONV = "conv-1";
const SEED = "one\ntwo\nthree\n";
const EDITED_ONCE = "one\n2\nthree\n";
const EDITED_TWICE = "one\n2\n3\n";
const FIRST_EDIT_PATCH = "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three";
const SECOND_EDIT_PATCH = "@@ -1,3 +1,3 @@\n one\n 2\n-three\n+3";
const SEED_FILE = "a.txt";
const DRAIN_DELIVERY_DELAY_MS = 50;

interface UpdateWithDiffs {
  readonly toolCallId: string;
  readonly diffs: readonly FileDiff[];
}

interface EditCall {
  readonly tool: ToolRef;
  readonly path: string;
}

interface TurnOptions {
  readonly profile?: PermissionProfile;
  readonly steps: (cwd: string) => readonly AgyStep[];
}

const outsideDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAgyRigDirs();
  await Promise.all(
    outsideDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function editCall(path: string): EditCall {
  return {
    path,
    tool: {
      name: AgyToolName.editFile,
      parameters: { Path: path, Target: "two", Replacement: "2" },
    },
  };
}

function createCall(path: string, content: string): EditCall {
  return {
    path,
    tool: {
      name: AgyToolName.writeFile,
      parameters: { Path: path, Content: content },
    },
  };
}

function turnOf(...middle: readonly AgyStep[]): AgyStep[] {
  return [
    initStep(CONV),
    userInputStep(at(CONV, 0)),
    ...middle,
    resultStep(CONV, { status: "SUCCESS" }),
  ];
}

function hooked(
  index: number,
  call: EditCall,
  cwd: string,
  content: string,
): AgyStep[] {
  const ref = at(CONV, index);
  return [
    toolStep(ref, "ACTIVE", call.tool),
    hookStep(ref, call.tool, cwd),
    writeFileStep(call.path, content),
    toolStep(ref, "DONE", call.tool),
  ];
}

function seedEdits(cwd: string, ...contents: readonly string[]): AgyStep[] {
  return contents.flatMap((content, index) =>
    hooked(index + 1, editCall(join(cwd, SEED_FILE)), cwd, content),
  );
}

async function runTurn(options: TurnOptions): Promise<{
  rig: AgyRig;
  events: AgentEvent[];
}> {
  const rig = await createAgyRig();
  await writeFile(join(rig.cwd, SEED_FILE), SEED);
  rig.container.scriptTurn(options.steps(rig.cwd));
  const { handle, events } = await startAgyHandle(
    rig,
    options.profile ?? PermissionProfile.acceptEdits,
  );
  await handle.prompt("go");
  return { rig, events };
}

function diffUpdates(events: readonly AgentEvent[]): UpdateWithDiffs[] {
  return events.flatMap((event) =>
    event.type === "tool_call_update" && event.diffs !== undefined
      ? [{ toolCallId: event.toolCallId, diffs: event.diffs }]
      : [],
  );
}

function modified(patch: string): FileDiff[] {
  return [{ path: SEED_FILE, change: "modified", patch }];
}

function snapshotDirOf(rig: AgyRig): string {
  const dir = rig.container.agySpawns()[0]?.spec.env[AGY_SNAPSHOT_DIR_ENV];
  expect(dir).toBeDefined();
  return dir ?? "";
}

async function openTurn(
  profile: PermissionProfile,
  steps: (cwd: string) => readonly AgyStep[],
): Promise<{
  rig: AgyRig;
  events: AgentEvent[];
  finish: () => Promise<void>;
}> {
  const rig = await createAgyRig();
  await writeFile(join(rig.cwd, SEED_FILE), SEED);
  rig.container.scriptTurn(steps(rig.cwd));
  const { handle, events } = await startAgyHandle(rig, profile);
  const prompting = handle.prompt("go");
  return {
    rig,
    events,
    finish: async () => {
      await handle.stop(AGY_RIG_GRACE_MS);
      await prompting;
    },
  };
}

describe("agy edit diffs", () => {
  it("edit_of_existing_file_emits_modified_diff", async () => {
    const { events } = await runTurn({
      steps: (cwd) => turnOf(...seedEdits(cwd, EDITED_ONCE)),
    });

    expect(diffUpdates(events)).toEqual([
      { toolCallId: "conv-1:1", diffs: modified(FIRST_EDIT_PATCH) },
    ]);
  });

  it("write_of_new_file_emits_created_diff", async () => {
    const { events } = await runTurn({
      steps: (cwd) =>
        turnOf(
          ...hooked(
            1,
            createCall(join(cwd, "sub", "new.txt"), "first\nsecond\n"),
            cwd,
            "first\nsecond\n",
          ),
        ),
    });

    expect(diffUpdates(events)).toEqual([
      {
        toolCallId: "conv-1:1",
        diffs: [
          {
            path: "sub/new.txt",
            change: "created",
            patch: "@@ -0,0 +1,2 @@\n+first\n+second",
          },
        ],
      },
    ]);
  });
});

describe("agy edit diffs of one file", () => {
  it("diff_update_precedes_turn_end", async () => {
    const { events } = await runTurn({
      steps: (cwd) => turnOf(...seedEdits(cwd, EDITED_ONCE)),
    });

    const types = events.map((event) =>
      event.type === "tool_call_update" && event.diffs !== undefined
        ? "diff"
        : event.type,
    );
    expect(types.indexOf("diff")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("diff")).toBeLessThan(types.indexOf("turn_end"));
  });

  it("sequential_edits_of_one_file_each_get_own_diff", async () => {
    const { events } = await runTurn({
      steps: (cwd) => turnOf(...seedEdits(cwd, EDITED_ONCE, EDITED_TWICE)),
    });

    expect(diffUpdates(events)).toEqual([
      { toolCallId: "conv-1:1", diffs: modified(FIRST_EDIT_PATCH) },
      { toolCallId: "conv-1:2", diffs: modified(SECOND_EDIT_PATCH) },
    ]);
  });

  it("later_hook_snapshot_wins_over_late_after_read", async () => {
    const { events } = await runTurn({
      steps: (cwd) => {
        const call = editCall(join(cwd, SEED_FILE));
        const [first, second] = [at(CONV, 1), at(CONV, 2)];
        return turnOf(
          toolStep(first, "ACTIVE", call.tool),
          hookStep(first, call.tool, cwd),
          writeFileStep(call.path, EDITED_ONCE),
          toolStep(second, "ACTIVE", call.tool),
          hookStep(second, call.tool, cwd),
          writeFileStep(call.path, EDITED_TWICE),
          toolStep(first, "DONE", call.tool),
          toolStep(second, "DONE", call.tool),
        );
      },
    });

    expect(diffUpdates(events)).toEqual([
      { toolCallId: "conv-1:1", diffs: modified(FIRST_EDIT_PATCH) },
      { toolCallId: "conv-1:2", diffs: modified(SECOND_EDIT_PATCH) },
    ]);
  });
});

describe("agy edits that must not yield a diff", () => {
  it("failed_edit_emits_no_diff_and_removes_record", async () => {
    const { rig, events, finish } = await openTurn(
      PermissionProfile.acceptEdits,
      (cwd) => {
        const call = editCall(join(cwd, SEED_FILE));
        return [
          initStep(CONV),
          userInputStep(at(CONV, 0)),
          toolStep(at(CONV, 1), "ACTIVE", call.tool),
          hookStep(at(CONV, 1), call.tool, cwd),
          toolStep(at(CONV, 1), "ERROR", {
            ...call.tool,
            detail: { error: { type: "edit", message: "target not found" } },
          }),
          HANG,
        ];
      },
    );
    const dir = snapshotDirOf(rig);

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "tool_call_update",
        toolCallId: "conv-1:1",
        status: "failed",
        output: "target not found",
      });
    });
    await vi.waitFor(async () => {
      expect(await readdir(dir)).toEqual([]);
    });
    expect(diffUpdates(events)).toEqual([]);
    await finish();
  });

  it("denied_edit_writes_no_snapshot", async () => {
    const { rig, finish } = await openTurn(PermissionProfile.ask, (cwd) => {
      const call = editCall(join(cwd, SEED_FILE));
      return [
        initStep(CONV),
        userInputStep(at(CONV, 0)),
        toolStep(at(CONV, 1), "ACTIVE", call.tool),
        hookStep(at(CONV, 1), call.tool, cwd),
        HANG,
      ];
    });
    const dir = snapshotDirOf(rig);
    const contained = rig.container.agySpawns()[0]?.contained;

    await vi.waitFor(() => {
      expect(contained?.hookOutputs).toHaveLength(1);
    });
    expect(JSON.parse(contained?.hookOutputs[0] ?? "null")).toMatchObject({
      decision: "deny",
    });
    expect(await readdir(dir)).toEqual([]);
    await finish();
  });
});

describe("agy edits outside the worktree", () => {
  it("edit_outside_worktree_emits_no_diff", async () => {
    const outside = await mkdtemp(join(tmpdir(), "codeweave-agy-outside-"));
    outsideDirs.push(outside);
    const outsideFile = join(outside, "other.txt");
    await writeFile(outsideFile, SEED);

    const { rig, events } = await runTurn({
      profile: PermissionProfile.bypass,
      steps: (cwd) =>
        turnOf(...hooked(1, editCall(outsideFile), cwd, EDITED_ONCE)),
    });

    snapshotDirOf(rig);
    expect(await readFile(outsideFile, "utf8")).toBe(EDITED_ONCE);
    expect(diffUpdates(events)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "edit_through_symlink_resolving_outside_emits_no_diff",
    async () => {
      const outside = await mkdtemp(join(tmpdir(), "codeweave-agy-outside-"));
      outsideDirs.push(outside);
      const outsideFile = join(outside, "other.txt");
      await writeFile(outsideFile, SEED);

      const { rig, events } = await runTurn({
        steps: (cwd) => {
          const link = join(cwd, "link.txt");
          symlinkSync(outsideFile, link);
          return turnOf(...hooked(1, editCall(link), cwd, EDITED_ONCE));
        },
      });

      snapshotDirOf(rig);
      expect(await readFile(outsideFile, "utf8")).toBe(EDITED_ONCE);
      expect(diffUpdates(events)).toEqual([]);
    },
  );
});

describe("agy edit diff lifecycle", () => {
  it("snapshot_dir_removed_after_process_exit", async () => {
    const rig = await createAgyRig();
    const { handle } = await startAgyHandle(rig);
    const dir = snapshotDirOf(rig);
    expect(existsSync(dir)).toBe(true);

    await handle.stop(AGY_RIG_GRACE_MS);

    await vi.waitFor(() => {
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("leftover_records_cleared_at_turn_end", async () => {
    const { rig } = await runTurn({
      steps: (cwd) => {
        const call = editCall(join(cwd, SEED_FILE));
        return turnOf(
          toolStep(at(CONV, 1), "ACTIVE", call.tool),
          hookStep(at(CONV, 1), call.tool, cwd),
        );
      },
    });

    expect(await readdir(snapshotDirOf(rig))).toEqual([]);
  });
});

describe("agy snapshot dir cleanup", () => {
  it("failed_start_removes_snapshot_dir", async () => {
    const rig = await createAgyRig();
    const realSpawn = rig.container.spawn.bind(rig.container);
    const spawn = vi
      .spyOn(rig.container, "spawn")
      .mockImplementation((spec) =>
        spec.args[0] === "-p"
          ? realSpawn(spec)
          : Promise.reject(new Error("agy would not start")),
      );

    const result = await rig.start(PermissionProfile.ask);

    const launched = spawn.mock.calls.find(([spec]) => spec.args[0] !== "-p");
    const dir = launched?.[0].env[AGY_SNAPSHOT_DIR_ENV];
    expect(result.ok).toBe(false);
    expect(dir).toContain("codeweave-agy-snap-");
    expect(existsSync(dir ?? "")).toBe(false);
  });

  it("edit_done_drained_after_exit_still_gets_diff", async () => {
    const rig = await createAgyRig();
    await writeFile(join(rig.cwd, SEED_FILE), SEED);
    const call = editCall(join(rig.cwd, SEED_FILE));
    const ref = at(CONV, 1);
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      toolStep(ref, "ACTIVE", call.tool),
      hookStep(ref, call.tool, rig.cwd),
      writeFileStep(call.path, EDITED_ONCE),
      exitNotice(0),
      delayFor(DRAIN_DELIVERY_DELAY_MS),
      toolStep(ref, "DONE", call.tool),
      CLOSE_STREAMS,
    ]);
    const { handle, events } = await startAgyHandle(
      rig,
      PermissionProfile.acceptEdits,
    );
    const dir = snapshotDirOf(rig);

    await handle.prompt("go");

    await vi.waitFor(() => {
      expect(diffUpdates(events)).toEqual([
        { toolCallId: "conv-1:1", diffs: modified(FIRST_EDIT_PATCH) },
      ]);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("exit_with_pending_diff_cleans_snapshot_dir", async () => {
    const rig = await createAgyRig();
    await writeFile(join(rig.cwd, SEED_FILE), SEED);
    const call = editCall(join(rig.cwd, SEED_FILE));
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      ...hooked(1, call, rig.cwd, EDITED_ONCE),
      exitWith(0),
    ]);
    const { handle, events } = await startAgyHandle(
      rig,
      PermissionProfile.acceptEdits,
    );
    const dir = snapshotDirOf(rig);

    await handle.prompt("go");

    await vi.waitFor(() => {
      expect(existsSync(dir)).toBe(false);
    });
    expect(diffUpdates(events)).toEqual([
      { toolCallId: "conv-1:1", diffs: modified(FIRST_EDIT_PATCH) },
    ]);
  });
});
