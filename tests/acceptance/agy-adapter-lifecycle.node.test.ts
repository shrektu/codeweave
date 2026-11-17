import { afterEach, describe, expect, it } from "vitest";

import type { StopResult } from "../../src/backend/process/container";
import type { AgentEvent } from "../../src/domain/events";
import { settlesWithin } from "../fakes/fakeCodexAppServer";
import { PermissionProfile } from "../../src/domain/types";
import {
  AGY_RIG_GRACE_MS,
  QUOTA_ERROR_TEXT,
  at,
  agyErrorStep,
  createAgyRig,
  delayFor,
  errorMessageStep,
  exitWith,
  initStep,
  removeAgyRigDirs,
  replyTurn,
  resultStep,
  responseDoneStep,
  startAgyHandle,
  textDeltaStep,
  usageBucket,
  usageGroup,
  userInputStep,
  type AgyRig,
} from "../fakes/fakeAgy";

const CONV = "conv-1";
const OTHER_CONV = "conv-2";
const LATE_ERROR_DELAY_MS = 30;
const STOPPED_CLEANLY_READ = 2;
const SETTLE_BOUND_MS = 40;
const EXHAUSTED_GROUPS = [
  usageGroup("Gemini Models", [
    usageBucket("gemini-weekly", "weekly", 0, "2026-11-02T10:21:22Z"),
    usageBucket("gemini-5h", "5h", 0, "2026-10-30T12:54:36Z"),
  ]),
];
const MODEL_FAILED = "The model request failed";
const NEW_QUOTA_SUFFIX = "API error (attempt 2): Error 429 RESOURCE_EXHAUSTED";

afterEach(async () => {
  await removeAgyRigDirs();
});

function stickyResult(error: string): ReturnType<typeof resultStep> {
  return resultStep(CONV, {
    status: "ERROR",
    response: "First",
    error,
    finishedReason: "error",
  });
}

async function afterQuotaTurn(): Promise<{
  rig: AgyRig;
  handle: Awaited<ReturnType<typeof startAgyHandle>>["handle"];
  events: AgentEvent[];
}> {
  const rig = await createAgyRig();
  const { handle, events } = await startAgyHandle(rig);
  rig.container.scriptTurn([
    initStep(CONV),
    userInputStep(at(CONV, 0)),
    errorMessageStep(at(CONV, 1)),
    textDeltaStep(at(CONV, 2), "First"),
    responseDoneStep(at(CONV, 2)),
    stickyResult(QUOTA_ERROR_TEXT),
  ]);
  await handle.prompt("one", { model: null });
  await handle.setProfile(PermissionProfile.plan);
  events.length = 0;
  return { rig, handle, events };
}

describe("agy adapter stop racing the pre-spawn window", () => {
  it("stop_between_stopped_cleanly_and_spawn", async () => {
    const rig = await createAgyRig();
    const { handle } = await startAgyHandle(rig);
    await handle.setProfile(PermissionProfile.plan);
    const gate = Promise.withResolvers<undefined>();
    rig.container.scriptProcess({ spawnGate: gate.promise });
    const stopped = Promise.withResolvers<StopResult>();
    let flag = false;
    let reads = 0;
    Object.defineProperty(handle, "stopping", {
      configurable: true,
      get: (): boolean => {
        reads += 1;
        if (reads === STOPPED_CLEANLY_READ) {
          queueMicrotask(() => {
            void handle.stop(AGY_RIG_GRACE_MS).then(stopped.resolve);
          });
        }
        return flag;
      },
      set: (next: boolean) => {
        flag = next;
      },
    });
    const prompt = handle.prompt("late", { model: null });

    expect(await settlesWithin(stopped.promise, SETTLE_BOUND_MS)).toBe(true);
    await settlesWithin(prompt, SETTLE_BOUND_MS);
    expect(rig.container.gatedSpawns()).toBe(0);
    gate.resolve(undefined);
    await prompt;

    expect(await stopped.promise).toEqual({ ok: true });
    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(rig.container.runningCount()).toBe(0);
  });
});

describe("agy adapter late error line after a recovery", () => {
  it("error_line_wait_resets_after_recovery", async () => {
    const rig = await createAgyRig();
    const { handle, events } = await startAgyHandle(rig);
    rig.container.scriptUsage({ kind: "ok", groups: EXHAUSTED_GROUPS });
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      agyErrorStep(QUOTA_ERROR_TEXT, "RESOURCE_EXHAUSTED"),
      textDeltaStep(at(CONV, 2), "Recovered"),
      responseDoneStep(at(CONV, 2)),
      errorMessageStep(at(CONV, 3)),
      resultStep(CONV, {
        status: "ERROR",
        error: "agent executor error: generating and executing: failed",
        finishedReason: "error",
      }),
      delayFor(LATE_ERROR_DELAY_MS),
      agyErrorStep("Internal model error", "INTERNAL", 500),
      exitWith(3),
    ]);

    await handle.prompt("work", { model: null });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: "Internal model error INTERNAL 500",
    });
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });
});

describe("agy adapter cumulative result errors across respawns", () => {
  it("stale_quota_error_after_respawn_not_reclassified", async () => {
    const { rig, handle, events } = await afterQuotaTurn();
    rig.container.scriptTurn([
      userInputStep(at(CONV, 3)),
      errorMessageStep(at(CONV, 4)),
      resultStep(CONV, {
        status: "ERROR",
        error: QUOTA_ERROR_TEXT,
        finishedReason: "error",
      }),
      exitWith(3),
    ]);

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(2);
    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: MODEL_FAILED,
      },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });

  it("new_quota_error_after_respawn_is_classified", async () => {
    const { rig, handle, events } = await afterQuotaTurn();
    rig.container.scriptUsage({ kind: "ok", groups: EXHAUSTED_GROUPS });
    rig.container.scriptTurn([
      userInputStep(at(CONV, 3)),
      errorMessageStep(at(CONV, 4)),
      resultStep(CONV, {
        status: "ERROR",
        error: `${QUOTA_ERROR_TEXT}\n${NEW_QUOTA_SUFFIX}`,
        finishedReason: "error",
      }),
      exitWith(3),
    ]);

    await handle.prompt("two", { model: null });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: "rate_limit",
      rpcCode: null,
      message: NEW_QUOTA_SUFFIX,
    });
    expect(rig.container.probeSpawns()).toHaveLength(2);
  });
});

describe("agy adapter result error memory per conversation", () => {
  it("result_error_memory_resets_when_the_conversation_changes", async () => {
    const { rig, handle, events } = await afterQuotaTurn();
    rig.container.scriptUsage({ kind: "ok", groups: EXHAUSTED_GROUPS });
    rig.container.scriptTurn([
      initStep(OTHER_CONV),
      userInputStep(at(OTHER_CONV, 0)),
      errorMessageStep(at(OTHER_CONV, 1)),
      resultStep(OTHER_CONV, {
        status: "ERROR",
        error: QUOTA_ERROR_TEXT,
        finishedReason: "error",
      }),
      exitWith(3),
    ]);

    await handle.prompt("two", { model: null });

    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      errorKind: "rate_limit",
    });
  });
});

describe("agy adapter regression guard for plain replies", () => {
  it("respawned_conversation_still_answers_a_clean_turn", async () => {
    const { rig, handle, events } = await afterQuotaTurn();
    rig.container.scriptTurn(replyTurn(CONV, "fine"));

    await handle.prompt("two", { model: null });

    expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });
});
