import { join } from "node:path";

import {
  createKeyStore,
  type KeyStore,
} from "../../src/backend/secrets/keyStore";
import type { SecretVault, VaultStatus } from "../../src/backend/secrets/vault";

export const FAKE_VAULT_UNAVAILABLE_REASON =
  "the OS keyring is not available (basic_text backend)";

export interface FakeVault extends SecretVault {
  available: boolean;
  reason: string;
}

function scramble(text: string): string {
  return Buffer.from(text, "utf8").reverse().toString("base64");
}

function unscramble(ciphertext: string): string {
  return Buffer.from(ciphertext, "base64").reverse().toString("utf8");
}

export function fakeSecrets(dir: string): {
  readonly keyStore: KeyStore;
  readonly vault: FakeVault;
} {
  const vault = createFakeVault();
  return {
    vault,
    keyStore: createKeyStore({ path: join(dir, "api-keys.json"), vault }),
  };
}

export function createFakeVault(available = true): FakeVault {
  const vault: FakeVault = {
    available,
    reason: FAKE_VAULT_UNAVAILABLE_REASON,
    status(): Promise<VaultStatus> {
      return Promise.resolve(
        vault.available
          ? { available: true, reason: null }
          : { available: false, reason: vault.reason },
      );
    },
    encrypt(plaintext): Promise<string> {
      return vault.available
        ? Promise.resolve(scramble(plaintext))
        : Promise.reject(
            new Error(`Secure key storage is unavailable: ${vault.reason}`),
          );
    },
    decrypt(ciphertext): Promise<string> {
      return vault.available
        ? Promise.resolve(unscramble(ciphertext))
        : Promise.reject(
            new Error(`Secure key storage is unavailable: ${vault.reason}`),
          );
    },
  };
  return vault;
}
