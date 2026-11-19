import { describe, expect, it } from "vitest";

import { ApiProviderId } from "./apiProviders";
import { explicitModelFor, explicitModelOn, isAutoModel } from "./modelChoice";
import { ProviderId, type Account } from "./types";

function accountOf(
  id: string,
  provider: ProviderId,
  api?: Account["api"],
): Account {
  return {
    id,
    provider,
    label: "Account",
    configDir: `/cfg/${id}`,
    order: 0,
    api,
  };
}

const CLAUDE = accountOf("acc-1", ProviderId.claude);
const GROQ = accountOf("acc-2", ProviderId.opencode, {
  provider: ApiProviderId.groq,
  model: "llama-3.3-70b-versatile",
  baseUrl: null,
  rotation: true,
  auth: "api_key",
});

describe("explicitModelFor", () => {
  it.each([
    ["no choice", CLAUDE, null, null],
    [
      "same provider",
      CLAUDE,
      { provider: ProviderId.claude, model: "claude-sonnet-4-5" },
      "claude-sonnet-4-5",
    ],
    [
      "surrounding blanks are trimmed",
      CLAUDE,
      { provider: ProviderId.claude, model: "  claude-sonnet-4-5 " },
      "claude-sonnet-4-5",
    ],
    ["auto", CLAUDE, { provider: ProviderId.claude, model: "auto" }, null],
    ["AUTO", CLAUDE, { provider: ProviderId.claude, model: "AUTO" }, null],
    [
      "padded auto",
      CLAUDE,
      { provider: ProviderId.claude, model: " auto " },
      null,
    ],
    [
      "other provider",
      CLAUDE,
      { provider: ProviderId.codex, model: "gpt-5-codex" },
      null,
    ],
  ])("%s", (_name, account, choice, expected) => {
    expect(explicitModelFor(account, choice)).toBe(expected);
  });
});

describe("explicitModelFor on opencode", () => {
  it.each([
    [
      "matching api provider",
      "groq/llama-3.3-70b-versatile",
      "llama-3.3-70b-versatile",
    ],
    [
      "further slashes stay in the model id",
      "groq/openai/gpt-oss-20b",
      "openai/gpt-oss-20b",
    ],
    ["other api provider", "cerebras/llama3.1-8b", null],
    ["no api provider prefix", "llama-3.3-70b-versatile", null],
    ["empty model id", "groq/", null],
    ["auto", "auto", null],
  ])("opencode %s", (_name, model, expected) => {
    expect(
      explicitModelFor(GROQ, { provider: ProviderId.opencode, model }),
    ).toBe(expected);
  });

  it("opencode account without api never gets a model", () => {
    const bare = accountOf("acc-3", ProviderId.opencode);

    expect(
      explicitModelFor(bare, {
        provider: ProviderId.opencode,
        model: "groq/openai/gpt-oss-20b",
      }),
    ).toBeNull();
  });
});

describe("explicitModelOn", () => {
  const choice = { provider: ProviderId.claude, model: "claude-sonnet-4-5" };

  it("resolves the account by id", () => {
    expect(explicitModelOn([GROQ, CLAUDE], "acc-1", choice)).toBe(
      "claude-sonnet-4-5",
    );
  });

  it("unknown account gets no model", () => {
    expect(explicitModelOn([CLAUDE], "acc-9", choice)).toBeNull();
  });
});

describe("isAutoModel", () => {
  it.each([
    ["auto", true],
    [" Auto ", true],
    ["automatic", false],
    ["", false],
  ])("%j", (model, expected) => {
    expect(isAutoModel(model)).toBe(expected);
  });
});
