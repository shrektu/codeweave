import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROCESS_TEST_TIMEOUT_MS,
  makeTempDir,
  stringEnv,
} from "../../../tests/fakes/processHelpers";
import { RUN_MARKER_SEPARATOR } from "../constants";

import {
  createEnvMarkerContainer,
  createProcProcessTable,
  type ProcessEntry,
} from "./marker";

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

    expect([...entries].sort((left, right) => left.pid - right.pid)).toEqual([
      { pid: 100, ppid: 42, marker: "inst:run-9" },
      { pid: 101, ppid: 100, marker: null },
    ]);
  });
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

    expect(await container.sweepOrphans(["old", "dev"])).toBe(2);

    expect(killed.sort()).toEqual([10, 20]);
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
