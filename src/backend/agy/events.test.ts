import { describe, expect, it } from "vitest";

import { TurnTracker, stepEvents } from "./events";
import type { AgyResult, StepUpdate } from "./protocol";

const CONV = "conv-9";
const QUOTA_TEXT =
  "agent executor error: Error 429, Status: RESOURCE_EXHAUSTED";

function step(partial: Partial<StepUpdate>): StepUpdate {
  return {
    conversation_id: CONV,
    step_index: 1,
    state: "DONE",
    step_type: "agent_response",
    ...partial,
  };
}

function result(partial: Partial<AgyResult> = {}): AgyResult {
  return { conversation_id: CONV, status: "SUCCESS", ...partial };
}

describe("agy step mapping", () => {
  it("text_delta_becomes_text_with_conversation_step_id", () => {
    const events = stepEvents(
      step({ state: "ACTIVE", step_index: 4, text_delta: "Hello" }),
      "fallback",
    );

    expect(events).toEqual([
      { type: "text", messageId: "conv-9:4", text: "Hello" },
    ]);
  });

  it("empty_text_delta_and_user_input_steps_map_to_nothing", () => {
    expect(stepEvents(step({ text_delta: "" }), CONV)).toEqual([]);
    expect(stepEvents(step({ step_type: "user_input" }), CONV)).toEqual([]);
    expect(stepEvents(step({ step_type: "system_message" }), CONV)).toEqual([]);
  });

  it("missing_step_conversation_falls_back_to_the_handle_conversation", () => {
    const bare: StepUpdate = {
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "x",
    };

    expect(stepEvents(bare, "conv-fallback")).toEqual([
      { type: "text", messageId: "conv-fallback:1", text: "x" },
    ]);
  });
});

describe("agy tool mapping", () => {
  const kinds: readonly (readonly [string, string])[] = [
    ["run_command", "execute"],
    ["write_file", "edit"],
    ["edit_file", "edit"],
    ["write_to_file", "edit"],
    ["replace_file_content", "edit"],
    ["read_file", "read"],
    ["view_file", "read"],
    ["list_dir", "read"],
    ["grep_search", "read"],
    ["find_by_name", "read"],
    ["read_url_content", "fetch"],
    ["search_web", "fetch"],
    ["invoke_subagent", "other"],
  ];

  it.each(kinds)("tool_%s_maps_to_kind_%s", (name, kind) => {
    const [event] = stepEvents(
      step({
        step_type: "tool",
        state: "ACTIVE",
        tool_name: name,
        tool_info: { name, parameters: { Anything: 1 } },
      }),
      CONV,
    );

    expect(event).toMatchObject({ type: "tool_call", kind });
  });
});

describe("agy tool titles and outcomes", () => {
  it("title_prefers_command_line_then_path_then_tool_name", () => {
    const titleOf = (parameters: Record<string, unknown>): unknown =>
      stepEvents(
        step({
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "view_file",
          tool_info: { parameters },
        }),
        CONV,
      )[0];

    expect(titleOf({ CommandLine: "ls", Path: "/a" })).toMatchObject({
      title: "ls",
    });
    expect(titleOf({ Path: "/a" })).toMatchObject({ title: "/a" });
    expect(titleOf({ Limit: 3 })).toMatchObject({ title: "view_file" });
  });

  it("done_without_output_is_completed_except_for_run_command", () => {
    const done = (name: string): unknown[] =>
      stepEvents(
        step({ step_type: "tool", tool_name: name, tool_info: { name } }),
        CONV,
      );

    expect(done("write_file")).toEqual([
      { type: "tool_call_update", toolCallId: "conv-9:1", status: "completed" },
    ]);
    expect(done("run_command")).toEqual([
      {
        type: "tool_call_update",
        toolCallId: "conv-9:1",
        status: "failed",
        output: "no output; agy may have denied this command in headless mode",
      },
    ]);
  });

  it("error_without_a_message_fails_the_card_without_output", () => {
    const events = stepEvents(
      step({ step_type: "tool", state: "ERROR", tool_name: "write_file" }),
      CONV,
    );

    expect(events).toEqual([
      { type: "tool_call_update", toolCallId: "conv-9:1", status: "failed" },
    ]);
  });
});

describe("agy turn tracker", () => {
  it("sticky_result_error_is_not_new", () => {
    const tracker = new TurnTracker();
    tracker.observeStep(
      step({ state: "ACTIVE", step_index: 2, text_delta: "ok" }),
      CONV,
    );

    const outcome = tracker.settle(
      result({
        status: "ERROR",
        error: QUOTA_TEXT,
        finished_reason: "error",
        response: "ok",
      }),
    );

    expect(outcome).toEqual({ kind: "ended" });
  });

  it("error_message_without_a_later_response_is_a_quota_failure", () => {
    const tracker = new TurnTracker();
    tracker.observeStep(step({ step_type: "error_message" }), CONV);

    const outcome = tracker.settle(
      result({ status: "ERROR", error: QUOTA_TEXT, finished_reason: "error" }),
    );

    expect(outcome).toEqual({ kind: "quota", message: QUOTA_TEXT });
  });

  it("response_after_error_message_is_api_retry_once_and_clears_the_failure", () => {
    const tracker = new TurnTracker();
    tracker.observeStep(step({ step_type: "error_message" }), CONV);

    const first = tracker.observeStep(
      step({ state: "ACTIVE", step_index: 2, text_delta: "A" }),
      CONV,
    );
    const second = tracker.observeStep(
      step({ state: "ACTIVE", step_index: 2, text_delta: "B" }),
      CONV,
    );

    expect(first.map((event) => event.type)).toEqual(["api_retry", "text"]);
    expect(second.map((event) => event.type)).toEqual(["text"]);
    expect(
      tracker.settle(result({ status: "ERROR", error: QUOTA_TEXT })),
    ).toEqual({
      kind: "ended",
    });
  });
});

