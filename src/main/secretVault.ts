import type { SafeStorage } from "electron";

import { VAULT_RESPONSE_MESSAGE_TYPE } from "../shared/constants";
import {
  VaultOp,
  type VaultRequest,
  type VaultResponse,
  type VaultStatus,
} from "../shared/vault";

export type SafeStorageLike = Pick<
  SafeStorage,
  | "isEncryptionAvailable"
  | "encryptString"
  | "decryptString"
  | "getSelectedStorageBackend"
>;

export interface SecretVault {
  status(): VaultStatus;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const LINUX_PLATFORM = "linux";
const WEAK_LINUX_BACKENDS: readonly string[] = ["basic_text", "unknown"];
const ENCRYPTION_UNAVAILABLE_REASON = "OS encryption is not available";
const UNAVAILABLE_PREFIX = "Secure key storage is unavailable: ";
const CIPHERTEXT_ENCODING = "base64";

function keyringReason(backend: string): string {
  return `the OS keyring is not available (${backend} backend)`;
}

function unavailableReason(
  storage: SafeStorageLike,
  platform: NodeJS.Platform,
): string | null {
  if (!storage.isEncryptionAvailable()) {
    return ENCRYPTION_UNAVAILABLE_REASON;
  }
  if (platform !== LINUX_PLATFORM) {
    return null;
  }
  const backend = storage.getSelectedStorageBackend();
  return WEAK_LINUX_BACKENDS.includes(backend) ? keyringReason(backend) : null;
}

export function createSecretVault(
  storage: SafeStorageLike,
  platform: NodeJS.Platform,
): SecretVault {
  const status = (): VaultStatus => {
    const reason = unavailableReason(storage, platform);
    return { available: reason === null, reason };
  };
  const requireAvailable = (): void => {
    const { reason } = status();
    if (reason !== null) {
      throw new Error(`${UNAVAILABLE_PREFIX}${reason}`);
    }
  };
  return {
    status,
    encrypt: (plaintext) => {
      requireAvailable();
      return storage.encryptString(plaintext).toString(CIPHERTEXT_ENCODING);
    },
    decrypt: (ciphertext) => {
      requireAvailable();
      return storage.decryptString(
        Buffer.from(ciphertext, CIPHERTEXT_ENCODING),
      );
    },
  };
}

function perform(
  vault: SecretVault,
  message: VaultRequest,
): VaultStatus | string {
  switch (message.op) {
    case VaultOp.status:
      return vault.status();
    case VaultOp.encrypt:
      return vault.encrypt(message.plaintext);
    case VaultOp.decrypt:
      return vault.decrypt(message.ciphertext);
  }
}

export function handleVaultRequest(
  vault: SecretVault,
  message: VaultRequest,
): VaultResponse {
  try {
    return {
      type: VAULT_RESPONSE_MESSAGE_TYPE,
      id: message.id,
      ok: true,
      result: perform(vault, message),
    };
  } catch (error) {
    return {
      type: VAULT_RESPONSE_MESSAGE_TYPE,
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
