import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RUN_ID_ENV } from "../../src/backend/constants";
import {
  childLauncher,
  spawnChild,
  type ChildHandle,
} from "../../src/backend/process/contained";
import type {
  Contained,
  ContainerOps,
  Launched,
  ProcessContainer,
  SpawnSpec,
} from "../../src/backend/process/container";
import { newInstanceId } from "../../src/backend/instance";
import {
  loadJobApi,
  type JobApi,
  type JobHandle,
} from "../../src/backend/process/jobApi";
import { createJobObjectContainer } from "../../src/backend/process/windows";
import {
  createPtyLauncher,
  type PtyProcess,
} from "../../src/backend/terminal/pty";
import { bundleStandInBackend } from "../fakes/bundleHelper";
import {
  collectLines,
  isAlive,
  killTreeWin32,
  makeTempDir,
  PROCESS_TEST_TIMEOUT_MS,
  stringEnv,
  WAIT_TIMEOUT_MS,
} from "../fakes/processHelpers";

const execFileAsync = promisify(execFile);

const GRACE_MS = 1000;
const PTY_COLS = 100;
const PTY_ROWS = 30;
const TINY_PID_LIST_CAPACITY = 1;
const SLEEPER_COUNT = 2;
const SLEEPER_PATTERN = /^SLEEPER=(\d+)$/;
const SLEEPER_OUTPUT_PATTERN = /SLEEPER=(\d+)[\r\n]/;
const TEST_TIMEOUT_FACTOR = 3;
const TEST_TIMEOUT_MS = PROCESS_TEST_TIMEOUT_MS * TEST_TIMEOUT_FACTOR;
const DEFAULT_COMMAND_INTERPRETER = "cmd.exe";
const MARKER_SCRIPT = `console.log(process.env.${RUN_ID_ENV});\n`;
const MIDDLE_EXITED_LINE = "MIDDLE_EXITED";

const PTY_OUTPUT_TIMEOUT_MS = WAIT_TIMEOUT_MS * TEST_TIMEOUT_FACTOR;
const PTY_ROOT_SCRIPT = `
const { spawn } = require("node:child_process");
const sleeper = spawn(process.execPath, [process.argv[1]], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
sleeper.unref();
console.log("SLEEPER=" + sleeper.pid);
setInterval(() => {}, 1000);
`;
const SLEEPER_SCRIPT = "setInterval(() => {}, 1000);\n";
const DETACHED_ROOT_SCRIPT = `
const { spawn } = require("node:child_process");
const count = Number(process.argv[3] ?? "1");
for (let index = 0; index < count; index += 1) {
  const sleeper = spawn(process.execPath, [process.argv[2]], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  sleeper.unref();
  console.log("SLEEPER=" + sleeper.pid);
}
setInterval(() => {}, 1000);
`;
const MIDDLE_SCRIPT = `
const { spawn } = require("node:child_process");
const sleeper = spawn(process.execPath, [process.argv[2]], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
sleeper.unref();
console.log("SLEEPER=" + sleeper.pid);
`;
const ORPHAN_ROOT_SCRIPT = `
const { spawn } = require("node:child_process");
const middle = spawn(process.execPath, [process.argv[2], process.argv[3]], {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
middle.on("exit", () => console.log("${MIDDLE_EXITED_LINE}"));
setInterval(() => {}, 1000);
`;

const StandInReportSchema = z.object({
  root: z.number(),
  sleeper: z.number(),
});

interface Scripts {
  readonly dir: string;
  readonly sleeper: string;
  readonly detachedRoot: string;
  readonly middle: string;
  readonly orphanRoot: string;
  readonly marker: string;
}

