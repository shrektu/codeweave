import { describe, expect, it } from "vitest";

import { ApiProviderId } from "./apiProviders";
import {
  classByAllowance,
  GO_TIERS_CHECKED_ON,
  MODEL_TIERS,
  TIERS_CHECKED_ON,
} from "./modelTiers";
import { TaskClass } from "./taskClass";

const EXPECTED_ROWS = 33;
const EXCLUDED_PROVIDERS: readonly ApiProviderId[] = [
  ApiProviderId.openrouter,
  ApiProviderId.moonshotai,
  ApiProviderId.custom,
];

const GO_ROWS = MODEL_TIERS.filter(
  (tier) => tier.provider === ApiProviderId.opencodeGo,
);

describe("MODEL_TIERS", () => {
  it("has every row with an https source and the check date", () => {
    expect(MODEL_TIERS).toHaveLength(EXPECTED_ROWS);
    for (const tier of MODEL_TIERS) {
      expect(tier.sourceUrl.startsWith("https://")).toBe(true);
      expect(tier.checkedOn).toBe(
        tier.provider === ApiProviderId.opencodeGo
          ? "2026-11-18"
          : "2026-11-17",
      );
    }
  });

  it("pins the check dates", () => {
    expect(TIERS_CHECKED_ON).toBe("2026-11-17");
    expect(GO_TIERS_CHECKED_ON).toBe("2026-11-18");
  });

  it("has unique provider and model pairs", () => {
    const pairs = MODEL_TIERS.map((tier) => `${tier.provider}/${tier.modelId}`);

    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("has no rows for providers without published tiers", () => {
    const providers = MODEL_TIERS.map((tier) => tier.provider);

    for (const excluded of EXCLUDED_PROVIDERS) {
      expect(providers).not.toContain(excluded);
    }
  });
});

describe("classByAllowance", () => {
  it.each<[number, TaskClass]>([
    [1, TaskClass.heavy],
    [499, TaskClass.heavy],
    [500, TaskClass.standard],
    [2999, TaskClass.standard],
    [3000, TaskClass.light],
    [30100, TaskClass.light],
  ])("%i requests per 5 h is %s", (requests, expected) => {
    expect(classByAllowance(requests)).toBe(expected);
  });
});

describe("OpenCode Go rows", () => {
  it("go_rows_follow_the_allowance_bands", () => {
    expect(
      GO_ROWS.map((row) => [row.modelId, row.taskClass, row.requestsPer5h]),
    ).toEqual([
      ["kimi-k3", "heavy", 98],
      ["kimi-k3.1-pro", "heavy", 147],
      ["qwen3.8-max", "heavy", 162],
      ["grok-4.7", "heavy", 169],
      ["kimi-k2.7-code", "standard", 994],
      ["glm-5.2", "standard", 792],
      ["gpt-5.6-luna", "standard", 2050],
      ["mimo-v2.6-flash", "light", 30100],
      ["longcat-2.0", "light", 11400],
      ["glm-5.3-flash", "light", 6320],
      ["qwen3.8-flash", "light", 5400],
      ["qwen3.7-plus", "light", 4310],
      ["hy3", "light", 4300],
      ["gpt-6-luna", "light", 4230],
      ["minimax-m3.1-flash", "light", 3880],
      ["claude-haiku-5-5", "light", 3850],
      ["mimo-v2.6-pro", "light", 3260],
      ["minimax-m3", "light", 3210],
    ]);
  });

  it("first_go_row_of_each_class_is_the_band_default", () => {
    const firstOf = (taskClass: TaskClass): string | undefined =>
      GO_ROWS.find((row) => row.taskClass === taskClass)?.modelId;

    expect(firstOf(TaskClass.heavy)).toBe("kimi-k3");
    expect(firstOf(TaskClass.standard)).toBe("kimi-k2.7-code");
    expect(firstOf(TaskClass.light)).toBe("mimo-v2.6-flash");
  });

  it("go_rows_carry_flat_rate_prices_and_source", () => {
    const [first] = GO_ROWS;

    expect(first).toEqual({
      provider: "opencode-go",
      modelId: "kimi-k3",
      taskClass: "heavy",
      free: false,
      priceInUsdPerMTok: 3,
      priceOutUsdPerMTok: 15,
      requestsPer5h: 98,
      sourceUrl: "https://opencode.ai/go",
      checkedOn: "2026-11-18",
    });
    expect(GO_ROWS.every((row) => !row.free)).toBe(true);
  });
});
