import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGY_RIG_GRACE_MS,
  AWAIT_RELEASE,
  AWAIT_SIGNAL,
  CLOSE_STREAMS,
  at,
  createAgyRig,
  delayFor,
  err,
  eventTypes,
  exitNotice,
  exitWith,
  hookStep,
  initStep,
  toolStep,
  writeFileStep,
  quotaFailureTurn,
  rawOut,
  removeAgyRigDirs,
  replyTurn,
  resultStep,
  startAgyHandle,
  startedAgy as started,
  stepUpdate,
  textDeltaStep,
  usageBucket,
  usageGroup,
  userInputStep,
  waitForEvent,
  type UsageScript,
} from "../../../tests/fakes/fakeAgy";
import { settlesWithin } from "../../../tests/fakes/fakeCodexAppServer";
import type { AgentEvent } from "../../domain/events";
import { AGY_SNAPSHOT_DIR_ENV, AgyToolName } from "./constants";
import { PermissionProfile } from "../../domain/types";
import { StopFailureReason, type StopResult } from "../process/container";

const CONV = "conv-1";
const SETTLE_BOUND_MS = 2000;
const DRAIN_PROBE_MS = 50;
const FAILED_STOP: StopResult = {
  ok: false,
  reason: StopFailureReason.notEmptyAfterTimeout,
  survivors: [4242],
};
const CANCEL_TURN = [
  initStep(CONV),
  userInputStep(at(CONV, 0)),
  textDeltaStep(at(CONV, 1), "Working"),
  AWAIT_SIGNAL,
  resultStep(CONV, {
    status: "ERROR",
    error: "interrupted",
    finishedReason: "interrupted",
  }),
  exitWith(0),
];

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAgyRigDirs();
});

describe("agy adapter start", () => {
  it("logged_out_start_does_not_hang", async () => {
    const rig = await createAgyRig();
    rig.container.scriptUsage({ kind: "logged_out" });

    const result = rig.start();

    expect(await settlesWithin(result, SETTLE_BOUND_MS)).toBe(true);
    expect(await result).toMatchObject({ ok: false, reason: "needs_login" });
    expect(rig.container.runningCount()).toBe(0);
    expect(rig.container.agySpawns()).toHaveLength(0);
  });

  it("logged_out_json_error_is_needs_login_too", async () => {
    const rig = await createAgyRig();
    rig.container.scriptUsage({ kind: "auth_error_json" });

    expect(await rig.start()).toMatchObject({
      ok: false,
      reason: "needs_login",
    });
    expect(rig.container.runningCount()).toBe(0);
  });

  it("a_hanging_probe_does_not_block_start_and_is_killed", async () => {
    const rig = await createAgyRig();
    rig.container.scriptUsage({ kind: "hang" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await rig.start();

    expect(result.ok).toBe(true);
    expect(rig.container.probeSpawns()[0]?.contained.hasExited).toBe(true);
    expect(rig.container.agySpawns()).toHaveLength(1);
  });

  it("api_key_mode_without_groups_starts_without_a_rate_limit_event", async () => {
    const rig = await createAgyRig();
    rig.container.scriptUsage({ kind: "ok", groups: [] });
    const { handle, events } = await startAgyHandle(rig);
    rig.container.scriptTurn(replyTurn(CONV, "hi"));

    await handle.prompt("hi");

    expect(eventTypes(events)).toEqual(["text", "turn_end"]);
  });

  it("a_spawn_failure_is_a_start_error_with_the_spawn_message", async () => {
    const rig = await createAgyRig();
    rig.container.spawnFailure = new Error("spawn agy ENOENT");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await rig.start()).toEqual({
      ok: false,
      reason: "error",
      message: "spawn agy ENOENT",
    });
  });
});

describe("agy adapter respawn after a failed stop", () => {
  it("respawn_waits_for_previous_stop", async () => {
    const { rig, handle, events } = await started({
      stopResults: Array<StopResult>(10).fill(FAILED_STOP),
    });
    rig.container.scriptTurn(CANCEL_TURN);
    const running = handle.prompt("task");
    await waitForEvent(events, "text");
    await handle.cancel();
    await running;
    events.length = 0;

    await handle.prompt("again");

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "The previous agy process did not stop",
      },
      { type: "process_exit" },
    ]);
  });

  it("respawn_gives_up_when_the_previous_stop_never_settles", async () => {
    const { rig, handle, events } = await started({ holdStops: true });
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    await handle.setProfile(PermissionProfile.plan);
    events.length = 0;

    const second = handle.prompt("two");

    expect(await settlesWithin(second, SETTLE_BOUND_MS)).toBe(true);
    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(eventTypes(events)).toEqual(["turn_error", "process_exit"]);
  });
});

