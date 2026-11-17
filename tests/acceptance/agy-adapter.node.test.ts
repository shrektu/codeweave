import { isAbsolute } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TurnInProgressError,
  UnknownPermissionError,
} from "../../src/backend/agentAdapter";
import type { AgentEvent } from "../../src/domain/events";
import { PermissionProfile } from "../../src/domain/types";
import {
  AWAIT_SIGNAL,
  HANG,
  AGY_RIG_GRACE_MS,
  at,
  agyErrorStep,
  createAgyRig,
  delayFor,
  err,
  errorMessageStep,
  eventTypes,
  exitWith,
  initStep,
  removeAgyRigDirs,
  replyTurn,
  resultStep,
  startAgyHandle,
  textDeltaStep,
  toolStep,
  usageBucket,
  usageGroup,
  userInputStep,
  waitForEvent,
  responseDoneStep,
} from "../fakes/fakeAgy";
import { settlesWithin } from "../fakes/fakeCodexAppServer";

const CONV = "conv-1";
const SETTLE_BOUND_MS = 2000;
const PENDING_BOUND_MS = 50;
const LATE_ERROR_DELAY_MS = 30;
const EXHAUSTED_GROUPS = [
  usageGroup("Gemini Models", [
    usageBucket("gemini-weekly", "weekly", 0, "2026-11-02T10:21:22Z"),
    usageBucket("gemini-5h", "5h", 0, "2026-10-30T12:54:36Z"),
  ]),
];
const FIVE_HOUR_RESET = 1_793_364_876;
const WEEKLY_RESET = 1_793_614_882;
const NO_OUTPUT_DENIED =
  "no output; agy may have denied this command in headless mode";
const QUOTA_ERROR =
  "agent executor error: generating and executing: Error 429, Message: You exceeded your current quota, please check your plan and billing details., Status: RESOURCE_EXHAUSTED";
const AGY_ERROR_LINE = `AGY_ERROR: ${JSON.stringify({
  short_error: QUOTA_ERROR,
  status: "RESOURCE_EXHAUSTED",
  error_code: 429,
  code_kind: "http",
  retryable: true,
  error_id: "d439d991-1",
})}`;

const HOOKLESS_SETTINGS = {
  toolPermission: "always-proceed",
  useG1Credits: false,
};

const MODE_BY_PROFILE: readonly {
  readonly profile: PermissionProfile;
  readonly mode: string | null;
}[] = [
  { profile: PermissionProfile.bypass, mode: null },
  { profile: PermissionProfile.unattended, mode: null },
  { profile: PermissionProfile.acceptEdits, mode: null },
  { profile: PermissionProfile.ask, mode: null },
  { profile: PermissionProfile.plan, mode: "plan" },
];

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAgyRigDirs();
});

function withoutRateLimit(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type !== "rate_limit");
}

async function readyHandle(
  profile: PermissionProfile = PermissionProfile.ask,
): Promise<{
  rig: Awaited<ReturnType<typeof createAgyRig>>;
  handle: Awaited<ReturnType<typeof startAgyHandle>>["handle"];
  events: AgentEvent[];
}> {
  const rig = await createAgyRig();
  const { handle, events } = await startAgyHandle(rig, profile);
  return { rig, handle, events };
}

function agySpawnAt(
  rig: Awaited<ReturnType<typeof createAgyRig>>,
  index: number,
): ReturnType<typeof rig.container.agySpawns>[number] {
  const spawn = rig.container.agySpawns()[index];
  if (spawn === undefined) {
    throw new Error(`agy spawn ${String(index)} does not exist`);
  }
  return spawn;
}

describe("agy adapter spawn arguments", () => {
  it("spawn_argv_has_gemini_dir_then_empty_prompt_and_selects_mode", async () => {
    for (const { profile, mode } of MODE_BY_PROFILE) {
      const { rig } = await readyHandle(profile);
      const args = agySpawnAt(rig, 0).spec.args;

      expect(args.slice(0, 4)).toEqual([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ]);
      expect(args[4]).toBe("--settings");
      expect(args.slice(6)).toEqual([
        ...(mode === null ? [] : ["--mode", mode]),
        `--gemini_dir=${rig.configDir}`,
        "-p=",
      ]);
    }
  });

  it("usage_probe_argv_carries_the_absolute_gemini_dir", async () => {
    const { rig } = await readyHandle();

    const probe = rig.container.probeSpawns()[0];
    expect(probe?.spec.args).toEqual([
      "-p",
      "/usage",
      "--output-format",
      "json",
      `--gemini_dir=${rig.configDir}`,
    ]);
    expect(isAbsolute(rig.configDir)).toBe(true);
  });

  it("settings_json_for_every_profile_is_always_proceed_without_rules", async () => {
    for (const { profile } of MODE_BY_PROFILE) {
      const { rig } = await readyHandle(profile);

      expect(agySpawnAt(rig, 0).settings).toEqual(HOOKLESS_SETTINGS);
    }
  });
});

