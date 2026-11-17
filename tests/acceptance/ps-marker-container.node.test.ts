import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RUN_ID_ENV, RUN_MARKER_SEPARATOR } from "../../src/backend/constants";
import type { Contained } from "../../src/backend/process/container";
import { ContainerKind } from "../../src/backend/process/container";
import { createEnvMarkerContainer } from "../../src/backend/process/marker";
import { createPsProcessTable } from "../../src/backend/process/psTable";
import { createProcessContainer } from "../../src/backend/process/select";
import { createPtyLauncher } from "../../src/backend/terminal/pty";
import {
  collectLines,
  isAlive,
  killQuietly,
  KEEP_ALIVE_SCRIPT,
  makeTempDir,
  nodeArgs,
  PROCESS_TEST_TIMEOUT_MS,
  SLEEP_SECONDS,
  SPAWN_SETSID_SLEEPER_SCRIPT,
  stringEnv,
  WAIT_TIMEOUT_MS,
} from "../fakes/processHelpers";

const GRACE_MS = 100;
const PTY_COLS = 100;
const PTY_ROWS = 30;
const ROOT_PREFIX = "ROOT=";
const SLEEPER_PREFIX = "SLEEPER=";
const CHILD_PATTERN = /CHILD=(\d+)/;
const RUN_MARKER_PATTERN = /^[0-9a-f-]+:run-[0-9a-f-]+$/;
const SCRUBBED_CHILD_SCRIPT = `
const { spawn } = require("node:child_process");
const env = { ...process.env };
delete env.${RUN_ID_ENV};
const child = spawn("sleep", ["${SLEEP_SECONDS}"], { env, stdio: "ignore" });
console.log(child.pid);
${KEEP_ALIVE_SCRIPT}
`;
const IGNORE_SIGTERM_SCRIPT = 'process.on("SIGTERM", () => {});';
const NOISY_ENV_NAME = "CODEWEAVE_TEST_NOISE";
const NOISY_ENV_VALUE = "a\nb c\nd";
const SLOW_TERM_EXIT_MS = 1000;
const EXEC_DELAY_SECONDS = "0.5";
const LONG_GRACE_MS = 5000;
const EXEC_LATER_CHILD_SCRIPT = `
const { spawn } = require("node:child_process");
const env = { ...process.env };
delete env.${RUN_ID_ENV};
const child = spawn("sh", ["-c", "sleep ${EXEC_DELAY_SECONDS}; exec sleep ${SLEEP_SECONDS}"], { env, stdio: "ignore" });
console.log(child.pid);
process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${String(SLOW_TERM_EXIT_MS)}));
${KEEP_ALIVE_SCRIPT}
`;
const trackedPids: number[] = [];

afterEach(() => {
  for (const pid of trackedPids.splice(0)) {
    killQuietly(pid);
  }
});

function newContainer(
  instanceId?: string,
): ReturnType<typeof createEnvMarkerContainer> {
  return createEnvMarkerContainer({
    processTable: createPsProcessTable(),
    kill: (pid, signal) => process.kill(pid, signal),
    ...(instanceId === undefined ? {} : { instanceId }),
  });
}

async function startRun(
  script: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ contained: Contained; exited: Promise<void>; lines: string[] }> {
  const contained = await newContainer().spawn({
    command: process.execPath,
    args: nodeArgs(script),
    env: { ...stringEnv(), ...extraEnv },
    cwd: await makeTempDir(),
    runId: `run-${randomUUID()}`,
  });
  trackedPids.push(contained.pid);
  const exited = new Promise<void>((resolve) => {
    contained.onExit(() => {
      resolve();
    });
  });
  return { contained, exited, lines: collectLines(contained.stdout) };
}