describe("agy adapter respawn after an exit", () => {
  it("idle_crash_respawns_with_the_conversation_and_stays_silent", async () => {
    const { rig, handle, events } = await started();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    rig.container.agySpawns()[0]?.contained.exit(1);
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two");

    expect(rig.container.agySpawns()[1]?.conversation).toBe(CONV);
    expect(eventTypes(events)).not.toContain("process_exit");
    expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });

  it("an_unchanged_profile_reuses_the_running_process", async () => {
    const { rig, handle } = await started();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("one");
    await handle.setProfile(PermissionProfile.ask);
    await handle.prompt("two");

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(rig.container.agySpawns()[0]?.stdinLines).toHaveLength(2);
  });

  it("a_respawn_spawn_failure_is_a_turn_error_without_process_exit", async () => {
    const { rig, handle, events } = await started();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    rig.container.agySpawns()[0]?.contained.exit(1);
    rig.container.spawnFailure = new Error("spawn agy EAGAIN");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    events.length = 0;

    await handle.prompt("two");

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "spawn agy EAGAIN",
      },
    ]);
  });

  it("prompt_after_stop_is_turn_error_and_process_exit_without_a_spawn", async () => {
    const { rig, handle, events } = await started();
    await handle.stop(AGY_RIG_GRACE_MS);

    await handle.prompt("late");

    expect(events.slice(1)).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "Agent process exited",
      },
      { type: "process_exit" },
    ]);
    expect(rig.container.agySpawns()).toHaveLength(1);
  });
});