describe("agy adapter environment", () => {
  it("child_env_drops_agy_variables", async () => {
    const { rig } = await readyHandle();
    const base = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.corp:3128",
    };

    expect(rig.container.probeSpawns()[0]?.spec.env).toEqual({
      ...base,
      CODEWEAVE_RUN_ID: rig.container.probeSpawns()[0]?.spec.runId,
    });
    const { CODEWEAVE_AGY_SNAPSHOT_DIR: snapshotDir, ...env } = agySpawnAt(
      rig,
      0,
    ).spec.env;
    expect(snapshotDir).toContain("codeweave-agy-snap-");
    expect(env).toEqual({
      ...base,
      CODEWEAVE_RUN_ID: agySpawnAt(rig, 0).spec.runId,
      CODEWEAVE_AGY_PROFILE: "ask",
      CODEWEAVE_AGY_WORKTREE: rig.cwd,
    });
    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });
});

describe("agy adapter stdin", () => {
  it("prompt_is_written_as_one_exact_stdin_line", async () => {
    const { rig, handle } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "pong"));

    await handle.prompt('say "hi"\nplease', { model: null });

    expect(agySpawnAt(rig, 0).stdinLines).toEqual([
      '{"event":"user","message":{"role":"user","content":"say \\"hi\\"\\nplease"}}',
    ]);
  });
});

describe("agy adapter event mapping", () => {
  it("text_and_tool_steps_map_to_events_with_conversation_step_ids", async () => {
    const { rig, handle, events } = await readyHandle();
    const command = { CommandLine: "git status --short" };
    const file = { Path: "/work/repo/notes.md" };
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      toolStep(at(CONV, 1), "ACTIVE", {
        name: "run_command",
        parameters: command,
      }),
      toolStep(at(CONV, 1), "DONE", {
        name: "run_command",
        parameters: command,
        detail: { output: " M notes.md\n" },
      }),
      toolStep(at(CONV, 2), "ACTIVE", { name: "write_file", parameters: file }),
      toolStep(at(CONV, 2), "DONE", { name: "write_file", parameters: file }),
      textDeltaStep(at(CONV, 3), "Done"),
      responseDoneStep(at(CONV, 3)),
      resultStep(CONV, { status: "SUCCESS", response: "Done" }),
    ]);

    await handle.prompt("check", { model: null });

    expect(withoutRateLimit(events)).toEqual([
      {
        type: "tool_call",
        toolCallId: "conv-1:1",
        title: "git status --short",
        kind: "execute",
        status: "in_progress",
        rawInput: command,
      },
      {
        type: "tool_call_update",
        toolCallId: "conv-1:1",
        status: "completed",
        output: " M notes.md\n",
      },
      {
        type: "tool_call",
        toolCallId: "conv-1:2",
        title: "/work/repo/notes.md",
        kind: "edit",
        status: "in_progress",
        rawInput: file,
      },
      { type: "tool_call_update", toolCallId: "conv-1:2", status: "completed" },
      { type: "text", messageId: "conv-1:3", text: "Done" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("agy adapter denied commands", () => {
  it("run_command_done_without_output_is_a_failed_card_with_neutral_message", async () => {
    const { rig, handle, events } = await readyHandle();
    const command = { CommandLine: "touch marker.txt" };
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      toolStep(at(CONV, 1), "ACTIVE", {
        name: "run_command",
        parameters: command,
      }),
      toolStep(at(CONV, 1), "DONE", {
        name: "run_command",
        parameters: command,
      }),
      resultStep(CONV, {
        status: "SUCCESS",
        deniedActions: [{ action: "command", display_name: "RunCommand" }],
      }),
    ]);

    await handle.prompt("touch it", { model: null });

    expect(withoutRateLimit(events).slice(1)).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "conv-1:1",
        status: "failed",
        output: NO_OUTPUT_DENIED,
      },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
  });
});

describe("agy adapter deny rule errors", () => {
  it("deny_rule_error_is_a_failed_card_with_the_agy_message", async () => {
    const { rig, handle, events } = await readyHandle();
    const command = { CommandLine: "sudo ls" };
    const message =
      'permission check failed for unsandboxed "sudo ls": Matches user-configured deny rule.';
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      toolStep(at(CONV, 1), "ACTIVE", {
        name: "run_command",
        parameters: command,
      }),
      toolStep(at(CONV, 1), "ERROR", {
        name: "run_command",
        parameters: command,
        detail: { error: { type: "TOOL_ERROR", message } },
      }),
      textDeltaStep(at(CONV, 2), "Blocked"),
      responseDoneStep(at(CONV, 2)),
      resultStep(CONV, { status: "SUCCESS", response: "Blocked" }),
    ]);

    await handle.prompt("sudo", { model: null });

    expect(withoutRateLimit(events)[1]).toEqual({
      type: "tool_call_update",
      toolCallId: "conv-1:1",
      status: "failed",
      output: message,
    });
  });
});

