import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROCESS_TEST_TIMEOUT_MS,
  makeTempDir,
  stringEnv,
} from "../../../tests/fakes/processHelpers";
import { RUN_MARKER_SEPARATOR } from "../constants";

import type { ContainerOps } from "./container";
import { confirmEmpty, spawnChild } from "./contained";
import {
  createEnvMarkerContainer,
  createProcProcessTable,
  type ProcessEntry,
} from "./marker";
import { createPsProcessTable } from "./psTable";

const LATE_PID = 4_000_000;
const GRACE_MS = 100;

async function writeProc(
  root: string,
  pid: number,
  stat: string,
  environ: string | null,
): Promise<void> {
  const directory = join(root, String(pid));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "stat"), stat);
  if (environ !== null) {
    await writeFile(join(directory, "environ"), environ);
  }
}

describe("proc process table", () => {
  it("reads_parent_pid_and_marker_and_skips_unreadable_processes", async () => {
    const root = await makeTempDir();
    await writeProc(
      root,
      100,
      "100 (my (weird) cmd) S 42 100 100 0 -1",
      "PATH=/bin\0CODEWEAVE_RUN_ID=inst:run-9\0HOME=/h\0",
    );
    await writeProc(root, 101, "101 (sh) S 100 101 101 0 -1", "PATH=/bin\0");
    await writeProc(root, 102, "102 (denied) S 1 102 102 0 -1", null);
    await mkdir(join(root, "self-not-a-pid"));

    const entries = await createProcProcessTable(root).list();

    expect(
      [...entries].sort((left, right) => left.pid - right.pid),
    ).toMatchObject([
      { pid: 100, ppid: 42, marker: "inst:run-9" },
      { pid: 101, ppid: 100, marker: null },
    ]);
  });

  it("proc_entry_identity_is_the_start_time", async () => {
    const root = await makeTempDir();
    const statWith = (pid: number, startTime: number): string =>
      `${String(pid)} (my (weird) cmd) S 42 100 100 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${String(startTime)} 1000 200`;
    await writeProc(root, 100, statWith(100, 987_654), "PATH=/bin\0");
    await writeProc(root, 101, statWith(101, 987_700), "PATH=/bin\0");

    const entries = await createProcProcessTable(root).list();

    expect(
      Object.fromEntries(entries.map((entry) => [entry.pid, entry.identity])),
    ).toEqual({ 100: "987654", 101: "987700" });
  });
});

const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0;

const UNREADABLE_MODE = 0o000;
const OWNER_STAT = "101 (daemon) S 100 101 101 0 -1";

async function writeDenied(
  root: string,
  pid: number,
  stat: string,
): Promise<void> {
  await writeProc(root, pid, stat, "SECRET=1\0");
  await chmod(join(root, String(pid), "environ"), UNREADABLE_MODE);
}

async function writeDeniedTree(): Promise<string> {
  const root = await makeTempDir();
  await writeProc(
    root,
    4_000_000,
    "4000000 (sh) S 1 1 1 0 -1",
    "CODEWEAVE_RUN_ID=inst:run-1\0",
  );
  await writeDenied(root, 4_000_001, "4000001 (daemon) S 4000000 1 1 0 -1");
  await writeProc(
    root,
    4_000_002,
    "4000002 (worker) S 4000001 1 1 0 -1",
    "PATH=/bin\0",
  );
  return root;
}

describe.runIf(canDenyRead)("proc table with unreadable environ", () => {
  it("proc_entry_with_unreadable_environ_is_listed_without_marker", async () => {
    const root = await makeTempDir();
    await writeDenied(
      root,
      101,
      `101 (daemon) S 100 101 101 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 200`,
    );

    const entries = await createProcProcessTable(root).list();

    expect(entries).toEqual([
      { pid: 101, ppid: 100, marker: null, identity: "987654" },
    ]);
  });

  it("walk_passes_through_a_process_with_unreadable_environ", async () => {
    const root = await makeTempDir();
    await writeProc(
      root,
      100,
      "100 (sh) S 1 100 100 0 -1",
      "CODEWEAVE_RUN_ID=inst:run-1\0",
    );
    await writeDenied(root, 101, OWNER_STAT);
    await writeProc(root, 102, "102 (sleep) S 101 102 102 0 -1", "PATH=/bin\0");
    const container = createEnvMarkerContainer({
      processTable: createProcProcessTable(root),
      kill: () => undefined,
      instanceId: "inst",
      selfPid: 99,
    });
    const { ops } = await container.launch(LAUNCH_SPEC, () =>
      Promise.resolve({ pid: 0, hasExited: () => false }),
    );

    expect(await ops.members()).toEqual([102, 101, 100]);
  });
});

