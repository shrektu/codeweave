import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGY_RIG_GRACE_MS,
  AWAIT_SIGNAL,
  HANG,
  QUOTA_ERROR_TEXT,
  agyErrorStep,
  at,
  delayFor,
  err,
  errorMessageStep,
  eventTypes,
  exitWith,
  initStep,
  quotaFailureTurn,
  removeAgyRigDirs,
  replyTurn,
  responseDoneStep,
  resultStep,
  startedAgy,
  textDeltaStep,
  userInputStep,
  waitForEvent,
} from "../../../tests/fakes/fakeAgy";
import { settlesWithin } from "../../../tests/fakes/fakeCodexAppServer";
import { settled } from "../../../tests/fakes/settle";
import type { AgentEvent } from "../../domain/events";
import { PermissionProfile } from "../../domain/types";
import { TurnInProgressError } from "../agentAdapter";

const CONV = "conv-1";
const SETTLE_BOUND_MS = 2000;
const LATE_ERROR_DELAY_MS = 30;
const STICKY_RESULT = {
  status: "ERROR",
  error: QUOTA_ERROR_TEXT,
  finishedReason: "error",
} as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAgyRigDirs();
});

function withoutRateLimit(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type !== "rate_limit");
}

describe("agy adapter model failures", () => {
  it("a_fatal_quota_exit_without_a_result_still_reports_rate_limit", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn(quotaFailureTurn(CONV, false));

    await handle.prompt("work", { model: null });

    expect(eventTypes(events)).toEqual([
      "rate_limit",
      "rate_limit",
      "turn_error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      errorKind: "rate_limit",
    });
    expect(rig.container.probeSpawns()).toHaveLength(2);
  });

  it("a_non_quota_model_failure_is_a_turn_error_without_kind_or_probe", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      agyErrorStep("Internal model error", "INTERNAL", 500),
      resultStep(CONV, {
        status: "ERROR",
        error: "agent executor error: internal",
        finishedReason: "error",
      }),
    ]);

    await handle.prompt("work", { model: null });

    expect(withoutRateLimit(events)).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "Internal model error INTERNAL 500",
      },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });
});

describe("agy adapter quota classification of this turn only", () => {
  it("late_agy_error_line_classifies_turn", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      resultStep(CONV, STICKY_RESULT),
      delayFor(LATE_ERROR_DELAY_MS),
      agyErrorStep("Internal model error", "INTERNAL", 500),
      exitWith(3),
    ]);

    await handle.prompt("work", { model: null });

    expect(withoutRateLimit(events)).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "Internal model error INTERNAL 500",
      },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });

  it("stale_quota_text_in_result_is_not_new_quota", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      textDeltaStep(at(CONV, 2), "First"),
      responseDoneStep(at(CONV, 2)),
      resultStep(CONV, { ...STICKY_RESULT, response: "First" }),
    ]);
    rig.container.scriptTurn([
      userInputStep(at(CONV, 3)),
      errorMessageStep(at(CONV, 4)),
      resultStep(CONV, STICKY_RESULT),
      exitWith(3),
    ]);
    await handle.prompt("one", { model: null });
    events.length = 0;

    await handle.prompt("two", { model: null });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "The model request failed",
      },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });
});

describe("agy adapter respawn races with stop", () => {
  it("stop_during_respawn_leaves_no_process", async () => {
    const { rig, handle, events } = await startedAgy();
    const gate = Promise.withResolvers<undefined>();
    rig.container.scriptProcess({ spawnGate: gate.promise });
    rig.container.scriptTurn(replyTurn(CONV, "late"));
    await handle.setProfile(PermissionProfile.plan);
    const prompt = handle.prompt("late", { model: null });
    await settled(() => {
      expect(rig.container.gatedSpawns()).toBe(1);
    });

    const stopping = handle.stop(AGY_RIG_GRACE_MS);
    gate.resolve(undefined);
    const stopped = await stopping;
    await prompt;

    expect(stopped).toEqual({ ok: true });
    expect(rig.container.runningCount()).toBe(0);
    expect(rig.container.agySpawns()[1]?.stdinLines).toEqual([]);
    expect(events.slice(-2)).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "Agent process exited",
      },
      { type: "process_exit" },
    ]);
  });
});

