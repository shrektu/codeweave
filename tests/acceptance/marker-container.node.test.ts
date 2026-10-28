import { afterEach, describe, expect, it, vi } from "vitest";

import { recordInstance } from "../../src/backend/instance";
import { ContainerKind } from "../../src/backend/process/container";
import {
  createEnvMarkerContainer,
  createProcProcessTable,
  type ProcessEntry,
} from "../../src/backend/process/marker";
import { createProcessContainer } from "../../src/backend/process/select";
import {
  isRunning,
  killQuietly,
  makeTempDir,
  PROCESS_TEST_TIMEOUT_MS,
  stringEnv,
  WAIT_TIMEOUT_MS,
} from "../fakes/processHelpers";

const GRACE_MS = 100;
const REPARENT_SCRIPT = "setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $!";
const trackedPids: number[] = [];

afterEach(() => {
  for (const pid of trackedPids.splice(0)) {
    killQuietly(pid);
  }
});

describe.runIf(process.platform === "linux")("env marker container", () => {
  it(
    "marker_container_kills_reparented_grandchild",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const container = createEnvMarkerContainer({
        processTable: createProcProcessTable(),
        kill: (pid, signal) => process.kill(pid, signal),
      });
      const contained = await container.spawn({
        command: "sh",
        args: ["-c", REPARENT_SCRIPT],
        env: stringEnv(),
        cwd: await makeTempDir(),
        runId: "marker-run",
      });
      const chunks: string[] = [];
      contained.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk.toString());
      });
      const exited = new Promise<void>((resolve) => {
        contained.onExit(() => {
          resolve();
        });
      });
      await exited;
      await vi.waitFor(
        () => {
          expect(chunks.join("").trim()).not.toBe("");
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const grandchild = Number(chunks.join("").trim());
      trackedPids.push(grandchild);
      expect(await isRunning(grandchild)).toBe(true);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(await isRunning(grandchild)).toBe(false);
      expect(await contained.isEmpty()).toBe(true);
    },
  );

  it("sweep_spares_live_instance_and_own_scope", async () => {
    const table: ProcessEntry[] = [
      { pid: 101, ppid: 1, marker: "dead0:run-1" },
      { pid: 102, ppid: 1, marker: "alive1:run-2" },
      { pid: 103, ppid: 1, marker: "self2:run-3" },
      { pid: 104, ppid: 103, marker: null },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      instanceId: "self2",
      selfPid: 104,
    });

    expect(await container.sweepOrphans(["dead0", "self2"])).toBe(1);

    expect(killed).toEqual([101]);
  });

  it("sweep_spares_backend_parent_tree", async () => {
    const table: ProcessEntry[] = [
      { pid: 301, ppid: 1, marker: "stale3:shell" },
      { pid: 302, ppid: 301, marker: "stale3:shell" },
      { pid: 303, ppid: 301, marker: "stale3:shell" },
      { pid: 304, ppid: 302, marker: null },
      { pid: 305, ppid: 304, marker: "stale3:shell" },
      { pid: 306, ppid: 1, marker: "stale3:orphan" },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      instanceId: "fresh4",
      selfPid: 304,
      parentPid: 301,
    });

    expect(await container.sweepOrphans(["stale3"])).toBe(1);

    expect(killed).toEqual([306]);
  });

  it("restart_sweeps_only_the_instance_recorded_before_it", async () => {
    const dir = await makeTempDir();
    const dead = await recordInstance(dir);
    const restarted = await recordInstance(dir);
    const table: ProcessEntry[] = [
      { pid: 201, ppid: 1, marker: `${dead.current}:run-1` },
      { pid: 202, ppid: 1, marker: "otheruserdata:run-2" },
      { pid: 203, ppid: 1, marker: `${restarted.current}:run-3` },
    ];
    const killed: number[] = [];
    const container = createEnvMarkerContainer({
      processTable: { list: () => Promise.resolve(table) },
      kill: (pid) => {
        killed.push(pid);
      },
      instanceId: restarted.current,
      selfPid: 999,
    });

    expect(await container.sweepOrphans(restarted.previous)).toBe(1);

    expect(killed).toEqual([201]);
  });

  it("linux_uses_marker_container_without_systemd_user", async () => {
    const container = await createProcessContainer("linux", () =>
      Promise.resolve(false),
    );

    expect(container.kind).toBe(ContainerKind.envMarker);
  });
});