describe.runIf(canDenyRead)("stop with unreadable environ", () => {
  it(
    "stop_reports_unreadable_root_owned_member_as_survivor_and_kills_its_children",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const root = await writeDeniedTree();
      const rootOwned = 4_000_001;
      const killed: number[] = [];
      const container = createEnvMarkerContainer({
        processTable: createProcProcessTable(root),
        kill: (pid) => {
          killed.push(pid);
          if (pid === rootOwned) {
            throw errno("EPERM");
          }
          rmSync(join(root, String(pid)), { recursive: true });
        },
        instanceId: "inst",
        selfPid: 99,
      });
      const contained = await container.spawn({
        command: "sh",
        args: ["-c", "exit 0"],
        env: stringEnv(),
        cwd: await makeTempDir(),
        runId: "run-1",
      });
      await new Promise<void>((resolve) => {
        contained.onExit(() => {
          resolve();
        });
      });

      const result = await contained.stop(GRACE_MS);

      expect(result).toMatchObject({ ok: false, survivors: [rootOwned] });
      expect(killed).toContain(4_000_002);
      expect(killed).toContain(4_000_000);
      warn.mockRestore();
    },
  );
});

describe.runIf(process.platform !== "win32")(
  "env marker container stop",
  () => {
    it(
      "stop_kills_marked_process_missed_by_first_scan",
      { timeout: PROCESS_TEST_TIMEOUT_MS },
      async () => {
        const instanceId = "inst";
        const marker = `${instanceId}${RUN_MARKER_SEPARATOR}run-1`;
        let scans = 0;
        const killed: number[] = [];
        const container = createEnvMarkerContainer({
          processTable: {
            list: () => {
              scans += 1;
              const late: ProcessEntry[] =
                scans > 1 && !killed.includes(LATE_PID)
                  ? [{ pid: LATE_PID, ppid: 1, marker }]
                  : [];
              return Promise.resolve(late);
            },
          },
          kill: (pid) => {
            killed.push(pid);
          },
          instanceId,
        });
        const contained = await container.spawn({
          command: "sh",
          args: ["-c", "sleep 0.1"],
          env: stringEnv(),
          cwd: await makeTempDir(),
          runId: "run-1",
        });
        await new Promise<void>((resolve) => {
          contained.onExit(() => {
            resolve();
          });
        });

        const result = await contained.stop(GRACE_MS);

        expect(result).toEqual({ ok: true });
        expect(killed).toContain(LATE_PID);
      },
    );
  },
);

describe.runIf(process.platform !== "win32")(
  "env marker container spawn options",
  () => {
    async function spawnOptionsFor(
      verbatim: boolean | undefined,
    ): Promise<SpawnOptionsWithoutStdio> {
      let captured: SpawnOptionsWithoutStdio = {};
      const container = createEnvMarkerContainer({
        processTable: { list: () => Promise.resolve([]) },
        kill: () => undefined,
        spawnChild: (command, args, options) => {
          captured = options;
          return spawnChild(command, args, options);
        },
      });
      const contained = await container.spawn({
        command: "sh",
        args: ["-c", "exit 0"],
        env: stringEnv(),
        cwd: await makeTempDir(),
        runId: "run-1",
        ...(verbatim === undefined
          ? {}
          : { windowsVerbatimArguments: verbatim }),
      });
      await contained.stop(GRACE_MS);
      return captured;
    }

    it("verbatim_arguments_reach_spawn_options", async () => {
      expect(await spawnOptionsFor(true)).toMatchObject({
        windowsVerbatimArguments: true,
      });
      expect(await spawnOptionsFor(undefined)).not.toHaveProperty(
        "windowsVerbatimArguments",
      );
    });
  },
);

