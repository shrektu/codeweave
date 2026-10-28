import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../../../tests/fakes/processHelpers";

import { createContained, spawnChild, type ContainerOps } from "./contained";

const LATE_PID = 4_000_000;
const GRACE_MS = 100;
const SECOND_KILL_PASS = 2;

describe.runIf(process.platform !== "win32")("contained stop", () => {
  it(
    "stop_kills_member_that_appears_after_first_kill_pass",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const child = await spawnChild("sh", ["-c", "sleep 0.1"], {});
      await once(child, "exit");
      let killPasses = 0;
      const ops: ContainerOps = {
        members: () =>
          Promise.resolve(
            killPasses === SECOND_KILL_PASS - 1 ? [LATE_PID] : [],
          ),
        killMembers: () => {
          killPasses += 1;
          return Promise.resolve();
        },
      };
      const contained = createContained(child, "run-1", ops);

      const result = await contained.stop(GRACE_MS);

      expect(result).toEqual({ ok: true });
      expect(killPasses).toBeGreaterThanOrEqual(SECOND_KILL_PASS);
    },
  );
});
