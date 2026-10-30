import { describe, expect, it, vi } from "vitest";

import { createSecretVault, handleVaultRequest } from "./secretVault";
import type { SafeStorageLike } from "./secretVault";

type Backend = ReturnType<SafeStorageLike["getSelectedStorageBackend"]>;

const BASIC_TEXT_REASON =
  "Secure key storage is unavailable: the OS keyring is not available (basic_text backend)";

interface FakeStorageOptions {
  readonly encryption?: boolean;
  readonly backend?: Backend;
  readonly throwOnBackend?: boolean;
}

function fakeStorage(options: FakeStorageOptions = {}): {
  readonly storage: SafeStorageLike;
  readonly encryptString: ReturnType<typeof vi.fn>;
} {
  const encryptString = vi.fn((plain: string) =>
    Buffer.from(plain, "utf8").reverse(),
  );
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => options.encryption ?? true,
    encryptString,
    decryptString: (encrypted) =>
      Buffer.from(encrypted).reverse().toString("utf8"),
    getSelectedStorageBackend: () => {
      if (options.throwOnBackend === true) {
        throw new Error("getSelectedStorageBackend is Linux only");
      }
      return options.backend ?? "gnome_libsecret";
    },
  };
  return { storage, encryptString };
}

describe("secret vault status on linux", () => {
  it.each([
    {
      name: "linux with libsecret",
      platform: "linux",
      options: { backend: "gnome_libsecret" },
      expected: { available: true, reason: null },
    },
    {
      name: "linux with kwallet6",
      platform: "linux",
      options: { backend: "kwallet6" },
      expected: { available: true, reason: null },
    },
    {
      name: "linux with basic_text",
      platform: "linux",
      options: { backend: "basic_text" },
      expected: {
        available: false,
        reason: "the OS keyring is not available (basic_text backend)",
      },
    },
    {
      name: "linux with unknown backend",
      platform: "linux",
      options: { backend: "unknown" },
      expected: {
        available: false,
        reason: "the OS keyring is not available (unknown backend)",
      },
    },
    {
      name: "linux without encryption",
      platform: "linux",
      options: { encryption: false },
      expected: { available: false, reason: "OS encryption is not available" },
    },
  ] as const)("$name", ({ platform, options, expected }) => {
    const vault = createSecretVault(fakeStorage(options).storage, platform);

    expect(vault.status()).toEqual(expected);
  });
});

describe("secret vault status on other platforms", () => {
  it.each([
    {
      name: "macOS never asks for the backend",
      platform: "darwin",
      options: { throwOnBackend: true },
      expected: { available: true, reason: null },
    },
    {
      name: "windows never asks for the backend",
      platform: "win32",
      options: { throwOnBackend: true },
      expected: { available: true, reason: null },
    },
    {
      name: "windows without encryption",
      platform: "win32",
      options: { encryption: false, throwOnBackend: true },
      expected: { available: false, reason: "OS encryption is not available" },
    },
  ] as const)("$name", ({ platform, options, expected }) => {
    const vault = createSecretVault(fakeStorage(options).storage, platform);

    expect(vault.status()).toEqual(expected);
  });
});

describe("secret vault encryption", () => {
  it("round_trips_through_base64_ciphertext", () => {
    const vault = createSecretVault(fakeStorage().storage, "linux");

    const ciphertext = vault.encrypt("sk-test-groq-0001");

    expect(ciphertext).toBe(
      Buffer.from("1000-qorg-tset-ks", "utf8").toString("base64"),
    );
    expect(vault.decrypt(ciphertext)).toBe("sk-test-groq-0001");
  });

  it("encrypt_refused_when_unavailable_without_touching_storage", () => {
    const { storage, encryptString } = fakeStorage({ backend: "basic_text" });
    const vault = createSecretVault(storage, "linux");

    expect(() => vault.encrypt("sk-test-groq-0001")).toThrow(BASIC_TEXT_REASON);

    expect(encryptString).not.toHaveBeenCalled();
  });

  it("decrypt_refused_when_unavailable", () => {
    const vault = createSecretVault(
      fakeStorage({ backend: "basic_text" }).storage,
      "linux",
    );

    expect(() => vault.decrypt("c2VjcmV0")).toThrow(BASIC_TEXT_REASON);
  });
});

describe("vault request handler", () => {
  it("answers_status_with_the_request_id", () => {
    const vault = createSecretVault(fakeStorage().storage, "linux");

    expect(
      handleVaultRequest(vault, {
        type: "vault/request",
        id: "r1",
        op: "status",
      }),
    ).toEqual({
      type: "vault/response",
      id: "r1",
      ok: true,
      result: { available: true, reason: null },
    });
  });
});

describe("vault request handler operations", () => {
  it("encrypts_and_decrypts_by_operation", () => {
    const vault = createSecretVault(fakeStorage().storage, "linux");

    const encrypted = handleVaultRequest(vault, {
      type: "vault/request",
      id: "r2",
      op: "encrypt",
      plaintext: "sk-test-groq-0001",
    });
    const decrypted = handleVaultRequest(vault, {
      type: "vault/request",
      id: "r3",
      op: "decrypt",
      ciphertext: Buffer.from("1000-qorg-tset-ks", "utf8").toString("base64"),
    });

    expect(encrypted).toEqual({
      type: "vault/response",
      id: "r2",
      ok: true,
      result: Buffer.from("1000-qorg-tset-ks", "utf8").toString("base64"),
    });
    expect(decrypted).toEqual({
      type: "vault/response",
      id: "r3",
      ok: true,
      result: "sk-test-groq-0001",
    });
  });

  it("reports_refusal_as_error_response_without_the_plaintext", () => {
    const vault = createSecretVault(
      fakeStorage({ backend: "basic_text" }).storage,
      "linux",
    );

    const response = handleVaultRequest(vault, {
      type: "vault/request",
      id: "r4",
      op: "encrypt",
      plaintext: "sk-test-groq-0001",
    });

    expect(response).toEqual({
      type: "vault/response",
      id: "r4",
      ok: false,
      error: BASIC_TEXT_REASON,
    });
  });
});
