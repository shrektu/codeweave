import { describe, expect, it } from "vitest";

import { ApiAuth, ApiProviderId } from "../domain/apiProviders";
import { ProviderId } from "../domain/types";
import type { AccountView, SessionView, TurnRouteView } from "../shared/views";

import {
  hasUnknownApiProvider,
  modelSuggestions,
  servedModel,
  sessionModelText,
  turnBadge,
} from "./routingText";

function turn(overrides: Partial<TurnRouteView>): TurnRouteView {
  return {
    promptSeq: 0,
    accountId: "acc-1",
    model: "openai/gpt-oss-20b",
    effectiveModel: null,
    apiProvider: ApiProviderId.groq,
    requestedClass: "light",
    servedClass: "light",
    source: "routed",
    ...overrides,
  };
}

function account(api: AccountView["api"]): AccountView {
  return {
    id: "acc-1",
    provider: ProviderId.opencode,
    label: "Groq",
    configDir: "/tmp/acc",
    order: 0,
    api,
    hasKey: true,
    keyHint: null,
    runtime: { status: "ready" },
    limit: null,
    limitAvailability: "pending",
  };
}

const BADGE_CASES: [string, Partial<TurnRouteView>, string][] = [
  ["routed as requested", {}, "groq/openai/gpt-oss-20b · light"],
  [
    "routed to another class",
    { requestedClass: "heavy", servedClass: "standard" },
    "groq/openai/gpt-oss-20b · heavy → standard",
  ],
  [
    "effective model is shown as the CLI reported it",
    { effectiveModel: "openai/gpt-oss-120b" },
    "openai/gpt-oss-120b · light",
  ],
  [
    "effective model already prefixed",
    { effectiveModel: "groq/openai/gpt-oss-120b" },
    "groq/openai/gpt-oss-120b · light",
  ],
  [
    "override",
    { source: "override", servedClass: null, requestedClass: "heavy" },
    "groq/openai/gpt-oss-20b · override",
  ],
  [
    "agent model",
    { source: "agent", servedClass: null },
    "groq/openai/gpt-oss-20b · agent model",
  ],
  [
    "account model",
    { source: "account", servedClass: null, requestedClass: "standard" },
    "groq/openai/gpt-oss-20b · standard · not routed",
  ],
  [
    "cli default",
    {
      source: "cli_default",
      servedClass: null,
      model: null,
      apiProvider: null,
      requestedClass: "heavy",
    },
    "CLI default · heavy · not routed",
  ],
  [
    "subscription model without api provider",
    {
      source: "override",
      servedClass: null,
      apiProvider: null,
      model: "opus",
    },
    "opus · override",
  ],
];

describe("turnBadge", () => {
  it.each(BADGE_CASES)("%s", (_name, overrides, expected) => {
    expect(turnBadge(turn(overrides)).text).toBe(expected);
  });

  it("describes the turn in a full sentence", () => {
    expect(turnBadge(turn({})).description).toBe(
      "This turn used groq/openai/gpt-oss-20b (light)",
    );
  });
});

function sessionOf(overrides: Partial<SessionView>): SessionView {
  return {
    id: "s1",
    cwd: "/work",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: "ask",
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    activeProvider: ProviderId.claude,
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    contextUsage: null,
    turns: [],
    orchestrate: false,
    ...overrides,
  };
}

describe("sessionModelText", () => {
  it("shows the model the CLI reports now", () => {
    const session = sessionOf({
      currentModel: "claude-opus-5-5",
      turns: [turn({ effectiveModel: "claude-sonnet-4-5" })],
    });

    expect(sessionModelText(session)).toBe("claude-opus-5-5");
  });

  it("falls back to the label of the last turn", () => {
    const session = sessionOf({
      turns: [turn({ model: "opus", apiProvider: null })],
    });

    expect(sessionModelText(session)).toBe("opus");
  });

  it("says CLI default when nothing is known", () => {
    expect(sessionModelText(sessionOf({}))).toBe("CLI default");
  });
});

describe("servedModel", () => {
  it("prefers the reported model over the requested one", () => {
    expect(servedModel(turn({ effectiveModel: "reported" }))).toBe("reported");
  });

  it("uses the requested model when none was reported", () => {
    expect(servedModel(turn({}))).toBe("openai/gpt-oss-20b");
  });

  it("is null when neither is known", () => {
    expect(servedModel(turn({ model: null }))).toBeNull();
  });
});

describe("modelSuggestions", () => {
  it("lists the provider tiers and the account model once", () => {
    expect(
      modelSuggestions(
        account({
          provider: ApiProviderId.groq,
          model: "openai/gpt-oss-120b",
          baseUrl: null,
          rotation: true,
          auth: ApiAuth.apiKey,
        }),
      ),
    ).toEqual(["groq/openai/gpt-oss-20b", "groq/openai/gpt-oss-120b"]);
  });

  it("adds a configured model missing from the tiers", () => {
    expect(
      modelSuggestions(
        account({
          provider: ApiProviderId.custom,
          model: "my-model",
          baseUrl: "http://localhost:1",
          rotation: true,
          auth: ApiAuth.apiKey,
        }),
      ),
    ).toEqual(["custom/my-model"]);
  });

  it("suggestions skip models the free tier guard rejects", () => {
    expect(
      modelSuggestions(
        account({
          provider: ApiProviderId.zai,
          model: "glm-4.7-flash",
          baseUrl: null,
          rotation: true,
          auth: ApiAuth.apiKey,
        }),
      ),
    ).toEqual(["zai/glm-4.7-flash"]);
    expect(
      modelSuggestions(
        account({
          provider: ApiProviderId.zai,
          model: "my-own-glm",
          baseUrl: null,
          rotation: true,
          auth: ApiAuth.apiKey,
        }),
      ),
    ).toEqual(["zai/glm-4.7-flash", "zai/my-own-glm"]);
  });

  it("suggestions list every row for a paid provider", () => {
    expect(
      modelSuggestions(
        account({
          provider: ApiProviderId.groq,
          model: "openai/gpt-oss-20b",
          baseUrl: null,
          rotation: true,
          auth: ApiAuth.apiKey,
        }),
      ),
    ).toEqual(["groq/openai/gpt-oss-20b", "groq/openai/gpt-oss-120b"]);
  });

  it("is empty for subscription accounts and without an account", () => {
    expect(modelSuggestions(account(null))).toEqual([]);
    expect(modelSuggestions(null)).toEqual([]);
  });
});

describe("hasUnknownApiProvider", () => {
  it.each<[string, boolean]>([
    ["", false],
    ["auto", false],
    ["AUTO", false],
    ["groq/openai/gpt-oss-20b", false],
    ["  cerebras/gpt-oss-120b ", false],
    ["grok/llama", true],
    ["gpt-oss-20b", true],
  ])("%j -> %s", (model, expected) => {
    expect(hasUnknownApiProvider(model)).toBe(expected);
  });
});