describe("env marker container sweep", () => {
  it("sweep_kills_marked_processes_but_spares_self_and_ancestors", async () => {
    const table: ProcessEntry[] = [
      { pid: 10, ppid: 1, marker: "old:run" },
      { pid: 11, ppid: 10, marker: null },
      { pid: 20, ppid: 1, marker: "old:other" },
      { pid: 30, ppid: 40, marker: "dev:inherited" },
      { pid: 31, ppid: 30, marker: null },
      { pid: 40, ppid: 1, marker: null },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      selfPid: 31,
    });

    expect(await container.sweepOrphans(["old", "dev"])).toBe(3);

    expect(killed.sort()).toEqual([10, 11, 20]);
  });

  it("sweep_spares_backend_parent_tree", async () => {
    const table: ProcessEntry[] = [
      { pid: 500, ppid: 1, marker: "dev:shell" },
      { pid: 501, ppid: 500, marker: "dev:shell" },
      { pid: 502, ppid: 501, marker: "dev:shell" },
      { pid: 505, ppid: 500, marker: null },
      { pid: 511, ppid: 505, marker: "dev:shell" },
      { pid: 600, ppid: 1, marker: "dev:stale" },
      { pid: 601, ppid: 600, marker: "dev:stale" },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      selfPid: 505,
      parentPid: 500,
    });

    expect(await container.sweepOrphans(["dev"])).toBe(2);

    expect(killed.sort()).toEqual([600, 601]);
  });

  it("sweep_ignores_init_as_backend_parent", async () => {
    const table: ProcessEntry[] = [
      { pid: 20, ppid: 1, marker: "old:run" },
      { pid: 505, ppid: 1, marker: null },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      selfPid: 505,
      parentPid: 1,
    });

    expect(await container.sweepOrphans(["old"])).toBe(1);

    expect(killed).toEqual([20]);
  });

  it("sweep_spares_live_instance_and_own_scope", async () => {
    const table: ProcessEntry[] = [
      { pid: 10, ppid: 1, marker: "stale:run-a" },
      { pid: 11, ppid: 1, marker: "live:run-b" },
      { pid: 12, ppid: 1, marker: "mine:run-c" },
      { pid: 13, ppid: 1, marker: "stale-lookalike:run-d" },
      { pid: 14, ppid: 1, marker: "no-separator" },
      { pid: 15, ppid: 1, marker: null },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      instanceId: "mine",
      selfPid: 99,
    });

    expect(await container.sweepOrphans(["stale"])).toBe(1);

    expect(killed).toEqual([10]);
  });

  it("sweep_without_stale_instances_kills_nothing", async () => {
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: {
        list: () => Promise.resolve([{ pid: 10, ppid: 1, marker: "old:run" }]),
      },
      kill: (pid) => {
        killed.push(pid);
      },
      selfPid: 99,
    });

    expect(await container.sweepOrphans([])).toBe(0);

    expect(killed).toEqual([]);
  });
});

const LAUNCH_SPEC = {
  command: "/bin/sh",
  args: ["-l"],
  env: { TERM: "xterm-256color" },
  cwd: "/work",
  runId: "run-1",
};
const LAUNCHED_PID = 555;
const DESCENDANT_PID = 600;

function launchRig(): {
  container: ReturnType<typeof createEnvMarkerContainer>;
  killed: number[];
  state: { exited: boolean };
} {
  const killed: number[] = [];
  const state = { exited: false };
  let table: ProcessEntry[] = [
    { pid: DESCENDANT_PID, ppid: 1, marker: "inst:run-1" },
    { pid: 601, ppid: 1, marker: "inst:other-run" },
  ];
  const container = createEnvMarkerContainer({
    processTable: { list: () => Promise.resolve(table) },
    kill: (pid) => {
      killed.push(pid);
      table = table.filter((entry) => entry.pid !== pid);
      state.exited ||= pid === LAUNCHED_PID;
    },
    instanceId: "inst",
    selfPid: 99,
  });
  return { container, killed, state };
}

describe("env marker container launch", () => {
  it("launch_adds_the_run_marker_to_the_environment_of_the_launcher", async () => {
    const { container } = launchRig();
    let received: Readonly<Record<string, string>> = {};
    let verbatim: boolean | undefined;

    await container.launch(LAUNCH_SPEC, (_command, _args, options) => {
      received = options.env;
      verbatim = options.windowsVerbatimArguments;
      return Promise.resolve({ pid: LAUNCHED_PID, hasExited: () => false });
    });

    expect(received).toEqual({
      TERM: "xterm-256color",
      CODEWEAVE_RUN_ID: "inst:run-1",
    });
    expect(verbatim).toBeUndefined();
  });

  it("launch_forwards_windows_verbatim_arguments", async () => {
    const { container } = launchRig();
    let verbatim: boolean | undefined;

    await container.launch(
      { ...LAUNCH_SPEC, windowsVerbatimArguments: true },
      (_command, _args, options) => {
        verbatim = options.windowsVerbatimArguments;
        return Promise.resolve({ pid: LAUNCHED_PID, hasExited: () => false });
      },
    );

    expect(verbatim).toBe(true);
  });
});

