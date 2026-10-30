import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { SECRET_HINT_LENGTH } from "../../domain/constants";
import { IpcError, IpcErrorCode } from "../../shared/protocol";
import {
  KEY_DECRYPT_RETRY_INTERVAL_MS,
  KEY_STORE_FILE_MODE,
  STORAGE_VERSION,
} from "../constants";
import { createSerializer, type Serializer } from "../serialize";
import { readValidated, writeAtomic } from "../storage";

import type { SecretVault } from "./vault";

const StoredKeySchema = z.strictObject({
  ciphertext: z.string(),
  hint: z.string(),
});

const KeysFileSchema = z.strictObject({
  version: z.literal(STORAGE_VERSION),
  keys: z.record(z.string(), StoredKeySchema),
});

type StoredKey = z.infer<typeof StoredKeySchema>;

export interface KnownKey {
  readonly accountId: string;
  readonly value: string;
}

export interface KeyStore {
  ready(): Promise<void>;
  set(accountId: string, plaintext: string): Promise<void>;
  get(accountId: string): Promise<string | null>;
  remove(accountId: string): Promise<void>;
  hint(accountId: string): string | null;
  knownValues(): ReadonlySet<string>;
  knownEntries(): readonly KnownKey[];
}

export interface KeyStoreDeps {
  readonly path: string;
  readonly vault: SecretVault;
}

const UNAVAILABLE_FALLBACK = "Secure key storage is unavailable";

function unavailable(error: unknown): IpcError {
  return error instanceof IpcError
    ? error
    : new IpcError(
        IpcErrorCode.UNAVAILABLE,
        error instanceof Error ? error.message : UNAVAILABLE_FALLBACK,
      );
}

class FileKeyStore implements KeyStore {
  private entries = new Map<string, StoredKey>();
  private readonly values = new Map<string, string>();
  private readonly retired: KnownKey[] = [];
  private readonly serialized: Serializer = createSerializer();
  private loading: Promise<void> | null = null;
  private loaded = false;
  private retrying = false;
  private lastRetryAt = Number.NEGATIVE_INFINITY;
  private readonly path: string;
  private readonly vault: SecretVault;

  constructor({ path, vault }: KeyStoreDeps) {
    this.path = path;
    this.vault = vault;
  }

  ready(): Promise<void> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  set(accountId: string, plaintext: string): Promise<void> {
    return this.serialized(async () => {
      await this.ready();
      const ciphertext = await this.encrypt(plaintext);
      await this.persist(
        new Map(this.entries).set(accountId, {
          ciphertext,
          hint: plaintext.slice(-SECRET_HINT_LENGTH),
        }),
      );
      this.retire(accountId);
      this.values.set(accountId, plaintext);
    });
  }

  get(accountId: string): Promise<string | null> {
    return this.serialized(async () => {
      await this.ready();
      const cached = this.values.get(accountId);
      const stored = this.entries.get(accountId);
      if (cached !== undefined || stored === undefined) {
        return cached ?? null;
      }
      const plaintext = await this.vault
        .decrypt(stored.ciphertext)
        .catch((error: unknown) => {
          throw unavailable(error);
        });
      this.values.set(accountId, plaintext);
      return plaintext;
    });
  }

  remove(accountId: string): Promise<void> {
    return this.serialized(async () => {
      await this.ready();
      if (!this.entries.has(accountId)) {
        return;
      }
      const next = new Map(this.entries);
      next.delete(accountId);
      await this.persist(next);
      this.retire(accountId);
      this.values.delete(accountId);
    });
  }

  hint(accountId: string): string | null {
    return this.entries.get(accountId)?.hint ?? null;
  }

  knownValues(): ReadonlySet<string> {
    return new Set(this.knownEntries().map(({ value }) => value));
  }

  knownEntries(): readonly KnownKey[] {
    this.retryUndecrypted();
    const current = [...this.values].map(([accountId, value]) => ({
      accountId,
      value,
    }));
    return [
      ...current,
      ...this.retired.filter(
        ({ accountId, value }) => this.values.get(accountId) !== value,
      ),
    ];
  }

  private retire(accountId: string): void {
    const value = this.values.get(accountId);
    const known = this.retired.some(
      (entry) => entry.accountId === accountId && entry.value === value,
    );
    if (value !== undefined && !known) {
      this.retired.push({ accountId, value });
    }
  }

  private retryUndecrypted(): void {
    const missing = [...this.entries].filter(
      ([accountId]) => !this.values.has(accountId),
    );
    const now = Date.now();
    const due = now - this.lastRetryAt >= KEY_DECRYPT_RETRY_INTERVAL_MS;
    if (!this.loaded || this.retrying || !due || missing.length === 0) {
      return;
    }
    this.retrying = true;
    this.lastRetryAt = now;
    void this.serialized(() =>
      Promise.all(
        missing.map(([accountId, stored]) =>
          this.retryDecrypt(accountId, stored),
        ),
      ),
    ).finally(() => {
      this.retrying = false;
    });
  }

  private async retryDecrypt(
    accountId: string,
    stored: StoredKey,
  ): Promise<void> {
    try {
      const plaintext = await this.vault.decrypt(stored.ciphertext);
      if (this.entries.get(accountId) === stored) {
        this.values.set(accountId, plaintext);
      }
    } catch (error) {
      console.warn(`failed to decrypt the stored key of ${accountId}`, error);
    }
  }

  private async load(): Promise<void> {
    const file = await readValidated(this.path, KeysFileSchema);
    if (file === null) {
      return;
    }
    await chmod(this.path, KEY_STORE_FILE_MODE);
    this.entries = new Map(Object.entries(file.keys));
    await Promise.all(
      [...this.entries].map(([accountId, stored]) =>
        this.decryptInto(accountId, stored),
      ),
    );
    this.loaded = true;
  }

  private async decryptInto(
    accountId: string,
    { ciphertext }: StoredKey,
  ): Promise<void> {
    try {
      this.values.set(accountId, await this.vault.decrypt(ciphertext));
    } catch (error) {
      console.warn(`failed to decrypt the stored key of ${accountId}`, error);
    }
  }

  private async encrypt(plaintext: string): Promise<string> {
    try {
      const status = await this.vault.status();
      if (!status.available) {
        throw new IpcError(
          IpcErrorCode.UNAVAILABLE,
          status.reason ?? UNAVAILABLE_FALLBACK,
        );
      }
      return await this.vault.encrypt(plaintext);
    } catch (error) {
      throw unavailable(error);
    }
  }

  private async persist(next: Map<string, StoredKey>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeAtomic(
      this.path,
      JSON.stringify(
        { version: STORAGE_VERSION, keys: Object.fromEntries(next) },
        null,
        2,
      ),
      { mode: KEY_STORE_FILE_MODE },
    );
    this.entries = next;
  }
}

export function createKeyStore(deps: KeyStoreDeps): KeyStore {
  return new FileKeyStore(deps);
}
