import { expect, it } from "vitest";

import { ApiAuth, ApiProviderId } from "../../domain/apiProviders";
import { makeCatalogModel } from "../../../tests/fakes/fakeIpcClient";

import {
  INITIAL_API_DRAFT,
  toApiParams,
  validateApiDraft,
  withPickedModel,
  withProvider,
  type ApiDraft,
} from "./ApiAccountFields";

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
    auth: "api_key",
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

const GO_CONSOLE_DRAFT: ApiDraft = {
  ...INITIAL_API_DRAFT,
  provider: ApiProviderId.opencodeGo,
  model: " kimi-k2.7-code ",
  auth: ApiAuth.consoleLogin,
};

it("switching to a provider without console login resets the sign-in choice", () => {
  expect(withProvider(GO_CONSOLE_DRAFT, ApiProviderId.groq).auth).toBe(
    "api_key",
  );
  expect(withProvider(GO_CONSOLE_DRAFT, ApiProviderId.opencodeZen).auth).toBe(
    "console_login",
  );
});

it("picking a model of a provider without console login resets the choice", () => {
  const groq = makeCatalogModel({
    providerId: ApiProviderId.groq,
    modelId: "llama-fast",
  });
  const zen = makeCatalogModel({
    providerId: ApiProviderId.opencodeZen,
    modelId: "zen-1",
  });

  expect(withPickedModel(GO_CONSOLE_DRAFT, groq).auth).toBe("api_key");
  expect(withPickedModel(GO_CONSOLE_DRAFT, zen).auth).toBe("console_login");
});

it("toApiParams omits the key for console login", () => {
  const params = toApiParams({ ...GO_CONSOLE_DRAFT, apiKey: "left-over" });

  expect(params).toEqual({
    api: {
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      baseUrl: null,
      rotation: true,
      auth: "console_login",
    },
  });
  expect(Object.hasOwn(params, "apiKey")).toBe(false);
});

it("toApiParams sends the key for api key auth", () => {
  expect(
    toApiParams({
      ...INITIAL_API_DRAFT,
      model: "llama",
      apiKey: "sk-test-fake",
    }),
  ).toEqual({
    api: {
      provider: "groq",
      model: "llama",
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: "sk-test-fake",
  });
});

it("console login draft needs no api key", () => {
  expect(validateApiDraft(GO_CONSOLE_DRAFT)).toBeNull();
  expect(validateApiDraft({ ...GO_CONSOLE_DRAFT, auth: ApiAuth.apiKey })).toBe(
    "API key is required",
  );
});