describe("agy adapter input noise", () => {
  it("malformed_lines_ignored", async () => {
    const { rig, handle, events } = await started();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rig.container.scriptTurn([
      initStep(CONV),
      rawOut("this is not json"),
      rawOut('{"event":"telemetry","x":1}'),
      stepUpdate(at(CONV, 1), "DONE", "hologram", { holo: true }),
      err("some unrelated noise"),
      err("AGY_ERROR: {broken"),
      textDeltaStep(at(CONV, 2), "fine"),
      resultStep(CONV, { status: "SUCCESS", response: "fine" }),
    ]);

    await handle.prompt("go");

    expect(events.slice(1)).toEqual([
      { type: "text", messageId: "conv-1:2", text: "fine" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

async function quotaAfter(usage: UsageScript): Promise<AgentEvent[]> {
  const { rig, handle, events } = await started();
  rig.container.scriptUsage(usage);
  rig.container.scriptTurn(quotaFailureTurn(CONV));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  events.length = 0;
  await handle.prompt("work");
  return events.filter(
    (event) => event.type === "rate_limit" && event.status === "rejected",
  );
}

describe("agy adapter exhaustion without a reset time", () => {
  const cases: readonly (readonly [string, UsageScript])[] = [
    ["no_gemini_group", { kind: "ok", groups: [] }],
    [
      "bad_reset_time_on_exhausted_bucket",
      {
        kind: "ok",
        groups: [
          usageGroup("Gemini Models", [usageBucket("g", "5h", 0, "soon")]),
        ],
      },
    ],
    [
      "all_fractions_above_zero",
      {
        kind: "ok",
        groups: [
          usageGroup("Gemini Models", [
            usageBucket("g", "5h", 0.2, "2026-10-30T12:54:36Z"),
          ]),
        ],
      },
    ],
    ["probe_output_is_garbage", { kind: "garbage" }],
  ];

  it.each(cases)("usage_without_gemini_group_%s", async (_name, usage) => {
    const limits = await quotaAfter(usage);

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ status: "rejected", resetsAt: null });
  });
});

describe("agy adapter usage probes run outside the workspace", () => {
  it("usage_probe_does_not_run_in_worktree_start_probe", async () => {
    const rig = await createAgyRig();

    await startAgyHandle(rig);

    expect(rig.container.probeSpawns().map((spawn) => spawn.spec.cwd)).toEqual([
      rig.configDir,
    ]);
    expect(rig.container.agySpawns().map((spawn) => spawn.spec.cwd)).toEqual([
      rig.cwd,
    ]);
  });

  it("usage_probe_does_not_run_in_worktree_exhaustion_probe", async () => {
    const rig = await createAgyRig();
    const { handle } = await startAgyHandle(rig);
    rig.container.scriptTurn(quotaFailureTurn(CONV));

    await handle.prompt("work");

    expect(rig.container.probeSpawns().map((spawn) => spawn.spec.cwd)).toEqual([
      rig.configDir,
      rig.configDir,
    ]);
  });
});

describe("agy adapter workspace fingerprint after init", () => {
  it("workspace_fingerprint_failure_fails_closed_after_init", async () => {
    let calls = 0;
    const rig = await createAgyRig({
      fingerprintWorkspace: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve("same")
          : Promise.reject(new Error("cannot read .agents"));
      },
    });
    const { handle, events } = await startAgyHandle(rig);
    rig.container.scriptTurn([
      initStep(CONV),
      delayFor(150),
      ...replyTurn(CONV, "one").slice(1),
    ]);

    await handle.prompt("one");

    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      message:
        "Gemini workspace config (.agents) changed during this session; review it and start a new session",
    });
    expect(rig.container.agySpawns()[0]?.contained.hasExited).toBe(true);
  });
});

function isDiffUpdate(event: AgentEvent): boolean {
  return event.type === "tool_call_update" && event.diffs !== undefined;
}

describe("agy adapter snapshot dir lifetime", () => {
  it("snapshot_dir_kept_until_exit_drain_finishes", async () => {
    const rig = await createAgyRig();
    await writeFile(join(rig.cwd, "a.txt"), "one\ntwo\nthree\n");
    const target = join(rig.cwd, "a.txt");
    const tool = {
      name: AgyToolName.editFile,
      parameters: { Path: target, Target: "two", Replacement: "2" },
    };
    const ref = at(CONV, 1);
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      toolStep(ref, "ACTIVE", tool),
      hookStep(ref, tool, rig.cwd),
      writeFileStep(target, "one\n2\nthree\n"),
      exitNotice(0),
      AWAIT_RELEASE,
      toolStep(ref, "DONE", tool),
      CLOSE_STREAMS,
    ]);
    const { handle, events } = await startAgyHandle(
      rig,
      PermissionProfile.acceptEdits,
    );
    const spawn = rig.container.agySpawns()[0];
    const dir = spawn?.spec.env[AGY_SNAPSHOT_DIR_ENV] ?? "";

    const prompt = handle.prompt("go");
    await vi.waitFor(() => {
      expect(spawn?.contained.hookOutputs).toHaveLength(1);
    });
    await delay(DRAIN_PROBE_MS);
    expect(existsSync(dir)).toBe(true);
    spawn?.contained.released.resolve(undefined);
    await prompt;

    await vi.waitFor(() => {
      expect(existsSync(dir)).toBe(false);
      expect(events.some(isDiffUpdate)).toBe(true);
    });
  });
});

describe("agy adapter fast result waits for the init workspace check", () => {
  const PENDING_PROBE_MS = 150;

  async function pendingInitCheck(): Promise<{
    readonly check: PromiseWithResolvers<string>;
    readonly prompt: Promise<void>;
    readonly events: AgentEvent[];
  }> {
    const check = Promise.withResolvers<string>();
    let calls = 0;
    const rig = await createAgyRig({
      fingerprintWorkspace: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve("same") : check.promise;
      },
    });
    const { handle, events } = await startAgyHandle(rig);
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    return { check, prompt: handle.prompt("one"), events };
  }

  it("fast_result_waits_for_init_workspace_check_failing", async () => {
    const { check, prompt, events } = await pendingInitCheck();

    expect(await settlesWithin(prompt, PENDING_PROBE_MS)).toBe(false);
    check.reject(new Error("cannot read .agents"));
    await prompt;

    expect(events.filter((event) => event.type === "turn_end")).toEqual([]);
    expect(events.filter((event) => event.type === "turn_error")).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message:
          "Gemini workspace config (.agents) changed during this session; review it and start a new session",
      },
    ]);
  });

  it("fast_result_waits_for_init_workspace_check_passing", async () => {
    const { check, prompt, events } = await pendingInitCheck();

    expect(await settlesWithin(prompt, PENDING_PROBE_MS)).toBe(false);
    check.resolve("same");
    await prompt;

    expect(events.filter((event) => event.type === "turn_error")).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "end_turn",
    });
  });
});