describe("agy adapter quota exhaustion", () => {
  it("quota_fatal_error_probes_usage_and_reports_rejected_rate_limit", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptUsage({
      kind: "ok",
      groups: [
        usageGroup("Gemini Models", [
          usageBucket("gemini-weekly", "weekly", 0, "2026-11-02T10:21:22Z"),
          usageBucket("gemini-5h", "5h", 0, "2026-10-30T12:54:36Z"),
        ]),
      ],
    });
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      err(AGY_ERROR_LINE),
      resultStep(CONV, {
        status: "ERROR",
        error: QUOTA_ERROR,
        finishedReason: "error",
      }),
      exitWith(3),
    ]);

    await handle.prompt("work", { model: null });

    expect(events).toEqual([
      {
        type: "rate_limit",
        status: "allowed",
        resetsAt: FIVE_HOUR_RESET,
        rateLimitType: "five_hour",
        utilization: 0.5,
      },
      {
        type: "rate_limit",
        status: "rejected",
        resetsAt: WEEKLY_RESET,
        rateLimitType: "seven_day",
        utilization: 1,
      },
      {
        type: "turn_error",
        errorKind: "rate_limit",
        rpcCode: null,
        message: expect.stringContaining("RESOURCE_EXHAUSTED") as unknown,
      },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(2);
    expect(rig.container.runningCount()).toBe(0);
  });
});

describe("agy adapter recovered errors", () => {
  it("error_message_followed_by_a_response_is_api_retry_then_end_turn", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      textDeltaStep(at(CONV, 2), "Recovered"),
      responseDoneStep(at(CONV, 2)),
      resultStep(CONV, {
        status: "ERROR",
        response: "Recovered",
        error: QUOTA_ERROR,
        finishedReason: "error",
      }),
    ]);

    await handle.prompt("go", { model: null });

    expect(withoutRateLimit(events)).toEqual([
      { type: "api_retry" },
      { type: "text", messageId: "conv-1:2", text: "Recovered" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });
});

describe("agy adapter sticky errors and login", () => {
  it("sticky_error_in_a_later_clean_turn_result_is_still_end_turn", async () => {
    const { rig, handle, events } = await readyHandle();
    const sticky = {
      status: "ERROR",
      error: QUOTA_ERROR,
      finishedReason: "error",
      deniedActions: [{ action: "command", display_name: "RunCommand" }],
    } as const;
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      textDeltaStep(at(CONV, 2), "First"),
      responseDoneStep(at(CONV, 2)),
      resultStep(CONV, { ...sticky, response: "First" }),
    ]);
    rig.container.scriptTurn([
      userInputStep(at(CONV, 3)),
      textDeltaStep(at(CONV, 4), "Second"),
      responseDoneStep(at(CONV, 4)),
      resultStep(CONV, { ...sticky, response: "Second" }),
    ]);

    await handle.prompt("one", { model: null });
    events.length = 0;
    await handle.prompt("two", { model: null });

    expect(events).toEqual([
      { type: "text", messageId: "conv-1:4", text: "Second" },
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });

  it("logged_out_agy_at_start_is_needs_login_without_waiting_for_oauth", async () => {
    const rig = await createAgyRig();
    rig.container.scriptUsage({ kind: "logged_out" });

    const started = rig.start();

    expect(await settlesWithin(started, SETTLE_BOUND_MS)).toBe(true);
    expect(await started).toMatchObject({ ok: false, reason: "needs_login" });
    expect(rig.container.agySpawns()).toHaveLength(0);
    expect(rig.container.runningCount()).toBe(0);
    expect(rig.container.probeSpawns()[0]?.contained.stopCalls).toHaveLength(1);
  });
});

