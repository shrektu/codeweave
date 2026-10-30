import type { SecretEntry } from "../../domain/secretMask";
import type { Account } from "../../domain/types";

import type { KeyStore } from "./keyStore";

export function createSecretSource(
  keyStore: Pick<KeyStore, "knownEntries">,
): (accounts: readonly Account[]) => readonly SecretEntry[] {
  const labels = new Map<string, string>();
  return (accounts) => {
    accounts.forEach(({ id, label }) => labels.set(id, label));
    return keyStore.knownEntries().map(({ accountId, value }) => ({
      value,
      label: labels.get(accountId) ?? accountId,
    }));
  };
}
