import { expect, it } from "vitest";

import type { ApiProviderId } from "./apiProviders";
import { rotationPool } from "./rotationPool";
import { ProviderId, type Account } from "./types";

function subscription(
  id: string,
  provider: ProviderId,
  order: number,
): Account {
  return { id, provider, label: id, configDir: `/cfg/${id}`, order };
}

function api(
  id: string,
  provider: ApiProviderId,
  order: number,
  rotation = true,
): Account {
  return {
    id,
    provider: ProviderId.opencode,
    label: id,
    configDir: `/cfg/${id}`,
    order,
    api: { provider, model: "model-x", baseUrl: null, rotation },
  };
}

function idsOf(accounts: readonly Account[]): string[] {
  return accounts.map((account) => account.id);
}

const REGISTERED: Account[] = [
  api("paid-1", "deepseek", 0),
  subscription("claude-1", ProviderId.claude, 1),
  api("free-1", "groq", 2),
  subscription("codex-1", ProviderId.codex, 3),
  api("off-free", "cerebras", 4, false),
  subscription("claude-2", ProviderId.claude, 5),
  api("free-2", "openrouter", 6),
  api("off-paid", "moonshotai", 7, false),
  api("paid-2", "moonshotai", 8),
];

it("subscription_session_lists_own_then_other_subscriptions_then_free_then_paid", () => {
  expect(idsOf(rotationPool(ProviderId.claude, REGISTERED))).toEqual([
    "claude-1",
    "claude-2",
    "codex-1",
    "free-1",
    "free-2",
    "paid-1",
    "paid-2",
  ]);
});

it("codex_session_uses_codex_then_other_subscriptions_then_api", () => {
  expect(idsOf(rotationPool(ProviderId.codex, REGISTERED))).toEqual([
    "codex-1",
    "claude-1",
    "claude-2",
    "free-1",
    "free-2",
    "paid-1",
    "paid-2",
  ]);
});

it("opencode_session_uses_only_rotating_api_accounts", () => {
  expect(idsOf(rotationPool(ProviderId.opencode, REGISTERED))).toEqual([
    "free-1",
    "free-2",
    "paid-1",
    "paid-2",
  ]);
});

it("gemini_session_without_own_accounts_uses_other_subscriptions_then_api", () => {
  expect(idsOf(rotationPool(ProviderId.gemini, REGISTERED))).toEqual([
    "claude-1",
    "codex-1",
    "claude-2",
    "free-1",
    "free-2",
    "paid-1",
    "paid-2",
  ]);
});

it("pool_without_others_unchanged", () => {
  const registered = [
    subscription("claude-1", ProviderId.claude, 0),
    api("off", "groq", 1, false),
    subscription("claude-2", ProviderId.claude, 2),
  ];

  expect(idsOf(rotationPool(ProviderId.claude, registered))).toEqual([
    "claude-1",
    "claude-2",
  ]);
});

it("gemini_session_with_own_account_lists_it_first", () => {
  const registered = [
    subscription("claude-1", ProviderId.claude, 0),
    subscription("gemini-1", ProviderId.gemini, 1),
    api("free-1", "groq", 2),
  ];

  expect(idsOf(rotationPool(ProviderId.gemini, registered))).toEqual([
    "gemini-1",
    "claude-1",
    "free-1",
  ]);
});

it("other_subscriptions_keep_registered_order", () => {
  const registered = [
    subscription("gemini-1", ProviderId.gemini, 0),
    subscription("codex-1", ProviderId.codex, 1),
    subscription("claude-1", ProviderId.claude, 2),
    subscription("gemini-2", ProviderId.gemini, 3),
    subscription("codex-2", ProviderId.codex, 4),
  ];

  expect(idsOf(rotationPool(ProviderId.claude, registered))).toEqual([
    "claude-1",
    "gemini-1",
    "codex-1",
    "gemini-2",
    "codex-2",
  ]);
});

it("opencode_session_never_gets_subscriptions", () => {
  const registered = [
    subscription("claude-1", ProviderId.claude, 0),
    subscription("codex-1", ProviderId.codex, 1),
    subscription("gemini-1", ProviderId.gemini, 2),
    api("free-1", "groq", 3),
  ];

  expect(idsOf(rotationPool(ProviderId.opencode, registered))).toEqual([
    "free-1",
  ]);
});

it("opencode_session_without_api_accounts_is_empty", () => {
  const registered = [
    subscription("claude-1", ProviderId.claude, 0),
    api("off", "groq", 1, false),
  ];

  expect(rotationPool(ProviderId.opencode, registered)).toEqual([]);
});

it("rotation_off_account_never_enters_any_pool", () => {
  const registered = [api("off", "groq", 0, false)];

  expect(rotationPool(ProviderId.opencode, registered)).toEqual([]);
  expect(rotationPool(ProviderId.claude, registered)).toEqual([]);
});

it("order_values_follow_pool_position", () => {
  const pool = rotationPool(ProviderId.claude, REGISTERED);

  expect(pool.map((account) => account.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

it("accounts_keep_all_other_fields", () => {
  const [first] = rotationPool(ProviderId.opencode, [api("free-1", "groq", 9)]);

  expect(first).toEqual({
    id: "free-1",
    provider: "opencode",
    label: "free-1",
    configDir: "/cfg/free-1",
    order: 0,
    api: {
      provider: "groq",
      model: "model-x",
      baseUrl: null,
      rotation: true,
    },
  });
});

it("custom_provider_counts_as_free", () => {
  const registered = [
    api("paid-1", "deepseek", 0),
    api("custom-1", "custom", 1),
  ];

  expect(idsOf(rotationPool(ProviderId.opencode, registered))).toEqual([
    "custom-1",
    "paid-1",
  ]);
});
