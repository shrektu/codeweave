import { describe, expect, it } from "vitest";

import type { OpencodeCredentials } from "../config";

import { buildV2SessionConfig } from "./config";

const KEY_FILE = "/run/user/1000/codeweave-opencode-x/api-key";

const BUILT_IN: OpencodeCredentials = {
  providerId: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  apiKey: "sk-test-fake",
};

const CUSTOM: OpencodeCredentials = {
  providerId: "acme",
  model: "acme-1",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test-fake",
};

const ASKED = ["shell", "edit", "webfetch", "external_directory"].map(
  (action) => ({ action, resource: "*", effect: "ask" }),
);

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

  it("config_carries_the_key_only_as_a_file_reference", () => {
    const serialized = JSON.stringify(
      buildV2SessionConfig({ credentials: CUSTOM, keyFilePath: KEY_FILE }),
    );

    expect(serialized).not.toContain(CUSTOM.apiKey);
    expect(serialized).toContain(`{file:${KEY_FILE}}`);
  });
});