describe("agy adapter respawn races with cancel", () => {
  it("cancel_during_respawn_cancels_turn", async () => {
    const { rig, handle, events } = await startedAgy();
    const gate = Promise.withResolvers<undefined>();
    rig.container.scriptProcess({ spawnGate: gate.promise });
    rig.container.scriptTurn(replyTurn(CONV, "late"));
    await handle.setProfile(PermissionProfile.plan);
    const prompt = handle.prompt("late", { model: null });
    await settled(() => {
      expect(rig.container.gatedSpawns()).toBe(1);
    });

    await handle.cancel();
    gate.resolve(undefined);
    await prompt;

    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "cancelled",
    });
    expect(rig.container.agySpawns()[1]?.stdinLines).toEqual([]);
    expect(rig.container.runningCount()).toBe(0);
  });

  it("prompt_after_cancel_result_waits_for_exit", async () => {
    const exit = Promise.withResolvers<undefined>();
    const { rig, handle, events } = await startedAgy({
      exitGate: exit.promise,
    });
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      textDeltaStep(at(CONV, 1), "Working"),
      AWAIT_SIGNAL,
      resultStep(CONV, {
        status: "ERROR",
        error: "interrupted",
        finishedReason: "interrupted",
      }),
      HANG,
    ]);
    const running = handle.prompt("task", { model: null });
    await waitForEvent(events, "text");
    const cancelling = handle.cancel();
    await running;
    rig.container.scriptTurn(replyTurn(CONV, "again"));

    const second = handle.prompt("again", { model: null });
    exit.resolve(undefined);
    await cancelling;
    await second;

    const spawns = rig.container.agySpawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.stdinLines).toHaveLength(1);
    expect(spawns[1]?.conversation).toBe(CONV);
    expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });
});

describe("agy adapter authentication failures", () => {
  it("auth_required_on_stderr_mid_turn_ends_the_turn_and_stops_agy", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      err("Authentication required. Please visit the URL to log in:"),
      HANG,
    ]);

    const prompt = handle.prompt("work", { model: null });

    expect(await settlesWithin(prompt, SETTLE_BOUND_MS)).toBe(true);
    expect(withoutRateLimit(events)).toEqual([
      {
        type: "turn_error",
        errorKind: "auth_required",
        rpcCode: null,
        message: "Antigravity login required",
      },
    ]);
    await settled(() => {
      expect(rig.container.runningCount()).toBe(0);
    });
  });

  it("a_result_with_the_auth_error_and_no_response_is_auth_required", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      resultStep("", {
        status: "ERROR",
        error: "authentication failed or timed out",
        finishedReason: "error",
      }),
      exitWith(1),
    ]);

    await handle.prompt("work", { model: null });

    expect(withoutRateLimit(events)).toEqual([
      {
        type: "turn_error",
        errorKind: "auth_required",
        rpcCode: null,
        message: "authentication failed or timed out",
      },
    ]);
  });
});

describe("agy adapter cancel and stop edges", () => {
  it("cancel_without_a_running_turn_does_not_touch_the_process", async () => {
    const { rig, handle } = await startedAgy();

    await handle.cancel();

    expect(rig.container.agySpawns()[0]?.contained.stopCalls).toEqual([]);
    expect(rig.container.runningCount()).toBe(1);
  });

  it("stop_during_a_turn_ends_it_cancelled_without_process_exit", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      textDeltaStep(at(CONV, 1), "Working"),
      HANG,
    ]);
    const prompt = handle.prompt("work", { model: null });
    await waitForEvent(events, "text");

    const stopped = await handle.stop(AGY_RIG_GRACE_MS);
    await prompt;

    expect(stopped).toEqual({ ok: true });
    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "cancelled",
    });
    expect(eventTypes(events)).not.toContain("process_exit");
    expect(rig.container.runningCount()).toBe(0);
  });
});

describe("agy adapter subscribers and busy turns", () => {
  it("prompt_during_turn_rejected", async () => {
    const { rig, handle, events } = await startedAgy();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      textDeltaStep(at(CONV, 1), "Working"),
      HANG,
    ]);
    const first = handle.prompt("first", { model: null });
    await waitForEvent(events, "text");

    await expect(
      handle.prompt("second", { model: null }),
    ).rejects.toBeInstanceOf(TurnInProgressError);
    await handle.stop(AGY_RIG_GRACE_MS);
    await first;

    expect(rig.container.agySpawns()[0]?.stdinLines).toHaveLength(1);
  });

  it("a_throwing_subscriber_does_not_break_the_turn_or_other_subscribers", async () => {
    const { rig, handle } = await startedAgy();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: AgentEvent[] = [];
    handle.subscribe(() => {
      throw new Error("listener bug");
    });
    handle.subscribe((event) => seen.push(event));
    rig.container.scriptTurn(replyTurn(CONV, "hi"));

    await handle.prompt("hi", { model: null });

    expect(eventTypes(seen)).toEqual(["rate_limit", "text", "turn_end"]);
  });

  it("an_unsubscribed_listener_receives_nothing_more", async () => {
    const { rig, handle } = await startedAgy();
    const seen: AgentEvent[] = [];
    const unsubscribe = handle.subscribe((event) => seen.push(event));
    unsubscribe();
    rig.container.scriptTurn(replyTurn(CONV, "hi"));

    await handle.prompt("hi", { model: null });

    expect(seen).toEqual([]);
  });
});
