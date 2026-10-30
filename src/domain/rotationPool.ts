import { API_PROVIDERS, ApiTier } from "./apiProviders";
import { ProviderId, type Account } from "./types";

function isRotatingApiOfTier(account: Account, tier: ApiTier): boolean {
  return (
    account.provider === ProviderId.opencode &&
    account.api?.rotation === true &&
    API_PROVIDERS[account.api.provider].tier === tier
  );
}

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
    ...registered.filter((account) =>
      isRotatingApiOfTier(account, ApiTier.free),
    ),
    ...registered.filter((account) =>
      isRotatingApiOfTier(account, ApiTier.paid),
    ),
  ].map((account, order) => ({ ...account, order }));
}
