import { expect, it } from "vitest";

import { clampDockHeight } from "./dockSize";

const COLUMN = 1000;

it("dock_height_is_clamped_to_the_minimum", () => {
  expect(clampDockHeight(0, COLUMN)).toBe(120);
  expect(clampDockHeight(-50, COLUMN)).toBe(120);
});

it("dock_height_is_clamped_to_seventy_percent_of_the_column", () => {
  expect(clampDockHeight(5000, COLUMN)).toBe(700);
});

it("dock_height_inside_the_bounds_is_kept", () => {
  expect(clampDockHeight(300, COLUMN)).toBe(300);
});

it("dock_height_falls_back_to_the_default_for_nan", () => {
  expect(clampDockHeight(Number.NaN, COLUMN)).toBe(280);
});

it("dock_height_never_drops_below_the_minimum_in_a_short_column", () => {
  expect(clampDockHeight(300, 100)).toBe(120);
});

it("dock_height_ignores_the_maximum_while_the_column_is_unmeasured", () => {
  expect(clampDockHeight(900, 0)).toBe(900);
  expect(clampDockHeight(900, Number.NaN)).toBe(900);
});
