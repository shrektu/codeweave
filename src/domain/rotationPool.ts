import { API_PROVIDERS, ApiTier } from "./apiProviders";
import { ProviderId, type Account } from "./types";

function isRotatingApiOfTier(account: Account, tier: ApiTier): boolean {
  return (
    account.provider === ProviderId.opencode &&
    account.api?.rotation === true &&
    API_PROVIDERS[account.api.provider].tier === tier
  );
}

const API_TIER_ORDER: readonly ApiTier[] = [
  ApiTier.flatRate,
  ApiTier.free,
  ApiTier.paid,
];

const SUBSCRIPTION_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  ProviderId.claude,
  ProviderId.codex,
  ProviderId.gemini,
]);

export function rotationPool(
  provider: ProviderId,
  registered: readonly Account[],
): Account[] {
  const isSubscriptionSession = SUBSCRIPTION_PROVIDERS.has(provider);
  const own = isSubscriptionSession
    ? registered.filter((account) => account.provider === provider)
    : [];
  const otherSubscriptions = isSubscriptionSession
    ? registered.filter(
        (account) =>
          account.provider !== provider &&
          SUBSCRIPTION_PROVIDERS.has(account.provider),
      )
    : [];
  return [
    ...own,
    ...otherSubscriptions,
    ...API_TIER_ORDER.flatMap((tier) =>
      registered.filter((account) => isRotatingApiOfTier(account, tier)),
    ),
  ].map((account, order) => ({ ...account, order }));
}
