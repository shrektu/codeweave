import { describe, expect, it } from "vitest";

import {
  API_PROVIDERS,
  ApiProviderId,
  ApiTier,
  FreeModels,
} from "./apiProviders";
import { MODEL_TIERS } from "./modelTiers";
import { resolveTaskClass, routeByClass, RouteSource } from "./routing";
import { TaskClass } from "./taskClass";
import { ProviderId, type Account } from "./types";

function apiAccount(provider: ApiProviderId, model: string): Account {
  return {
    id: "acc",
    provider: ProviderId.opencode,
    label: "Account",
    configDir: "/tmp/acc",
    order: 0,
    api: { provider, model, baseUrl: null, rotation: true },
  };
}

function subscription(provider: ProviderId): Account {
  return {
    id: "sub",
    provider,
    label: "Subscription",
    configDir: "/tmp/sub",
    order: 0,
  };
}

describe("routeByClass", () => {
  it("routes light and heavy on groq", () => {
    const account = apiAccount(ApiProviderId.groq, "llama");

    expect(routeByClass(account, TaskClass.light)).toEqual({
      model: "openai/gpt-oss-20b",
      requestedClass: "light",
      servedClass: "light",
      source: "routed",
    });
    expect(routeByClass(account, TaskClass.heavy)).toEqual({
      model: "openai/gpt-oss-120b",
      requestedClass: "heavy",
      servedClass: "heavy",
      source: "routed",
    });
  });

  it("standard falls back to the stronger class", () => {
    const route = routeByClass(
      apiAccount(ApiProviderId.groq, "llama"),
      TaskClass.standard,
    );

    expect(route).toEqual({
      model: "openai/gpt-oss-120b",
      requestedClass: "standard",
      servedClass: "heavy",
      source: "routed",
    });
  });

  it("never picks a paid model on a free-marked account", () => {
    const account = apiAccount(ApiProviderId.zai, "glm-5.3");

    const models = [TaskClass.light, TaskClass.standard, TaskClass.heavy].map(
      (taskClass) => routeByClass(account, taskClass).model,
    );

    expect(models).toEqual(["glm-4.7-flash", "glm-4.7-flash", "glm-4.7-flash"]);
  });

  it("mistral serves every class", () => {
    const account = apiAccount(ApiProviderId.mistral, "other");

    const models = [TaskClass.light, TaskClass.standard, TaskClass.heavy].map(
      (taskClass) => routeByClass(account, taskClass).model,
    );

    expect(models).toEqual([
      "ministral-8b-2512",
      "mistral-small-2603",
      "mistral-large-4",
    ]);
  });
});

describe("routeByClass accounts", () => {
  it("account without tier data keeps its model", () => {
    for (const provider of [
      ApiProviderId.openrouter,
      ApiProviderId.moonshotai,
      ApiProviderId.custom,
    ]) {
      expect(
        routeByClass(apiAccount(provider, "my-model"), TaskClass.heavy),
      ).toEqual({
        model: "my-model",
        requestedClass: "heavy",
        servedClass: null,
        source: RouteSource.account,
      });
    }
  });

  it("subscription account uses the CLI default", () => {
    for (const provider of [
      ProviderId.claude,
      ProviderId.codex,
      ProviderId.gemini,
    ]) {
      expect(routeByClass(subscription(provider), TaskClass.light)).toEqual({
        model: null,
        requestedClass: "light",
        servedClass: null,
        source: "cli_default",
      });
    }
  });

  it("prefers the account model within the class", () => {
    const route = routeByClass(
      apiAccount(ApiProviderId.deepseek, "deepseek-v4-pro"),
      TaskClass.heavy,
    );

    expect(route.model).toBe("deepseek-v4-pro");
    expect(route.servedClass).toBe("heavy");
  });
});

describe("resolveTaskClass", () => {
  it.each<[string, (TaskClass | null | undefined)[], TaskClass]>([
    ["first layer wins", ["heavy", "light", "standard"], "heavy"],
    ["nulls and undefined are skipped", [null, undefined, "light"], "light"],
    ["all empty falls back", [null, undefined], "standard"],
    ["no layers falls back", [], "standard"],
  ])("%s", (_name, layers, expected) => {
    expect(resolveTaskClass(layers, TaskClass.standard)).toBe(expected);
  });
});

const CLASS_RANK: Readonly<Record<TaskClass, number>> = {
  light: 0,
  standard: 1,
  heavy: 2,
};
const UNKNOWN_MODEL = "not-in-the-table";

interface Case {
  readonly provider: ApiProviderId;
  readonly taskClass: TaskClass;
  readonly model: string;
}

function allCases(): Case[] {
  return Object.values(ApiProviderId).flatMap((provider) => {
    const own = MODEL_TIERS.filter((tier) => tier.provider === provider);
    const models = [...own.map((tier) => tier.modelId), UNKNOWN_MODEL];
    return Object.values(TaskClass).flatMap((taskClass) =>
      models.map((model) => ({ provider, taskClass, model })),
    );
  });
}

function isFreeMarked(provider: ApiProviderId): boolean {
  const info = API_PROVIDERS[provider];
  return info.tier === ApiTier.free && info.freeModels === FreeModels.marked;
}

function expectedServed({ provider, taskClass }: Case): TaskClass | null {
  const rows = MODEL_TIERS.filter(
    (tier) =>
      tier.provider === provider && (tier.free || !isFreeMarked(provider)),
  );
  const preference = Object.values(TaskClass).toSorted(
    (a, b) =>
      Math.abs(CLASS_RANK[a] - CLASS_RANK[taskClass]) -
        Math.abs(CLASS_RANK[b] - CLASS_RANK[taskClass]) ||
      CLASS_RANK[b] - CLASS_RANK[a],
  );
  return (
    preference.find((candidate) =>
      rows.some((row) => row.taskClass === candidate),
    ) ?? null
  );
}

describe("routeByClass over every provider and class", () => {
  it("never serves a paid model on a free-marked free-tier provider", () => {
    for (const { provider, taskClass, model } of allCases()) {
      const route = routeByClass(apiAccount(provider, model), taskClass);
      const row = MODEL_TIERS.find(
        (tier) => tier.provider === provider && tier.modelId === route.model,
      );

      expect(!isFreeMarked(provider) || row?.free !== false).toBe(true);
    }
  });

  it("serves the nearest available class, stronger on a tie", () => {
    for (const testCase of allCases()) {
      const route = routeByClass(
        apiAccount(testCase.provider, testCase.model),
        testCase.taskClass,
      );

      expect(route.servedClass).toBe(expectedServed(testCase));
    }
  });
});
