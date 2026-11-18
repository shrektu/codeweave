import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { bundleStandInBackend } from "../fakes/bundleHelper";
import {
  collectLines,
  isAlive,
  KEEP_ALIVE_SCRIPT,
  killQuietly,
  killTreeWin32,
  makeTempDir,
  PROCESS_TEST_TIMEOUT_MS,
  stringEnv,
  WAIT_TIMEOUT_MS,
} from "../fakes/processHelpers";

const SPAWNING_ROOT_SCRIPT = `
const { spawn } = require("node:child_process");
const sleeper = spawn(process.execPath, [process.argv[2]], {
  detached: true,
  stdio: "ignore",
});
sleeper.unref();
console.log("SLEEPER=" + sleeper.pid);
${KEEP_ALIVE_SCRIPT}
`;

const ReportSchema = z.object({
  root: z.number(),
  sleeper: z.number(),
});

const trackedPids: number[] = [];
const cleanups: (() => Promise<void>)[] = [];

function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return killTreeWin32(pid);
  }
  killQuietly(pid);
  return Promise.resolve();
}

afterEach(async () => {
  await Promise.all(trackedPids.splice(0).map(killTree));
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("stand-in backend bundle", () => {
  it(
    "stand_in_backend_bundle_starts_and_reports_its_tree",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const dir = await makeTempDir();
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const rootScript = join(dir, "root.cjs");
      const sleeperScript = join(dir, "sleeper.cjs");
      await Promise.all([
        writeFile(rootScript, SPAWNING_ROOT_SCRIPT),
        writeFile(sleeperScript, KEEP_ALIVE_SCRIPT),
      ]);
      const bundle = await bundleStandInBackend();
      cleanups.push(() => bundle.dispose());
      const standIn = spawn(
        process.execPath,
        [bundle.file, rootScript, sleeperScript],
        { env: stringEnv(), cwd: dir, stdio: ["ignore", "pipe", "inherit"] },
      );
      trackedPids.push(standIn.pid ?? 0);
      const lines = collectLines(standIn.stdout);

      await vi.waitFor(
        () => {
          expect(lines).toHaveLength(1);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );

      const report = ReportSchema.parse(JSON.parse(lines[0] ?? ""));
      trackedPids.push(report.root, report.sleeper);
      expect(await isAlive(report.root)).toBe(true);
      expect(await isAlive(report.sleeper)).toBe(true);
    },
  );
});