describe("env marker container launched membership", () => {
  it("launched_process_is_a_member_until_it_has_exited", async () => {
    const { container, state } = launchRig();
    const { ops } = await container.launch(LAUNCH_SPEC, () =>
      Promise.resolve({ pid: LAUNCHED_PID, hasExited: () => state.exited }),
    );

    const running = [...(await ops.members())].sort();
    state.exited = true;
    const afterExit = await ops.members();

    expect(running).toEqual([LAUNCHED_PID, DESCENDANT_PID]);
    expect(afterExit).toEqual([DESCENDANT_PID]);
  });

  it("a_launched_process_without_a_pid_is_not_a_member", async () => {
    const { container } = launchRig();
    const { ops } = await container.launch(LAUNCH_SPEC, () =>
      Promise.resolve({ pid: 0, hasExited: () => false }),
    );

    expect(await ops.members()).toEqual([DESCENDANT_PID]);
  });

  it("kill_members_kills_the_launched_process_and_its_marked_descendants", async () => {
    const { container, killed, state } = launchRig();
    const { ops } = await container.launch(LAUNCH_SPEC, () =>
      Promise.resolve({ pid: LAUNCHED_PID, hasExited: () => state.exited }),
    );

    await ops.killMembers();

    expect([...killed].sort()).toEqual([LAUNCHED_PID, DESCENDANT_PID]);
    expect(await ops.members()).toEqual([]);
  });
});

async function launchOver(
  initial: readonly ProcessEntry[],
  launched: { pid: number; exited: boolean },
): Promise<{ ops: ContainerOps; killed: number[] }> {
  const killed: number[] = [];
  let table = [...initial];
  const container = createEnvMarkerContainer({
    processTable: { list: () => Promise.resolve(table) },
    kill: (pid) => {
      killed.push(pid);
      table = table.filter((entry) => entry.pid !== pid);
    },
    instanceId: "inst",
    selfPid: 99,
  });
  const { ops } = await container.launch(LAUNCH_SPEC, () =>
    Promise.resolve({ pid: launched.pid, hasExited: () => launched.exited }),
  );
  return { ops, killed };
}

const NO_ROOT = { pid: 0, exited: false };

describe("env marker container descendant walk", () => {
  it("members_include_unmarked_descendants_of_marker_holders", async () => {
    const { ops } = await launchOver(
      [
        { pid: 100, ppid: 1, marker: "inst:run-1" },
        { pid: 101, ppid: 100, marker: null },
        { pid: 102, ppid: 101, marker: null },
        { pid: 200, ppid: 1, marker: null },
      ],
      NO_ROOT,
    );

    expect([...(await ops.members())].sort()).toEqual([100, 101, 102]);
  });

  it("kill_order_is_leaves_first", async () => {
    const { ops, killed } = await launchOver(
      [
        { pid: 100, ppid: 1, marker: "inst:run-1" },
        { pid: 101, ppid: 100, marker: null },
        { pid: 102, ppid: 101, marker: null },
        { pid: 103, ppid: 100, marker: null },
      ],
      NO_ROOT,
    );

    await ops.killMembers();

    expect(killed.indexOf(102)).toBeLessThan(killed.indexOf(101));
    expect(killed.indexOf(101)).toBeLessThan(killed.indexOf(100));
    expect(killed.indexOf(103)).toBeLessThan(killed.indexOf(100));
    expect(killed.at(-1)).toBe(100);
  });

  it("exited_root_is_not_walked_for_descendants", async () => {
    const { ops } = await launchOver(
      [
        { pid: 555, ppid: 1, marker: null },
        { pid: 601, ppid: 555, marker: null },
      ],
      { pid: 555, exited: true },
    );

    expect(await ops.members()).toEqual([]);
  });
});

