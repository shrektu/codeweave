import { describe, expect, it } from "vitest";

import { contextUsageOf } from "./contextUsage";

describe("contextUsageOf", () => {
  it("context_usage_of_rejects_negative_or_fractional_used", () => {
    expect(contextUsageOf(-1, 100)).toBeNull();
    expect(contextUsageOf(1.5, 100)).toBeNull();
    expect(contextUsageOf(Number.NaN, 100)).toBeNull();
    expect(contextUsageOf(Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(contextUsageOf(0, 0)).toEqual({ usedTokens: 0, limitTokens: null });
    expect(contextUsageOf(10, -5)).toEqual({
      usedTokens: 10,
      limitTokens: null,
    });
    expect(contextUsageOf(10, 1.5)).toEqual({
      usedTokens: 10,
      limitTokens: null,
    });
  });
});
