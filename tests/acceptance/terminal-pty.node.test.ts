import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProcessContainer } from "../../src/backend/process/container";
import { createProcessContainer } from "../../src/backend/process/select";
import { createPtyLauncher } from "../../src/backend/terminal/pty";
import {
  createTerminalService,
  type TerminalService,
} from "../../src/backend/terminal/service";
import { createShellDetector } from "../../src/backend/terminal/shell";
import { TerminalViewSchema } from "../../src/shared/views";
import {
  isRunning,
  PROCESS_TEST_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
} from "../fakes/processHelpers";
import { resolvePathLockKey } from "../fakes/rigProcesses";

const DataPayloadSchema = z.looseObject({ data: z.string() });
const COLS = 100;
const ROWS = 30;
const ENTER = "\r";
const EXIT_CODE = 7;
const PORTABLE_COMMAND =
  process.platform === "win32"
    ? 'Write-Output ("cw-" + "ok")'
    : "printf 'cw-%s\\n' ok";
const BACKGROUND_PID_PATTERN = /CHILD=(\d+)/;
const FORCE_ENV_MARKER_CONTAINER = (): Promise<boolean> =>
  Promise.resolve(false);

interface Harness {
  readonly service: TerminalService;
  readonly output: () => string;
  readonly changes: () => unknown[];
  readonly cwd: string;
}

const services: TerminalService[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true })),
  );
});

async function createHarness(
  container: ProcessContainer | null,
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "cw-pty-"));
  folders.push(cwd);
  const chunks: string[] = [];
  const changes: unknown[] = [];
  const service = createTerminalService({
    container,
    launcher: createPtyLauncher,
    broadcast: (event, payload) => {
      if (event === "terminal/data") {
        chunks.push(DataPayloadSchema.parse(payload).data);
      }
      if (event === "terminal/changed") {
        changes.push(payload);
      }
    },
    readShellSetting: () => Promise.resolve(null),
    detectShell: createShellDetector(process.platform, process.env),
    platform: process.platform,
    parentEnv: process.env,
    resolveLockKey: resolvePathLockKey,
    newRunId: () => randomUUID(),
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
  });
  services.push(service);
  return {
    service,
    output: () => chunks.join(""),
    changes: () => changes,
    cwd,
  };
}

async function openTerminal(harness: Harness): Promise<string> {
  const { terminal } = await harness.service.open({
    cwd: harness.cwd,
    cols: COLS,
    rows: ROWS,
  });
  return terminal.id;
}

async function containerFor(
  kind: "native" | "marker",
): Promise<ProcessContainer | null> {
  if (process.platform !== "linux") {
    return null;
  }
  return createProcessContainer(
    process.platform,
    kind === "marker" ? FORCE_ENV_MARKER_CONTAINER : undefined,
  );
}

it(
  "real_shell_runs_a_command_and_reports_its_exit_code",
  { timeout: PROCESS_TEST_TIMEOUT_MS },
  async () => {
    const harness = await createHarness(await containerFor("native"));
    const id = await openTerminal(harness);

    harness.service.input(id, `${PORTABLE_COMMAND}${ENTER}`);
    await vi.waitFor(
      () => {
        expect(harness.output()).toContain("cw-ok");
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    harness.service.input(id, `exit ${String(EXIT_CODE)}${ENTER}`);
    await vi.waitFor(
      () => {
        expect(harness.changes().at(-1)).toMatchObject({
          status: "exited",
          exitCode: EXIT_CODE,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    expect(TerminalViewSchema.parse(harness.changes().at(-1)).exitCode).toBe(
      EXIT_CODE,
    );
  },
);

describe.runIf(process.platform === "linux")("background children", () => {
  it.each(["native", "marker"] as const)(
    "background_child_of_the_shell_is_gone_after_close_in_%s_container",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async (kind) => {
      const harness = await createHarness(await containerFor(kind));
      const id = await openTerminal(harness);

      harness.service.input(
        id,
        `nohup sleep 300 >/dev/null 2>&1 & echo CHILD=$!${ENTER}`,
      );
      await vi.waitFor(
        () => {
          expect(harness.output()).toMatch(BACKGROUND_PID_PATTERN);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const pid = Number(BACKGROUND_PID_PATTERN.exec(harness.output())?.[1]);
      const aliveBeforeClose = await isRunning(pid);

      await harness.service.close(id);

      expect(aliveBeforeClose).toBe(true);
      await vi.waitFor(
        async () => {
          expect(await isRunning(pid)).toBe(false);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
    },
  );
});