describe("env marker container walk edge cases", () => {
  it("live_root_missing_from_table_is_still_a_member", async () => {
    const { ops } = await launchOver([{ pid: 601, ppid: 555, marker: null }], {
      pid: 555,
      exited: false,
    });

    expect(await ops.members()).toEqual([601, 555]);
  });

  it("cyclic_or_self_parent_entries_do_not_loop", async () => {
    const { ops } = await launchOver(
      [
        { pid: 70, ppid: 70, marker: "inst:run-1" },
        { pid: 80, ppid: 81, marker: null },
        { pid: 81, ppid: 80, marker: "inst:run-1" },
      ],
      NO_ROOT,
    );

    expect([...(await ops.members())].sort()).toEqual([70, 80, 81]);
  });

  it("ps_failure_keeps_container_not_empty", async () => {
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.reject(new Error("ps failed")) },
      kill: () => undefined,
      instanceId: "inst",
      selfPid: 99,
    });
    const { ops } = await container.launch(LAUNCH_SPEC, () =>
      Promise.resolve({ pid: LAUNCHED_PID, hasExited: () => false }),
    );

    expect(await confirmEmpty(ops)).toMatchObject({ ok: false });
  });
});

describe("env marker container sweep descendants", () => {
  it("sweep_kills_descendants_of_stale_marker_holders_leaves_first", async () => {
    const table: ProcessEntry[] = [
      { pid: 10, ppid: 1, marker: "old:a" },
      { pid: 11, ppid: 10, marker: null },
      { pid: 12, ppid: 11, marker: null },
      { pid: 20, ppid: 1, marker: null },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      instanceId: "mine",
      selfPid: 99,
    });

    expect(await container.sweepOrphans(["old"])).toBe(3);

    expect(killed).toEqual([12, 11, 10]);
  });

  it("sweep_still_spares_self_ancestors_and_parent_tree", async () => {
    const table: ProcessEntry[] = [
      { pid: 30, ppid: 1, marker: "old:x" },
      { pid: 31, ppid: 30, marker: null },
      { pid: 32, ppid: 31, marker: null },
      { pid: 33, ppid: 30, marker: null },
      { pid: 40, ppid: 1, marker: "old:y" },
      { pid: 41, ppid: 40, marker: null },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      instanceId: "mine",
      selfPid: 32,
      parentPid: 1,
    });

    expect(await container.sweepOrphans(["old"])).toBe(2);

    expect(killed).toEqual([41, 40]);
  });
});

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

interface MutableRig {
  readonly ops: ContainerOps;
  readonly killed: number[];
  readonly setTable: (next: readonly ProcessEntry[]) => void;
}

async function mutableRig(
  initial: readonly ProcessEntry[],
  denied: readonly number[] = [],
  failure = "EPERM",
): Promise<MutableRig> {
  const killed: number[] = [];
  let table = [...initial];
  const container = createEnvMarkerContainer({
    processTable: { list: () => Promise.resolve(table) },
    kill: (pid) => {
      killed.push(pid);
      if (denied.includes(pid)) {
        throw errno(failure);
      }
      table = table.filter((entry) => entry.pid !== pid);
    },
    instanceId: "inst",
    selfPid: 99,
  });
  const { ops } = await container.launch(LAUNCH_SPEC, () =>
    Promise.resolve({ pid: 0, hasExited: () => false }),
  );
  return {
    ops,
    killed,
    setTable: (next) => {
      table = [...next];
    },
  };
}

const REMEMBERED_ROOT: ProcessEntry = {
  pid: 100,
  ppid: 1,
  marker: "inst:run-1",
  identity: "root-a",
};
const REMEMBERED_CHILD: ProcessEntry = {
  pid: 101,
  ppid: 100,
  marker: null,
  identity: "child-a",
};