describe("agy adapter cancel", () => {
  it("cancel_ends_the_turn_cancelled_and_the_next_prompt_resumes_after_the_stop", async () => {
    const { rig, handle, events } = await readyHandle();
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
      exitWith(0),
    ]);
    const running = handle.prompt("long task", { model: null });
    await waitForEvent(events, "text");

    await handle.cancel();
    await running;

    expect(eventTypes(events).slice(-2)).toEqual(["text", "turn_end"]);
    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "cancelled",
    });
    rig.container.scriptTurn(replyTurn(CONV, "again"));
    await handle.prompt("continue", { model: null });

    const resumed = agySpawnAt(rig, 1);
    expect(resumed.conversation).toBe(CONV);
    expect(resumed.agyRunningAtSpawn).toBe(0);
    expect(resumed.spec.args.slice(-4)).toEqual([
      "--conversation",
      CONV,
      `--gemini_dir=${rig.configDir}`,
      "-p=",
    ]);
    expect(eventTypes(events)).not.toContain("process_exit");
    expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });
});

describe("agy adapter cancel without a result and exits", () => {
  it("cancel_without_a_result_synthesizes_turn_end_cancelled", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      textDeltaStep(at(CONV, 1), "Working"),
      HANG,
    ]);
    const running = handle.prompt("long task", { model: null });
    await waitForEvent(events, "text");

    await handle.cancel();
    await running;

    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "cancelled",
    });
    expect(eventTypes(events)).not.toContain("process_exit");
  });

  it("exit_mid_turn_is_turn_error_then_process_exit", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      textDeltaStep(at(CONV, 1), "Half"),
      exitWith(1),
    ]);

    await handle.prompt("work", { model: null });
    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({ type: "process_exit" });
    });

    expect(withoutRateLimit(events)).toEqual([
      { type: "text", messageId: "conv-1:1", text: "Half" },
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

describe("agy adapter lifecycle", () => {
  it("stop_and_profile_respawn_exits_emit_no_process_exit", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    rig.container.scriptTurn(replyTurn(CONV, "two"));
    await handle.prompt("one", { model: null });
    await handle.setProfile(PermissionProfile.plan);
    await handle.prompt("two", { model: null });

    const stopped = await handle.stop(AGY_RIG_GRACE_MS);

    expect(stopped).toEqual({ ok: true });
    expect(rig.container.runningCount()).toBe(0);
    expect(rig.container.agySpawns()).toHaveLength(2);
    expect(eventTypes(events)).not.toContain("process_exit");
    expect(
      eventTypes(events).filter((type) => type === "turn_end"),
    ).toHaveLength(2);
  });

  it("answer_permission_always_throws_unknown_permission_error", async () => {
    const { handle } = await readyHandle();

    expect(() => {
      handle.answerPermission("req-1", "allow");
    }).toThrow(UnknownPermissionError);
  });

  it("set_profile_respawns_with_the_new_settings_on_the_next_prompt", async () => {
    const { rig, handle } = await readyHandle(PermissionProfile.ask);
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    rig.container.scriptTurn(replyTurn(CONV, "two"));
    await handle.prompt("one", { model: null });

    await handle.setProfile(PermissionProfile.plan);

    expect(rig.container.agySpawns()).toHaveLength(1);
    await handle.prompt("two", { model: null });
    const respawned = agySpawnAt(rig, 1);
    expect(respawned.settings).toEqual(HOOKLESS_SETTINGS);
    expect(respawned.mode).toBe("plan");
    expect(respawned.conversation).toBe(CONV);
    expect(agySpawnAt(rig, 0).contained.hasExited).toBe(true);
    expect(respawned.agyRunningAtSpawn).toBe(0);
  });
});

describe("agy adapter rejected model", () => {
  it("rejected agy model fails the turn visibly", async () => {
    const { rig, handle, events } = await readyHandle();
    const message =
      'invalid model selection (--model "nonsense" --effort ""): model nonsense is not recognized as a known model or custom model in settings';
    rig.container.scriptTurn([
      resultStep("", {
        status: "ERROR",
        error: message,
        finishedReason: "error",
      }),
      exitWith(1),
    ]);

    await handle.prompt("go", { model: "nonsense" });

    expect(events.filter((event) => event.type === "turn_error")).toEqual([
      { type: "turn_error", errorKind: null, rpcCode: null, message },
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message,
    });
  });
});

describe("agy adapter model selection", () => {
  it("model reaches agy as --model", async () => {
    const { rig, handle } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));

    await handle.prompt("one", { model: "gemini-3-pro" });

    expect(rig.container.agySpawns().map((spawn) => spawn.model)).toEqual([
      null,
      "gemini-3-pro",
    ]);
    expect(agySpawnAt(rig, 1).spec.args).toContain("--model");
  });

  it("changing model respawns agy with the new --model", async () => {
    const { rig, handle } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    rig.container.scriptTurn(replyTurn(CONV, "two"));
    rig.container.scriptTurn(replyTurn(CONV, "three"));

    await handle.prompt("one", { model: "gemini-3-pro" });
    await handle.prompt("two", { model: "gemini-3-flash" });
    await handle.prompt("three", { model: null });

    expect(rig.container.agySpawns().map((spawn) => spawn.model)).toEqual([
      null,
      "gemini-3-pro",
      "gemini-3-flash",
      null,
    ]);
    expect(agySpawnAt(rig, 2).conversation).toBe(CONV);
    expect(agySpawnAt(rig, 1).contained.hasExited).toBe(true);
  });

  it("same model reuses the agy process", async () => {
    const { rig, handle } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("one", { model: "gemini-3-pro" });
    await handle.prompt("two", { model: "gemini-3-pro" });

    expect(rig.container.agySpawns()).toHaveLength(2);
    expect(agySpawnAt(rig, 1).stdinLines).toHaveLength(2);
  });

  it("null model keeps the process started without a model", async () => {
    const { rig, handle } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));

    await handle.prompt("one", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(agySpawnAt(rig, 0).spec.args).not.toContain("--model");
  });
});

