import { describe, expect, it } from "vitest";

import { ApiProviderId } from "../domain/apiProviders";
import { INITIAL_SESSION_STATE } from "../domain/sessionReducer";
import { TaskClass } from "../domain/taskClass";
import { ProviderId, type Account } from "../domain/types";

import {
  beginPrompt,
  recordTurn,
  routeSessionTurn,
  type TurnRoutingSpec,
} from "./turnRouting";

const GROQ: Account = {
  id: "acc-groq",
  provider: ProviderId.opencode,
  label: "Groq",
  configDir: "/cfg/groq",
  order: 0,
  api: {
    provider: ApiProviderId.groq,
    model: "llama-3.3-70b-versatile",
    baseUrl: null,
    rotation: true,
    auth: "api_key",
  },
};
const CEREBRAS: Account = {
  ...GROQ,
  id: "acc-cerebras",
  label: "Cerebras",
  order: 1,
  api: {
    provider: ApiProviderId.cerebras,
    model: "gpt-oss-120b",
    baseUrl: null,
    rotation: true,
    auth: "api_key",
  },
};
const CLAUDE: Account = {
  id: "acc-claude",
  provider: ProviderId.claude,
  label: "Claude",
  configDir: "/cfg/claude",
  order: 2,
};
const SPEC: TurnRoutingSpec = {
  taskClass: null,
  model: null,
  defaultTaskClass: TaskClass.standard,
};

describe("routeSessionTurn", () => {
  it("prompt class beats the session class and the default", () => {
    const route = routeSessionTurn({
      account: GROQ,
      spec: { ...SPEC, taskClass: TaskClass.heavy },
      overrides: { taskClass: TaskClass.light },
      promptSeq: 7,
    });

    expect(route.model).toBe("openai/gpt-oss-20b");
    expect(route.entry).toEqual({
      promptSeq: 7,
      accountId: "acc-groq",
      model: "openai/gpt-oss-20b",
      effectiveModel: null,
      apiProvider: "groq",
      requestedClass: "light",
      servedClass: "light",
      source: "routed",
    });
  });

  it("session class beats the default", () => {
    const route = routeSessionTurn({
      account: GROQ,
      spec: { ...SPEC, taskClass: TaskClass.heavy },
      overrides: {},
      promptSeq: 0,
    });

    expect(route.entry.requestedClass).toBe("heavy");
  });

  it("the settings default applies when no layer sets a class", () => {
    const route = routeSessionTurn({
      account: GROQ,
      spec: { ...SPEC, defaultTaskClass: TaskClass.light },
      overrides: {},
      promptSeq: 0,
    });

    expect(route.entry).toMatchObject({
      requestedClass: "light",
      model: "openai/gpt-oss-20b",
    });
  });
});

describe("routeSessionTurn models", () => {
  it("a prompt model override for the account's provider is used", () => {
    const route = routeSessionTurn({
      account: GROQ,
      spec: SPEC,
      overrides: {
        model: {
          provider: ProviderId.opencode,
          model: "groq/openai/gpt-oss-20b",
        },
      },
      promptSeq: 0,
    });

    expect(route.entry).toMatchObject({
      model: "openai/gpt-oss-20b",
      servedClass: null,
      source: "override",
    });
  });

  it("a subscription has no api provider and the CLI default model", () => {
    const route = routeSessionTurn({
      account: CLAUDE,
      spec: SPEC,
      overrides: {},
      promptSeq: 0,
    });

    expect(route).toEqual({
      model: null,
      entry: {
        promptSeq: 0,
        accountId: "acc-claude",
        model: null,
        effectiveModel: null,
        apiProvider: null,
        requestedClass: "standard",
        servedClass: null,
        source: "cli_default",
      },
    });
  });
});

describe("beginPrompt", () => {
  it("reserves the seq and keeps the overrides", () => {
    const begun = beginPrompt(INITIAL_SESSION_STATE, {
      taskClass: TaskClass.light,
    });

    expect(begun.prompt).toEqual({
      seq: 0,
      overrides: { taskClass: "light" },
    });
    expect(begun.state.nextSeq).toBe(1);
  });
});

describe("recordTurn", () => {
  const accounts = [GROQ, CEREBRAS, CLAUDE];
  const spec: TurnRoutingSpec = { ...SPEC, taskClass: TaskClass.heavy };

  it("routes the account it runs on and records the entry", () => {
    const begun = beginPrompt(INITIAL_SESSION_STATE, {});

    const recorded = recordTurn({
      state: begun.state,
      accounts,
      accountId: "acc-groq",
      spec,
      prompt: begun.prompt,
    });

    expect(recorded.model).toBe("openai/gpt-oss-120b");
    expect(recorded.state.turns).toEqual([
      expect.objectContaining({
        promptSeq: 0,
        accountId: "acc-groq",
        model: "openai/gpt-oss-120b",
      }),
    ]);
  });

  it("opencode_repeat_turn_keeps_served_model", () => {
    const begun = beginPrompt(INITIAL_SESSION_STATE, {});
    const served = { ...begun.state, currentModel: "groq/gpt-oss-20b-0925" };

    const recorded = recordTurn({
      state: served,
      accounts: [CLAUDE],
      accountId: "acc-claude",
      spec: SPEC,
      prompt: begun.prompt,
    });

    expect(recorded.model).toBeNull();
    expect(recorded.state.turns).toEqual([
      expect.objectContaining({
        model: null,
        effectiveModel: "groq/gpt-oss-20b-0925",
      }),
    ]);
  });

  it("a requested model keeps the effective model empty", () => {
    const begun = beginPrompt(INITIAL_SESSION_STATE, {});
    const served = { ...begun.state, currentModel: "groq/gpt-oss-20b-0925" };

    const recorded = recordTurn({
      state: served,
      accounts,
      accountId: "acc-groq",
      spec,
      prompt: begun.prompt,
    });

    expect(recorded.state.turns).toEqual([
      expect.objectContaining({
        model: "openai/gpt-oss-120b",
        effectiveModel: null,
      }),
    ]);
  });

  it("a resend on another account replaces the entry", () => {
    const begun = beginPrompt(INITIAL_SESSION_STATE, {});
    const first = recordTurn({
      state: begun.state,
      accounts,
      accountId: "acc-groq",
      spec,
      prompt: begun.prompt,
    });

    const resent = recordTurn({
      state: first.state,
      accounts,
      accountId: "acc-cerebras",
      spec,
      prompt: begun.prompt,
    });

    expect(resent.model).toBe("qwen-3.8-27b");
    expect(resent.state.turns).toEqual([
      expect.objectContaining({
        promptSeq: 0,
        accountId: "acc-cerebras",
        apiProvider: "cerebras",
        model: "qwen-3.8-27b",
      }),
    ]);
  });

  it("an unknown account sends no model and records nothing", () => {
    const begun = beginPrompt(INITIAL_SESSION_STATE, {});

    const recorded = recordTurn({
      state: begun.state,
      accounts,
      accountId: "acc-gone",
      spec,
      prompt: begun.prompt,
    });

    expect(recorded.model).toBeNull();
    expect(recorded.state).toBe(begun.state);
  });
});
