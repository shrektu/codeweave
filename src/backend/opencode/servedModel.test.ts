import { describe, expect, it } from "vitest";

import { servedModelName } from "./servedModel";

describe("servedModelName", () => {
  it("joins provider and model", () => {
    expect(servedModelName("groq", "llama-3.3-70b")).toBe("groq/llama-3.3-70b");
  });

  it("opencode_provider_prefix_not_doubled", () => {
    expect(servedModelName("groq", "groq/llama-3.3-70b")).toBe(
      "groq/llama-3.3-70b",
    );
  });

  it("keeps a model that only shares the provider name as text", () => {
    expect(servedModelName("groq", "groqish/model")).toBe("groq/groqish/model");
  });

  it.each([undefined, ""])("provider %j leaves the model alone", (provider) => {
    expect(servedModelName(provider, "gpt-oss-20b")).toBe("gpt-oss-20b");
  });
});