describe("agy turn failure classification", () => {
  it("new_stderr_error_lines_win_over_the_cumulative_result_error", () => {
    const tracker = new TurnTracker();
    tracker.observeErrorLine({
      short_error: "model overloaded",
      status: "UNAVAILABLE",
      error_code: 503,
    });

    const outcome = tracker.settle(
      result({ status: "ERROR", error: QUOTA_TEXT, finished_reason: "error" }),
    );

    expect(outcome).toEqual({
      kind: "failed",
      message: "model overloaded UNAVAILABLE 503",
    });
  });

  it("quota_markers_are_matched_case_insensitively_in_stderr_lines", () => {
    const tracker = new TurnTracker();
    tracker.observeErrorLine({ short_error: "You have exhausted your quota" });

    expect(tracker.failure()).toEqual({
      kind: "quota",
      message: "You have exhausted your quota",
    });
  });

  it("auth_text_is_an_auth_failure_and_empty_text_a_generic_one", () => {
    const auth = new TurnTracker();
    auth.observeErrorLine({ short_error: "UNAUTHENTICATED token expired" });
    const generic = new TurnTracker();
    generic.observeStep(step({ step_type: "error_message" }), CONV);

    expect(auth.failure()).toMatchObject({ kind: "auth" });
    expect(generic.failure()).toEqual({
      kind: "failed",
      message: "The model request failed",
    });
  });
});

describe("agy turn result classification", () => {
  it("result_auth_error_without_any_response_is_an_auth_failure", () => {
    const tracker = new TurnTracker();

    const outcome = tracker.settle(
      result({
        conversation_id: "",
        status: "ERROR",
        error: "authentication failed or timed out",
        finished_reason: "error",
      }),
    );

    expect(outcome).toEqual({
      kind: "auth",
      message: "authentication failed or timed out",
    });
  });

  it("result_auth_error_after_a_response_is_sticky_and_ignored", () => {
    const tracker = new TurnTracker();
    tracker.observeStep(
      step({ state: "ACTIVE", step_index: 2, text_delta: "fine" }),
      CONV,
    );

    const outcome = tracker.settle(
      result({
        status: "ERROR",
        error: "authentication failed or timed out",
      }),
    );

    expect(outcome).toEqual({ kind: "ended" });
  });

  it("interrupted_result_is_cancelled_even_with_an_error_text", () => {
    const tracker = new TurnTracker();

    const outcome = tracker.settle(
      result({
        status: "ERROR",
        error: "interrupted",
        finished_reason: "interrupted",
      }),
    );

    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("failure_without_a_result_is_null_for_a_clean_turn", () => {
    expect(new TurnTracker().failure()).toBeNull();
  });
});

describe("agy turn result error freshness", () => {
  const failedResult = result({
    status: "ERROR",
    error: QUOTA_TEXT,
    finished_reason: "error",
  });

  function failedTracker(): TurnTracker {
    const tracker = new TurnTracker();
    tracker.observeStep(step({ step_type: "error_message" }), CONV);
    return tracker;
  }

  it("a_result_error_identical_to_the_previous_one_is_not_quota", () => {
    expect(failedTracker().settle(failedResult, QUOTA_TEXT)).toEqual({
      kind: "failed",
      message: "The model request failed",
    });
  });

  it("only_the_text_appended_to_the_previous_result_error_is_classified", () => {
    const appended = result({
      status: "ERROR",
      error: `${QUOTA_TEXT} then: model overloaded`,
      finished_reason: "error",
    });

    expect(failedTracker().settle(appended, QUOTA_TEXT)).toEqual({
      kind: "failed",
      message: "then: model overloaded",
    });
  });

  it("a_first_result_error_is_classified_in_full", () => {
    expect(failedTracker().settle(failedResult)).toMatchObject({
      kind: "quota",
    });
  });

  it("a_failed_turn_without_an_error_line_awaits_one_after_its_result", () => {
    const tracker = failedTracker();

    expect(tracker.awaitsErrorLine(failedResult)).toBe(true);
    tracker.observeErrorLine({ short_error: "boom" });
    expect(tracker.awaitsErrorLine(failedResult)).toBe(false);
    expect(new TurnTracker().awaitsErrorLine(result())).toBe(false);
  });
});

describe("agy turn error line arrival", () => {
  async function isPending(promise: Promise<undefined>): Promise<boolean> {
    const marker = Symbol("pending");
    return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
  }

  it("an_error_line_resolves_the_arrival_promise", async () => {
    const tracker = new TurnTracker();
    const arrival = tracker.errorLineSeen;
    expect(await isPending(arrival)).toBe(true);

    tracker.observeErrorLine({ short_error: "boom" });

    expect(await isPending(arrival)).toBe(false);
  });

  it("a_recovery_after_an_error_line_makes_the_next_wait_pending_again", async () => {
    const tracker = new TurnTracker();
    tracker.observeStep(step({ step_type: "error_message" }), CONV);
    tracker.observeErrorLine({ short_error: "boom" });

    const events = tracker.observeStep(step({ step_index: 2 }), CONV);

    expect(events[0]).toEqual({ type: "api_retry" });
    expect(await isPending(tracker.errorLineSeen)).toBe(true);
  });

  it("a_recovery_without_an_error_line_keeps_the_same_promise", () => {
    const tracker = new TurnTracker();
    const before = tracker.errorLineSeen;
    tracker.observeStep(step({ step_type: "error_message" }), CONV);

    tracker.observeStep(step({ step_index: 2 }), CONV);

    expect(tracker.errorLineSeen).toBe(before);
  });
});