describe("agy adapter model reporting", () => {
  it("adapter reports the spawn model", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    rig.container.scriptTurn(replyTurn(CONV, "two"));
    rig.container.scriptTurn(replyTurn(CONV, "three"));

    await handle.prompt("one", { model: "gemini-3-pro" });
    await handle.prompt("two", { model: "gemini-3-pro" });
    await handle.prompt("three", { model: "gemini-3-flash" });

    expect(events.filter((event) => event.type === "model")).toEqual([
      { type: "model", model: "gemini-3-pro" },
      { type: "model", model: "gemini-3-flash" },
    ]);
  });
});

describe("agy adapter busy turns and limits", () => {
  it("prompt_during_a_running_turn_is_rejected", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      textDeltaStep(at(CONV, 1), "Working"),
      HANG,
    ]);
    const running = handle.prompt("first", { model: null });
    await waitForEvent(events, "text");

    await expect(
      handle.prompt("second", { model: null }),
    ).rejects.toBeInstanceOf(TurnInProgressError);

    expect(agySpawnAt(rig, 0).stdinLines).toHaveLength(1);
    await handle.stop(AGY_RIG_GRACE_MS);
    await running;
  });

  it("start_with_a_healthy_probe_announces_the_limits_on_the_first_prompt", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "hi"));

    expect(events).toEqual([]);
    await handle.prompt("hi", { model: null });

    expect(events[0]).toEqual({
      type: "rate_limit",
      status: "allowed",
      resetsAt: FIVE_HOUR_RESET,
      rateLimitType: "five_hour",
      utilization: 0.5,
    });
  });
});

describe("agy adapter stop and cancel racing a respawn", () => {
  it("stop_during_respawn_stops_new_process", async () => {
    const { rig, handle } = await readyHandle();
    const gate = Promise.withResolvers<undefined>();
    rig.container.scriptProcess({ spawnGate: gate.promise });
    rig.container.scriptTurn(replyTurn(CONV, "late"));
    await handle.setProfile(PermissionProfile.plan);
    const prompt = handle.prompt("late", { model: null });
    await vi.waitFor(() => {
      expect(rig.container.gatedSpawns()).toBe(1);
    });

    const stopping = handle.stop(AGY_RIG_GRACE_MS);

    expect(await settlesWithin(stopping, PENDING_BOUND_MS)).toBe(false);
    gate.resolve(undefined);
    expect(await stopping).toEqual({ ok: true });
    await prompt;
    const respawned = agySpawnAt(rig, 1);
    expect(respawned.contained.stopCalls).not.toEqual([]);
    expect(respawned.stdinLines).toEqual([]);
    expect(rig.container.runningCount()).toBe(0);
  });
});

