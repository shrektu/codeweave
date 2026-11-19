import { describe, expect, it } from "vitest";

import type { ApiKeyCredentials, ConsoleLoginCredentials } from "../config";

import { buildV2CatalogConfig, buildV2SessionConfig } from "./config";

const KEY_FILE = "/run/user/1000/codeweave-opencode-x/api-key";

const CONSOLE: ConsoleLoginCredentials = {
  auth: "console_login",
  providerId: "opencode-go",
  model: "kimi-k2.7-code",
  baseUrl: null,
};

const BUILT_IN: ApiKeyCredentials = {
  auth: "api_key",
  providerId: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  apiKey: "sk-test-fake",
};

const CUSTOM: ApiKeyCredentials = {
  auth: "api_key",
  providerId: "acme",
  model: "acme-1",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test-fake",
};

const ASKED = ["shell", "edit", "webfetch", "external_directory"].map(
  (action) => ({ action, resource: "*", effect: "ask" }),
);

describe("buildV2CatalogConfig", () => {
  it("denies_every_provider_then_allows_and_configures_each_id", () => {
    expect(buildV2CatalogConfig(KEY_FILE, ["groq", "mistral"])).toEqual({
      update: "disable",
      share: "disabled",
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "groq", effect: "allow" },
        { action: "provider.use", resource: "mistral", effect: "allow" },
      ],
      providers: {
        groq: { settings: { apiKey: `{file:${KEY_FILE}}` } },
        mistral: { settings: { apiKey: `{file:${KEY_FILE}}` } },
      },
    });
  });
});

describe("buildV2SessionConfig", () => {
  it("built_in_provider_config_matches_the_2x_shape", () => {
    expect(
      buildV2SessionConfig({ credentials: BUILT_IN, keyFilePath: KEY_FILE }),
    ).toEqual({
      model: "groq/llama-3.3-70b",
      update: "disable",
      share: "disabled",
      agents: { title: { model: "groq/llama-3.3-70b" } },
      permissions: ASKED,
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "groq", effect: "allow" },
      ],
      providers: { groq: { settings: { apiKey: `{file:${KEY_FILE}}` } } },
    });
  });

  it("custom_provider_config_declares_package_base_url_and_models", () => {
    const config = buildV2SessionConfig({
      credentials: CUSTOM,
      keyFilePath: KEY_FILE,
    });

    expect(config.model).toBe("acme/acme-1");
    expect(config.policies[1]).toEqual({
      action: "provider.use",
      resource: "acme",
      effect: "allow",
    });
    expect(config.providers).toEqual({
      acme: {
        package: "@ai-sdk/openai-compatible",
        settings: {
          apiKey: `{file:${KEY_FILE}}`,
          baseURL: "https://example.test/v1",
        },
        models: { "acme-1": { name: "acme-1" } },
      },
    });
  });

  it("console login config has no providers entry and no file reference", () => {
    const config = buildV2SessionConfig({
      credentials: CONSOLE,
      keyFilePath: null,
    });

    expect(config.providers).toEqual({});
    expect(config.model).toBe("opencode-go/kimi-k2.7-code");
    expect(config.agents).toEqual({
      title: { model: "opencode-go/kimi-k2.7-code" },
    });
    expect(config.policies.map((rule) => [rule.resource, rule.effect])).toEqual(
      [
        ["*", "deny"],
        ["opencode-go", "allow"],
      ],
    );
    expect(JSON.stringify(config)).not.toContain("{file:");
  });

  it("config_carries_the_key_only_as_a_file_reference", () => {
    const serialized = JSON.stringify(
      buildV2SessionConfig({ credentials: CUSTOM, keyFilePath: KEY_FILE }),
    );

    expect(serialized).not.toContain(CUSTOM.apiKey);
    expect(serialized).toContain(`{file:${KEY_FILE}}`);
  });
});