const trackedPids: number[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(trackedPids.splice(0).map(killTreeWin32));
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function writeScripts(): Promise<Scripts> {
  const dir = await makeTempDir();
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const scripts: Scripts = {
    dir,
    sleeper: join(dir, "sleeper.cjs"),
    detachedRoot: join(dir, "detachedRoot.cjs"),
    middle: join(dir, "middle.cjs"),
    orphanRoot: join(dir, "orphanRoot.cjs"),
    marker: join(dir, "marker.cjs"),
  };
  await Promise.all([
    writeFile(scripts.sleeper, SLEEPER_SCRIPT),
    writeFile(scripts.detachedRoot, DETACHED_ROOT_SCRIPT),
    writeFile(scripts.middle, MIDDLE_SCRIPT),
    writeFile(scripts.orphanRoot, ORPHAN_ROOT_SCRIPT),
    writeFile(scripts.marker, MARKER_SCRIPT),
  ]);
  return scripts;
}

async function newContainer(
  pidListCapacity?: number,
  instanceId: string = newInstanceId(),
): Promise<ProcessContainer> {
  const api = await loadJobApi(
    pidListCapacity === undefined ? {} : { pidListCapacity },
  );
  return createJobObjectContainer({ api, instanceId });
}

function specFor(
  scripts: Scripts,
  script: string,
  args: readonly string[],
): SpawnSpec {
  return {
    command: process.execPath,
    args: [script, ...args],
    env: stringEnv(),
    cwd: scripts.dir,
    runId: `run-${randomUUID()}`,
  };
}

function sleeperPidsIn(lines: readonly string[]): number[] {
  return lines.flatMap((line) => {
    const pid = SLEEPER_PATTERN.exec(line)?.[1];
    return pid === undefined ? [] : [Number(pid)];
  });
}

async function waitForSleepers(
  lines: readonly string[],
  count: number,
): Promise<number[]> {
  await vi.waitFor(
    () => {
      expect(sleeperPidsIn(lines)).toHaveLength(count);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  const pids = sleeperPidsIn(lines);
  trackedPids.push(...pids);
  return pids;
}

async function waitForLine(
  lines: readonly string[],
  expected: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(lines).toContain(expected);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
}

async function waitUntilGone(pids: readonly number[]): Promise<void> {
  await vi.waitFor(
    async () => {
      const alive = await Promise.all(pids.map((pid) => isAlive(pid)));
      expect(alive).toEqual(pids.map(() => false));
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
}

async function spawnTree(
  container: ProcessContainer,
  spec: SpawnSpec,
): Promise<{ contained: Contained; lines: string[] }> {
  const contained = await container.spawn(spec);
  trackedPids.push(contained.pid);
  return { contained, lines: collectLines(contained.stdout) };
}

async function launchTree(
  container: ProcessContainer,
  spec: SpawnSpec,
): Promise<{ launched: Launched<ChildHandle>; lines: string[] }> {
  const launched = await container.launch(spec, childLauncher(spawnChild));
  trackedPids.push(launched.process.pid);
  return { launched, lines: collectLines(launched.process.child.stdout) };
}

describe.runIf(process.platform === "win32")("win32 stop", () => {
  it(
    "stop_kills_detached_grandchild",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const container = await newContainer();
      const { contained, lines } = await spawnTree(
        container,
        specFor(scripts, scripts.detachedRoot, [scripts.sleeper]),
      );
      const [sleeper = 0] = await waitForSleepers(lines, 1);
      expect(await isAlive(sleeper)).toBe(true);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      await waitUntilGone([sleeper, contained.pid]);
    },
  );

  it(
    "stop_kills_grandchild_whose_parent_exited",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const container = await newContainer();
      const { contained, lines } = await spawnTree(
        container,
        specFor(scripts, scripts.orphanRoot, [scripts.middle, scripts.sleeper]),
      );
      const [sleeper = 0] = await waitForSleepers(lines, 1);
      await waitForLine(lines, MIDDLE_EXITED_LINE);
      expect(await isAlive(sleeper)).toBe(true);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      await waitUntilGone([sleeper, contained.pid]);
    },
  );
});

async function launchPtyTree(
  container: ProcessContainer,
  scripts: Scripts,
): Promise<{ pty: PtyProcess; ops: ContainerOps; sleeper: number }> {
  const { process: pty, ops } = await container.launch(
    {
      command: process.execPath,
      args: ["-e", PTY_ROOT_SCRIPT, scripts.sleeper],
      env: stringEnv(),
      cwd: scripts.dir,
      runId: `run-${randomUUID()}`,
    },
    createPtyLauncher({ cols: PTY_COLS, rows: PTY_ROWS }),
  );
  trackedPids.push(pty.pid);
  const chunks: string[] = [];
  pty.onData((data) => {
    chunks.push(data);
  });
  await vi.waitFor(
    () => {
      expect(chunks.join("")).toMatch(SLEEPER_OUTPUT_PATTERN);
    },
    { timeout: PTY_OUTPUT_TIMEOUT_MS },
  );
  const sleeper = Number(SLEEPER_OUTPUT_PATTERN.exec(chunks.join(""))?.[1]);
  trackedPids.push(sleeper);
  return { pty, ops, sleeper };
}

function closeRecordingApi(real: JobApi, closed: JobHandle[]): JobApi {
  return {
    createJob: () => real.createJob(),
    assignPid: (job, pid) => real.assignPid(job, pid),
    assignSelf: (job) => {
      real.assignSelf(job);
    },
    pids: (job) => real.pids(job),
    terminate: (job) => {
      real.terminate(job);
    },
    close: (job) => {
      closed.push(job);
      real.close(job);
    },
  };
}

describe.runIf(process.platform === "win32")("win32 pty", () => {
  it("pty_launch_is_contained", { timeout: TEST_TIMEOUT_MS }, async () => {
    const scripts = await writeScripts();
    const container = await newContainer();
    const { pty, ops, sleeper } = await launchPtyTree(container, scripts);
    expect(await isAlive(sleeper)).toBe(true);

    await ops.killMembers();

    await waitUntilGone([sleeper, pty.pid]);
    await vi.waitFor(
      async () => {
        expect(await ops.members()).toEqual([]);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });

  it(
    "pty_stop_closes_the_job_handle",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const closed: JobHandle[] = [];
      const container = createJobObjectContainer({
        api: closeRecordingApi(await loadJobApi(), closed),
        instanceId: newInstanceId(),
      });
      const { ops } = await launchPtyTree(container, scripts);

      await ops.killMembers();
      await vi.waitFor(
        async () => {
          expect(await ops.members()).toEqual([]);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      await ops.members();
      await ops.killMembers();

      expect(closed).toHaveLength(1);
    },
  );
});

async function readStandInReport(
  lines: readonly string[],
): Promise<z.infer<typeof StandInReportSchema>> {
  await vi.waitFor(
    () => {
      expect(lines).toHaveLength(1);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  return StandInReportSchema.parse(JSON.parse(lines[0] ?? ""));
}

describe.runIf(process.platform === "win32")("win32 backend crash", () => {
  it(
    "backend_crash_kills_tree_without_sweep",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const bundle = await bundleStandInBackend();
      cleanups.push(() => bundle.dispose());
      const standIn = spawn(
        process.execPath,
        [bundle.file, scripts.detachedRoot, scripts.sleeper],
        {
          env: stringEnv(),
          cwd: scripts.dir,
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      trackedPids.push(standIn.pid ?? 0);
      const report = await readStandInReport(collectLines(standIn.stdout));
      trackedPids.push(report.root, report.sleeper);
      expect(await isAlive(report.root)).toBe(true);
      expect(await isAlive(report.sleeper)).toBe(true);

      const exited = once(standIn, "exit");
      await execFileAsync("taskkill", ["/F", "/PID", String(standIn.pid)]);
      await exited;

      await waitUntilGone([report.root, report.sleeper]);
    },
  );
});

describe.runIf(process.platform === "win32")("win32 membership", () => {
  it(
    "job_lists_every_process_of_the_tree",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const container = await newContainer();
      const { launched, lines } = await launchTree(
        container,
        specFor(scripts, scripts.detachedRoot, [scripts.sleeper]),
      );
      const [sleeper = 0] = await waitForSleepers(lines, 1);

      await vi.waitFor(
        async () => {
          expect(await launched.ops.members()).toEqual(
            expect.arrayContaining([launched.process.pid, sleeper]),
          );
        },
        { timeout: WAIT_TIMEOUT_MS },
      );

      await launched.ops.killMembers();
    },
  );

  it(
    "real_pid_list_grows_past_initial_capacity",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const container = await newContainer(TINY_PID_LIST_CAPACITY);
      const { launched, lines } = await launchTree(
        container,
        specFor(scripts, scripts.detachedRoot, [
          scripts.sleeper,
          String(SLEEPER_COUNT),
        ]),
      );
      const sleepers = await waitForSleepers(lines, SLEEPER_COUNT);

      await vi.waitFor(
        async () => {
          expect(await launched.ops.members()).toEqual(
            expect.arrayContaining([launched.process.pid, ...sleepers]),
          );
        },
        { timeout: WAIT_TIMEOUT_MS },
      );

      await launched.ops.killMembers();
    },
  );
});

describe.runIf(process.platform === "win32")("win32 launch edge cases", () => {
  it(
    "launch_of_instantly_exiting_command_resolves_with_an_empty_container",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const container = await newContainer();

      const launched = await container.launch(
        {
          command: process.env.ComSpec ?? DEFAULT_COMMAND_INTERPRETER,
          args: ["/c", "exit", "0"],
          env: stringEnv(),
          cwd: scripts.dir,
          runId: `run-${randomUUID()}`,
        },
        childLauncher(spawnChild),
      );
      trackedPids.push(launched.process.pid);

      await vi.waitFor(
        async () => {
          expect(await launched.ops.members()).toEqual([]);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
    },
  );

  it(
    "contained_shell_sees_the_run_marker",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scripts = await writeScripts();
      const instanceId = newInstanceId();
      const container = await newContainer(undefined, instanceId);
      const spec = specFor(scripts, scripts.marker, []);

      const { launched, lines } = await launchTree(container, spec);

      await vi.waitFor(
        () => {
          expect(lines).toEqual([`${instanceId}:${spec.runId}`]);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      await launched.ops.killMembers();
    },
  );
});