async function readTracked(lines: string[], index: number): Promise<number> {
  await vi.waitFor(
    () => {
      expect(lines.length).toBeGreaterThan(index);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  const pid = Number(lines[index]);
  trackedPids.push(pid);
  return pid;
}

it("darwin_selects_marker_container", async () => {
  const probe = vi.fn(() => Promise.resolve(true));

  const container = await createProcessContainer("darwin", probe, "inst1");

  expect(container.kind).toBe(ContainerKind.envMarker);
  expect(probe).not.toHaveBeenCalled();
});

describe.runIf(process.platform !== "win32")("ps table container", () => {
  it(
    "stop_kills_detached_grandchild_via_ps_table",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { contained, lines } = await startRun(
        `${SPAWN_SETSID_SLEEPER_SCRIPT}${KEEP_ALIVE_SCRIPT}`,
      );
      const sleeper = await readTracked(lines, 0);
      expect(await isAlive(sleeper)).toBe(true);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(await isAlive(sleeper)).toBe(false);
    },
  );

  it(
    "stop_kills_orphan_whose_parent_exited",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { contained, exited, lines } = await startRun(
        SPAWN_SETSID_SLEEPER_SCRIPT,
      );
      const sleeper = await readTracked(lines, 0);
      await exited;
      expect(await isAlive(sleeper)).toBe(true);
      expect(await contained.isEmpty()).toBe(false);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(await isAlive(sleeper)).toBe(false);
      expect(await contained.isEmpty()).toBe(true);
    },
  );

  it(
    "stop_kills_unmarked_descendant_of_a_member",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { contained, lines } = await startRun(
        `${IGNORE_SIGTERM_SCRIPT}${SCRUBBED_CHILD_SCRIPT}`,
      );
      const child = await readTracked(lines, 0);
      expect(await isAlive(child)).toBe(true);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(await isAlive(child)).toBe(false);
    },
  );

  it(
    "stop_kills_unmarked_descendant_after_root_dies_on_sigterm",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { contained, lines } = await startRun(SCRUBBED_CHILD_SCRIPT);
      const child = await readTracked(lines, 0);
      expect(await isAlive(child)).toBe(true);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(await isAlive(child)).toBe(false);
    },
  );

  it(
    "marker_is_found_after_an_env_value_with_newlines",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { contained } = await startRun(KEEP_ALIVE_SCRIPT, {
        [NOISY_ENV_NAME]: NOISY_ENV_VALUE,
      });

      const table = await createPsProcessTable().list();

      const root = table.find((entry) => entry.pid === contained.pid);
      expect(root?.marker).toMatch(RUN_MARKER_PATTERN);
      expect(await contained.stop(GRACE_MS)).toEqual({ ok: true });
      expect(await contained.isEmpty()).toBe(true);
    },
  );

  it(
    "stop_kills_unmarked_descendant_that_execs_after_the_snapshot",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { contained, lines } = await startRun(EXEC_LATER_CHILD_SCRIPT);
      const child = await readTracked(lines, 0);
      expect(await isAlive(child)).toBe(true);

      const result = await contained.stop(LONG_GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(await isAlive(child)).toBe(false);
    },
  );
});

describe.runIf(process.platform !== "win32")("ps table pty launch", () => {
  it(
    "pty_launch_is_contained_via_ps_table",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { process: shell, ops } = await newContainer().launch(
        {
          command: "/bin/sh",
          args: [
            "-c",
            `nohup sleep ${SLEEP_SECONDS} >/dev/null 2>&1 & echo CHILD=$!; wait`,
          ],
          env: stringEnv(),
          cwd: await makeTempDir(),
          runId: `run-${randomUUID()}`,
        },
        createPtyLauncher({ cols: PTY_COLS, rows: PTY_ROWS }),
      );
      trackedPids.push(shell.pid);
      const chunks: string[] = [];
      shell.onData((data) => {
        chunks.push(data);
      });
      await vi.waitFor(
        () => {
          expect(chunks.join("")).toMatch(CHILD_PATTERN);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const sleeper = Number(CHILD_PATTERN.exec(chunks.join(""))?.[1]);
      trackedPids.push(sleeper);
      expect(await isAlive(sleeper)).toBe(true);

      await ops.killMembers();

      expect(await isAlive(sleeper)).toBe(false);
      await vi.waitFor(
        async () => {
          expect(await isAlive(shell.pid)).toBe(false);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      expect(await ops.members()).toEqual([]);
    },
  );
});

async function crashBackend(
  staleId: string,
): Promise<{ root: number; sleeper: number }> {
  const marker = `${staleId}${RUN_MARKER_SEPARATOR}run-1`;
  const rootScript = `console.log("${ROOT_PREFIX}" + process.pid);${SPAWN_SETSID_SLEEPER_SCRIPT.replace(
    "console.log(sleeper.pid)",
    `console.log("${SLEEPER_PREFIX}" + sleeper.pid)`,
  )}${KEEP_ALIVE_SCRIPT}`;
  const standIn = spawn(
    process.execPath,
    nodeArgs(`
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(rootScript)}], {
  env: { ...process.env, ${RUN_ID_ENV}: ${JSON.stringify(marker)} },
  stdio: ["ignore", "inherit", "inherit"],
});
${KEEP_ALIVE_SCRIPT}
`),
    { env: stringEnv(), stdio: ["ignore", "pipe", "inherit"] },
  );
  trackedPids.push(standIn.pid ?? 0);
  const lines = collectLines(standIn.stdout);
  await vi.waitFor(
    () => {
      expect(lines).toHaveLength(2);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  const pidOf = (prefix: string): number =>
    Number(lines.find((line) => line.startsWith(prefix))?.slice(prefix.length));
  const tree = { root: pidOf(ROOT_PREFIX), sleeper: pidOf(SLEEPER_PREFIX) };
  trackedPids.push(tree.root, tree.sleeper);
  standIn.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    standIn.once("exit", () => {
      resolve();
    });
  });
  return tree;
}

describe.runIf(process.platform !== "win32")("ps table orphan sweep", () => {
  it(
    "sweep_kills_tree_left_by_crashed_backend",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const staleId = randomUUID().replaceAll("-", "");
      const { root, sleeper } = await crashBackend(staleId);
      expect(await isAlive(root)).toBe(true);
      expect(await isAlive(sleeper)).toBe(true);

      const swept = await newContainer(`fresh${staleId}`).sweepOrphans([
        staleId,
      ]);

      expect(swept).toBe(2);
      expect(await isAlive(root)).toBe(false);
      expect(await isAlive(sleeper)).toBe(false);
    },
  );
});