describe("agy adapter cancel racing a respawn", () => {
  it("cancel_during_respawn_ends_turn_cancelled", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one", { model: null });
    const gate = Promise.withResolvers<undefined>();
    rig.container.scriptProcess({ spawnGate: gate.promise });
    rig.container.scriptTurn(replyTurn(CONV, "late"));
    await handle.setProfile(PermissionProfile.plan);
    const prompt = handle.prompt("late", { model: null });
    await vi.waitFor(() => {
      expect(rig.container.gatedSpawns()).toBe(1);
    });

    await handle.cancel();
    gate.resolve(undefined);
    await prompt;

    expect(events.at(-1)).toEqual({
      type: "turn_end",
      stopReason: "cancelled",
    });
    expect(agySpawnAt(rig, 1).stdinLines).toEqual([]);
    expect(rig.container.runningCount()).toBe(0);
    await handle.prompt("next", { model: null });
    expect(rig.container.agySpawns()).toHaveLength(3);
    expect(agySpawnAt(rig, 2).conversation).toBe(CONV);
    expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });
});

describe("agy adapter prompt while a cancelled process is stopping", () => {
  it("prompt_right_after_cancel_respawns", async () => {
    const exit = Promise.withResolvers<undefined>();
    const rig = await createAgyRig();
    rig.container.scriptProcess({ exitGate: exit.promise });
    const { handle, events } = await startAgyHandle(rig);
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
    rig.container.scriptTurn(replyTurn(CONV, "again"));
    const running = handle.prompt("long task", { model: null });
    await waitForEvent(events, "text");
    const cancelling = handle.cancel();
    await running;

    const second = handle.prompt("continue", { model: null });
    exit.resolve(undefined);
    await cancelling;
    await second;

    expect(rig.container.agySpawns()).toHaveLength(2);
    expect(agySpawnAt(rig, 0).stdinLines).toHaveLength(1);
    const resumed = agySpawnAt(rig, 1);
    expect(resumed.spec.args.slice(-4)).toEqual([
      "--conversation",
      CONV,
      `--gemini_dir=${rig.configDir}`,
      "-p=",
    ]);
    expect(resumed.agyRunningAtSpawn).toBe(0);
    expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });
});

describe("agy adapter quota evidence arriving after the result", () => {
  it("late_stderr_quota_error_rotates", async () => {
    const { rig, handle, events } = await readyHandle();
    rig.container.scriptUsage({ kind: "ok", groups: EXHAUSTED_GROUPS });
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      resultStep(CONV, {
        status: "ERROR",
        error: "agent executor error: generating and executing: failed",
        finishedReason: "error",
      }),
      delayFor(LATE_ERROR_DELAY_MS),
      err(AGY_ERROR_LINE),
      exitWith(3),
    ]);

    await handle.prompt("work", { model: null });

    expect(events.filter((event) => event.type === "rate_limit")).toHaveLength(
      2,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "rate_limit", status: "rejected" }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      errorKind: "rate_limit",
    });
    expect(rig.container.probeSpawns()).toHaveLength(2);
  });
});

describe("agy adapter stale quota text", () => {
  it("retried_429_then_other_fatal_error_is_not_quota", async () => {
    const { rig, handle, events } = await readyHandle();
    const sticky = {
      status: "ERROR",
      error: QUOTA_ERROR,
      finishedReason: "error",
    } as const;
    rig.container.scriptTurn([
      initStep(CONV),
      userInputStep(at(CONV, 0)),
      errorMessageStep(at(CONV, 1)),
      err(AGY_ERROR_LINE),
      textDeltaStep(at(CONV, 2), "Recovered"),
      responseDoneStep(at(CONV, 2)),
      resultStep(CONV, { ...sticky, response: "Recovered" }),
    ]);
    rig.container.scriptTurn([
      userInputStep(at(CONV, 3)),
      errorMessageStep(at(CONV, 4)),
      resultStep(CONV, sticky),
      delayFor(LATE_ERROR_DELAY_MS),
      agyErrorStep("Internal model error", "INTERNAL", 500),
      exitWith(3),
    ]);
    await handle.prompt("one", { model: null });
    events.length = 0;

    await handle.prompt("two", { model: null });

    expect(withoutRateLimit(events)).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "Internal model error INTERNAL 500",
      },
    ]);
    expect(events.map((event) => event.type)).not.toContain("rate_limit");
    expect(rig.container.probeSpawns()).toHaveLength(1);
  });
});
