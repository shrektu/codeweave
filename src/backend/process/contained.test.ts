import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../../../tests/fakes/processHelpers";

import { createContained, spawnChild } from "./contained";
import type { ContainerOps, StopResult } from "./container";

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

describe.runIf(process.platform !== "win32")("contained stop order", () => {
  async function stopWith(
    beforeStop: (() => Promise<void>) | undefined,
  ): Promise<{ events: string[]; result: StopResult }> {
    const child = await spawnChild("sleep", ["30"], {});
    const events: string[] = [];
    vi.spyOn(child, "kill").mockImplementation((signal) => {
      events.push(`kill:${String(signal)}`);
      return true;
    });
    const ops: ContainerOps = {
      members: () => {
        events.push("members");
        return Promise.resolve([]);
      },
      killMembers: () => Promise.resolve(),
      ...(beforeStop === undefined
        ? {}
        : {
            beforeStop: () => {
              events.push("beforeStop");
              return beforeStop();
            },
          }),
    };
    try {
      const result = await createContained(child, "run-1", ops).stop(GRACE_MS);
      return { events, result };
    } finally {
      process.kill(child.pid ?? 0, "SIGKILL");
    }
  }

  it(
    "stop_calls_before_stop_and_not_members_before_sigterm",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { events, result } = await stopWith(() => Promise.resolve());

      expect(events.slice(0, 2)).toEqual(["beforeStop", "kill:SIGTERM"]);
      expect(result).toEqual({ ok: true });
    },
  );

  it(
    "stop_without_before_stop_sends_sigterm_at_once",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const { events, result } = await stopWith(undefined);

      expect(events[0]).toBe("kill:SIGTERM");
      expect(result).toEqual({ ok: true });
    },
  );

  it(
    "stop_continues_when_before_stop_fails",
    { timeout: PROCESS_TEST_TIMEOUT_MS },
    async () => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const { events, result } = await stopWith(() =>
        Promise.reject(new Error("ps failed")),
      );

      expect(events.slice(0, 2)).toEqual(["beforeStop", "kill:SIGTERM"]);
      expect(result).toEqual({ ok: true });
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    },
  );
});
