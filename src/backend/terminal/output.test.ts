import { describe, expect, it } from "vitest";

import {
  TERMINAL_HIGH_WATERMARK_CHARS,
  TERMINAL_LOW_WATERMARK_CHARS,
  TERMINAL_REPLAY_MAX_CHARS,
} from "../constants";

import { FlowAction, FlowGate, ReplayRing } from "./output";

const CAPACITY = TERMINAL_REPLAY_MAX_CHARS;
const GRINNING_FACE = "\u{1F600}";

describe("ReplayRing", () => {
  it("keeps_everything_up_to_the_exact_capacity", () => {
    const ring = new ReplayRing();

    ring.append("a".repeat(CAPACITY));

    expect(ring.snapshot()).toBe("a".repeat(CAPACITY));
  });

  it("replay_trim_starts_at_line_boundary", () => {
    const ring = new ReplayRing();

    ring.append(`${"A".repeat(10)}\n`);
    ring.append(`${"B".repeat(CAPACITY - 8)}\n`);

    expect(ring.snapshot()).toBe(`${"B".repeat(CAPACITY - 8)}\n`);
  });

  it("drops_the_rest_of_an_escape_sequence_cut_by_the_trim", () => {
    const ring = new ReplayRing();

    ring.append(`\u001b[31m${"r".repeat(CAPACITY - 10)}\nnext\n`);

    expect(ring.snapshot()).toBe("next\n");
  });

  it("cuts_at_the_capacity_when_the_kept_text_has_no_line_break", () => {
    const ring = new ReplayRing();

    ring.append("a".repeat(CAPACITY));
    ring.append("bc");

    expect(ring.snapshot()).toBe(`${"a".repeat(CAPACITY - 2)}bc`);
  });

  it("never_starts_inside_a_surrogate_pair", () => {
    const ring = new ReplayRing();

    ring.append(`${GRINNING_FACE}${"z".repeat(CAPACITY - 1)}`);

    expect(ring.snapshot()).toBe("z".repeat(CAPACITY - 1));
  });

  it("keeps_a_whole_surrogate_pair_at_the_start_when_it_fits", () => {
    const ring = new ReplayRing();

    ring.append(`ab${GRINNING_FACE}${"z".repeat(CAPACITY - 2)}`);

    expect(ring.snapshot()).toBe(`${GRINNING_FACE}${"z".repeat(CAPACITY - 2)}`);
  });
});

describe("FlowGate", () => {
  it("does_not_pause_at_exactly_the_high_watermark", () => {
    const gate = new FlowGate();

    expect(gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS)).toBe(FlowAction.none);
  });

  it("pauses_once_one_char_above_the_high_watermark", () => {
    const gate = new FlowGate();
    gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS);

    expect(gate.onSent(1)).toBe(FlowAction.pause);
    expect(gate.onSent(1000)).toBe(FlowAction.none);
  });

  it("does_not_resume_at_exactly_the_low_watermark", () => {
    const gate = new FlowGate();
    gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS + 1);

    const action = gate.onAck(
      TERMINAL_HIGH_WATERMARK_CHARS + 1 - TERMINAL_LOW_WATERMARK_CHARS,
    );

    expect(action).toBe(FlowAction.none);
  });

  it("resumes_one_char_below_the_low_watermark", () => {
    const gate = new FlowGate();
    gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS + 1);

    const action = gate.onAck(
      TERMINAL_HIGH_WATERMARK_CHARS + 2 - TERMINAL_LOW_WATERMARK_CHARS,
    );

    expect(action).toBe(FlowAction.resume);
  });

  it("ignores_an_ack_larger_than_what_was_sent", () => {
    const gate = new FlowGate();
    gate.onSent(100);

    const action = gate.onAck(1_000_000);

    expect(action).toBe(FlowAction.none);
    expect(gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS)).toBe(FlowAction.none);
    expect(gate.onSent(1)).toBe(FlowAction.pause);
  });

  it("does_not_resume_a_gate_that_never_paused", () => {
    const gate = new FlowGate();
    gate.onSent(10);

    expect(gate.onAck(10)).toBe(FlowAction.none);
  });

  it("reset_resumes_a_paused_gate_and_forgets_the_backlog", () => {
    const gate = new FlowGate();
    gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS + 1);

    const resetAction = gate.reset();

    expect(resetAction).toBe(FlowAction.resume);
    expect(gate.reset()).toBe(FlowAction.none);
    expect(gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS)).toBe(FlowAction.none);
  });

  it("can_pause_again_after_a_resume", () => {
    const gate = new FlowGate();
    gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS + 1);
    gate.onAck(TERMINAL_HIGH_WATERMARK_CHARS + 1);

    expect(gate.onSent(TERMINAL_HIGH_WATERMARK_CHARS + 1)).toBe(
      FlowAction.pause,
    );
  });
});
