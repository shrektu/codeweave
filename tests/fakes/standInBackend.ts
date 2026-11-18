import { createInterface } from "node:readline";

import { createProcessContainer } from "../../src/backend/process/select";

import { stringEnv } from "./processHelpers";

const SLEEPER_PATTERN = /^SLEEPER=(\d+)$/;
const RUN_ID = "run-stand-in";
const ROOT_ARG_INDEX = 2;
const SLEEPER_ARG_INDEX = 3;
const IDLE_INTERVAL_MS = 1000;

async function main(): Promise<void> {
  const rootScript = process.argv[ROOT_ARG_INDEX];
  const sleeperScript = process.argv[SLEEPER_ARG_INDEX];
  if (rootScript === undefined || sleeperScript === undefined) {
    throw new Error("usage: standInBackend <rootScript> <sleeperScript>");
  }
  const container = await createProcessContainer(process.platform);
  const contained = await container.spawn({
    command: process.execPath,
    args: [rootScript, sleeperScript],
    env: stringEnv(),
    cwd: process.cwd(),
    runId: RUN_ID,
  });
  createInterface({ input: contained.stdout }).on("line", (line) => {
    const sleeper = SLEEPER_PATTERN.exec(line)?.[1];
    if (sleeper !== undefined) {
      console.log(
        JSON.stringify({ root: contained.pid, sleeper: Number(sleeper) }),
      );
    }
  });
  setInterval(() => undefined, IDLE_INTERVAL_MS);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
