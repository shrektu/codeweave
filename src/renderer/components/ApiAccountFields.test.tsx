import { expect, it } from "vitest";

import { ApiProviderId } from "../../domain/apiProviders";
import { makeCatalogModel } from "../../../tests/fakes/fakeIpcClient";

import { INITIAL_API_DRAFT, withPickedModel } from "./ApiAccountFields";

it("picking_model_of_other_provider_switches_api_provider", () => {
  const deepseekDraft = {
    ...INITIAL_API_DRAFT,
    provider: ApiProviderId.deepseek,
    rotation: false,
    apiKey: "sk-test-fake-key-A",
  };

  const picked = withPickedModel(
    deepseekDraft,
    makeCatalogModel({
      providerId: ApiProviderId.google,
      modelId: "gemini-flash",
    }),
  );

  expect(picked).toEqual({
    provider: "google",
    model: "gemini-flash",
    baseUrl: "",
    rotation: true,
    apiKey: "sk-test-fake-key-A",
  });
});

it("picking_model_of_same_provider_keeps_manual_rotation", () => {
  const draft = {
    ...INITIAL_API_DRAFT,
    provider: ApiProviderId.groq,
    rotation: false,
  };

  const picked = withPickedModel(
    draft,
    makeCatalogModel({ providerId: ApiProviderId.groq, modelId: "llama-fast" }),
  );

  expect(picked.rotation).toBe(false);
  expect(picked.model).toBe("llama-fast");
});
