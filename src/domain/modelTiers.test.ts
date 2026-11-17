import { describe, expect, it } from "vitest";

import { ApiProviderId } from "./apiProviders";
import { MODEL_TIERS } from "./modelTiers";

const EXPECTED_ROWS = 15;
const EXCLUDED_PROVIDERS: readonly ApiProviderId[] = [
  ApiProviderId.openrouter,
  ApiProviderId.moonshotai,
  ApiProviderId.custom,
];

describe("MODEL_TIERS", () => {
  it("has every row with an https source and the check date", () => {
    expect(MODEL_TIERS).toHaveLength(EXPECTED_ROWS);
    for (const tier of MODEL_TIERS) {
      expect(tier.sourceUrl.startsWith("https://")).toBe(true);
      expect(tier.checkedOn).toBe("2026-11-17");
    }
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
