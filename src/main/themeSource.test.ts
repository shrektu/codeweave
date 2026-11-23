import { describe, expect, it } from "vitest";

import { themeSourceOf } from "./themeSource";

describe("themeSourceOf", () => {
  it.each(["system", "light", "dark"])("accepts %s", (value) => {
    expect(themeSourceOf(value)).toBe(value);
  });

  it.each([
    ["unknown string", "neon"],
    ["wrong case", "Dark"],
    ["number", 1],
    ["undefined", undefined],
    ["null", null],
    ["object", { value: "dark" }],
  ])("main_theme_source_rejects_unknown_value: %s", (_label, value) => {
    expect(themeSourceOf(value)).toBeNull();
  });
});
