import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseAgyErrorLine,
  parseAgyEvent,
  UsageOutputSchema,
} from "./protocol";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agy protocol parsing", () => {
  it("step_update_keeps_unknown_fields_and_types_loose", () => {
    const event = parseAgyEvent(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"brand_new","extra":{"a":1}},"future":true}',
    );

    expect(event).toMatchObject({
      event: "step_update",
      step_update: { step_index: 3, step_type: "brand_new" },
    });
  });

  it("unknown_events_and_wrong_shapes_are_null", () => {
    expect(parseAgyEvent('{"event":"telemetry","x":1}')).toBeNull();
    expect(
      parseAgyEvent('{"event":"step_update","step_update":{}}'),
    ).toBeNull();
    expect(parseAgyEvent('{"no_event":true}')).toBeNull();
    expect(parseAgyEvent("[1,2]")).toBeNull();
  });

  it("unparseable_text_is_null_and_warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(parseAgyEvent("{not json")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("agy_error_line_parses_the_documented_fields", () => {
    const line = parseAgyErrorLine(
      ' {"short_error":"boom","status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true}',
    );

    expect(line).toMatchObject({
      short_error: "boom",
      status: "RESOURCE_EXHAUSTED",
      error_code: 429,
    });
  });

  it("agy_error_line_with_bad_json_is_null", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(parseAgyErrorLine(" {oops")).toBeNull();
    expect(parseAgyErrorLine(" 12")).toBeNull();
  });

  it("usage_output_without_command_data_still_parses", () => {
    const parsed = UsageOutputSchema.safeParse({ status: "SUCCESS" });

    expect(parsed.success).toBe(true);
  });
});
