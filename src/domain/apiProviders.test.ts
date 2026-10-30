import { describe, expect, it } from "vitest";

import {
  API_PROVIDERS,
  ApiProviderId,
  PROVIDER_KEY_ENV_NAMES,
} from "./apiProviders";

describe("provider registry", () => {
  it("lists_every_provider_id_exactly_once", () => {
    expect(Object.keys(API_PROVIDERS).sort()).toEqual(
      Object.values(ApiProviderId).sort(),
    );
  });

  it("collects_every_key_variable_name", () => {
    expect([...PROVIDER_KEY_ENV_NAMES].sort()).toEqual([
      "CEREBRAS_API_KEY",
      "DEEPSEEK_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "MOONSHOT_API_KEY",
      "OPENROUTER_API_KEY",
      "ZHIPU_API_KEY",
    ]);
  });

  it("enables_rotation_by_default_only_for_free_providers", () => {
    expect(
      Object.entries(API_PROVIDERS)
        .filter(([, info]) => info.defaultRotation)
        .map(([id]) => id)
        .sort(),
    ).toEqual([
      "cerebras",
      "custom",
      "google",
      "groq",
      "mistral",
      "openrouter",
      "zai",
    ]);
  });
});