describe("env marker container remembered members", () => {
  it("remembered_member_survives_reparenting", async () => {
    const { ops, setTable } = await mutableRig([
      REMEMBERED_ROOT,
      REMEMBERED_CHILD,
    ]);

    const before = await ops.members();
    setTable([{ ...REMEMBERED_CHILD, ppid: 1 }]);
    const after = await ops.members();

    expect(before).toEqual([101, 100]);
    expect(after).toEqual([101]);
  });

  it("remembered_member_survives_exec_with_ps_identity", async () => {
    const startedAt = "Tue Nov 17 16:08:43 2026";
    let output = [
      `100 1 ${startedAt} sh CODEWEAVE_RUN_ID=inst:run-1`,
      `101 100 ${startedAt} sh -c sleep 0.1; exec long-job`,
    ].join("\n");
    const container = createEnvMarkerContainer({
      processTable: createPsProcessTable(() => Promise.resolve(output)),
      kill: () => undefined,
      instanceId: "inst",
      selfPid: 99,
    });
    const { ops } = await container.launch(LAUNCH_SPEC, () =>
      Promise.resolve({ pid: 0, hasExited: () => false }),
    );
    await ops.members();

    output = `101 1 ${startedAt} long-job --flag HOME=/h`;

    expect(await ops.members()).toEqual([101]);
  });

  it("before_stop_seeds_remembered_members", async () => {
    const { ops, setTable } = await mutableRig([
      REMEMBERED_ROOT,
      REMEMBERED_CHILD,
    ]);

    await ops.beforeStop?.();
    setTable([{ ...REMEMBERED_CHILD, ppid: 1 }]);

    expect(await ops.members()).toEqual([101]);
  });

  it("remembered_pid_with_changed_identity_is_forgotten", async () => {
    const { ops, setTable } = await mutableRig([
      REMEMBERED_ROOT,
      REMEMBERED_CHILD,
    ]);
    await ops.members();

    setTable([{ ...REMEMBERED_CHILD, ppid: 1, identity: "reused-pid" }]);

    expect(await ops.members()).toEqual([]);
  });

  it("remembered_pid_missing_from_table_is_forgotten", async () => {
    const { ops, setTable } = await mutableRig([
      REMEMBERED_ROOT,
      REMEMBERED_CHILD,
    ]);
    await ops.members();

    setTable([]);
    expect(await ops.members()).toEqual([]);
    setTable([{ ...REMEMBERED_CHILD, ppid: 1 }]);

    expect(await ops.members()).toEqual([]);
  });
});

describe("env marker container denied kills", () => {
  const TREE: ProcessEntry[] = [
    { pid: 10, ppid: 1, marker: "old:a" },
    { pid: 11, ppid: 10, marker: null },
    { pid: 12, ppid: 11, marker: null },
  ];

  it("kill_round_continues_past_a_denied_kill", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rig = await mutableRig(
      [
        { pid: 100, ppid: 1, marker: "inst:run-1" },
        { pid: 101, ppid: 100, marker: null },
      ],
      [101],
    );

    await rig.ops.killMembers();

    expect(rig.killed.slice(0, 2)).toEqual([101, 100]);
    expect(await rig.ops.members()).toEqual([101]);
    expect(String(warn.mock.calls[0]?.join(" "))).toContain("101");
    warn.mockRestore();
  });

  it("sweep_continues_past_a_denied_kill_and_counts_only_signalled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(TREE) },
      kill: (pid) => {
        killed.push(pid);
        if (pid === 12) {
          throw errno("EPERM");
        }
      },
      instanceId: "mine",
      selfPid: 99,
    });

    expect(await container.sweepOrphans(["old"])).toBe(2);

    expect(killed).toEqual([12, 11, 10]);
    warn.mockRestore();
  });

  it("unexpected_kill_error_still_throws", async () => {
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(TREE) },
      kill: () => {
        throw errno("EIO");
      },
      instanceId: "mine",
      selfPid: 99,
    });
    const rig = await mutableRig(
      [{ pid: 100, ppid: 1, marker: "inst:run-1" }],
      [100],
      "EIO",
    );

    await expect(container.sweepOrphans(["old"])).rejects.toThrow("EIO");
    await expect(rig.ops.killMembers()).rejects.toThrow("EIO");
  });
});

describe.runIf(process.platform !== "win32")("denied kill during stop", () => {
  it(
    "stop_kills_other_members_and_reports_the_denied_one_as_survivor",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const rootOwned = 4_000_001;
      const other = 4_000_002;
      let table: ProcessEntry[] = [
        { pid: 4_000_000, ppid: 1, marker: "inst:run-1" },
        { pid: rootOwned, ppid: 4_000_000, marker: null },
        { pid: other, ppid: 1, marker: "inst:run-1" },
      ];
      const killed: number[] = [];
      const container = createEnvMarkerContainer({
        processTable: { list: () => Promise.resolve(table) },
        kill: (pid) => {
          killed.push(pid);
          if (pid === rootOwned) {
            throw errno("EPERM");
          }
          table = table.filter((entry) => entry.pid !== pid);
        },
        instanceId: "inst",
        selfPid: 99,
      });
      const contained = await container.spawn({
        command: "sh",
        args: ["-c", "exit 0"],
        env: stringEnv(),
        cwd: await makeTempDir(),
        runId: "run-1",
      });
      await new Promise<void>((resolve) => {
        contained.onExit(() => {
          resolve();
        });
      });

      const result = await contained.stop(GRACE_MS);

      expect(result).toMatchObject({ ok: false, survivors: [rootOwned] });
      expect(killed).toContain(4_000_000);
      expect(killed).toContain(other);
      warn.mockRestore();
    },
  );
});
