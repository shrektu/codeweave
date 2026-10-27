import { describe, expect, it } from "vitest";

import { RequestSchema, ResponseSchema } from "./protocol";

describe("RequestSchema", () => {
  it("accepts_a_valid_ping", () => {
    const parsed = RequestSchema.safeParse({
      v: 1,
      id: "a",
      method: "ping",
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ["an empty id", { v: 1, id: "", method: "ping" }],
    ["an extra key", { v: 1, id: "a", method: "ping", extra: 1 }],
    ["an unknown method", { v: 1, id: "a", method: "pong" }],
    ["a missing version", { id: "a", method: "ping" }],
    ["a non-numeric version", { v: "1", id: "a", method: "ping" }],
    ["a fractional version", { v: 1.5, id: "a", method: "ping" }],
    ["a missing id", { v: 1, method: "ping" }],
  ])("rejects_%s", (_label, payload) => {
    expect(RequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("ResponseSchema", () => {
  it("accepts_a_ping_result", () => {
    const parsed = ResponseSchema.safeParse({
      v: 1,
      id: "a",
      ok: true,
      result: { pong: true, backendPid: 42 },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts_an_error_without_request_id", () => {
    const parsed = ResponseSchema.safeParse({
      v: 1,
      id: null,
      ok: false,
      error: { code: "VALIDATION", message: "bad" },
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    [
      "an unknown error code",
      { v: 1, id: "a", ok: false, error: { code: "NOPE", message: "x" } },
    ],
    [
      "a success without a request id",
      { v: 1, id: null, ok: true, result: { pong: true, backendPid: 1 } },
    ],
    [
      "a result with pong false",
      { v: 1, id: "a", ok: true, result: { pong: false, backendPid: 1 } },
    ],
  ])("rejects_%s", (_label, payload) => {
    expect(ResponseSchema.safeParse(payload).success).toBe(false);
  });
});
