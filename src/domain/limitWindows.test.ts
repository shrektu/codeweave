import { expect, it } from "vitest";

import {
  mergeLimitWindows,
  scopedWindowId,
  windowOfRateLimitType,
  type LimitWindow,
} from "./limitWindows";

function windowOf(id: string, utilization: number): LimitWindow {
  return {
    id,
    scope: null,
    period: null,
    utilization,
    resetsAt: null,
    exhausted: false,
  };
}

const BASE_INPUT = {
  utilization: 0.4,
  resetsAt: 1_700_000_000,
  exhausted: false,
};

it("merge_replaces_by_id_and_keeps_the_rest", () => {
  const merged = mergeLimitWindows(
    [windowOf("a", 0.1), windowOf("b", 0.2)],
    [windowOf("c", 0.9), windowOf("b", 0.5)],
  );

  expect(merged).toEqual([
    windowOf("a", 0.1),
    windowOf("b", 0.5),
    windowOf("c", 0.9),
  ]);
});

it("single_window_mapping_per_rate_limit_type", () => {
  expect(
    windowOfRateLimitType({ ...BASE_INPUT, rateLimitType: "five_hour" }),
  ).toEqual({
    id: "five_hour",
    scope: null,
    period: "five_hour",
    utilization: 0.4,
    resetsAt: 1_700_000_000,
    exhausted: false,
  });
  expect(
    windowOfRateLimitType({ ...BASE_INPUT, rateLimitType: "seven_day_opus" }),
  ).toMatchObject({ id: "seven_day:opus", scope: "Opus", period: "seven_day" });
  expect(
    windowOfRateLimitType({
      ...BASE_INPUT,
      rateLimitType: "seven_day_sonnet",
    }),
  ).toMatchObject({
    id: "seven_day:sonnet",
    scope: "Sonnet",
    period: "seven_day",
  });
  expect(
    windowOfRateLimitType({ ...BASE_INPUT, rateLimitType: "overage" }),
  ).toMatchObject({ id: "overage", scope: null, period: "overage" });
  expect(
    windowOfRateLimitType({ ...BASE_INPUT, rateLimitType: null }),
  ).toBeNull();
});

it("scoped_id_ignores_scope_case", () => {
  expect(scopedWindowId("seven_day", "Opus")).toBe("seven_day:opus");
  expect(scopedWindowId("seven_day", "OPUS")).toBe("seven_day:opus");
  expect(scopedWindowId("seven_day", null)).toBe("seven_day");
});
