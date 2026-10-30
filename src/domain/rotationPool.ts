import { API_PROVIDERS, ApiTier } from "./apiProviders";
import { ProviderId, type Account } from "./types";

function isRotatingApiOfTier(account: Account, tier: ApiTier): boolean {
  return (
    account.provider === ProviderId.opencode &&
    account.api?.rotation === true &&
    API_PROVIDERS[account.api.provider].tier === tier
  );
}

export function rotationPool(
  provider: ProviderId,
  registered: readonly Account[],
): Account[] {
  const own =
    provider === ProviderId.opencode
      ? []
      : registered.filter((account) => account.provider === provider);
  return [
    ...own,
    ...registered.filter((account) =>
      isRotatingApiOfTier(account, ApiTier.free),
    ),
    ...registered.filter((account) =>
      isRotatingApiOfTier(account, ApiTier.paid),
    ),
  ].map((account, order) => ({ ...account, order }));
}
