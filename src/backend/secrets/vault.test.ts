import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createParentPortVault, type ParentPortLike } from "./vault";

const REQUEST_TIMEOUT_MS = 5000;
const CRYPTO_TIMEOUT_MS = 120_000;

interface FakePort extends ParentPortLike {
  readonly posted: Record<string, unknown>[];
  emit(data: unknown): void;
}

function fakePort(): FakePort {
  const listeners: ((message: { readonly data: unknown }) => void)[] = [];
  const posted: Record<string, unknown>[] = [];
  return {
    posted,
    postMessage: (message) => {
      posted.push({ ...message });
    },
    on: (_event, listener) => {
      listeners.push(listener);
    },
    emit: (data) => {
      listeners.forEach((listener) => {
        listener({ data });
      });
    },
  };
}

function idOfRequest(port: FakePort, index = 0): string {
  const id = port.posted[index]?.id;
  if (typeof id !== "string") {
    throw new Error("request was not posted");
  }
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parent port vault", () => {
  it("posts_a_typed_request_and_resolves_with_the_matching_response", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const encrypted = vault.encrypt("sk-test-groq-0001");
    port.emit({
      type: "vault/response",
      id: idOfRequest(port),
      ok: true,
      result: "Y2lwaGVy",
    });

    expect(port.posted[0]).toMatchObject({
      type: "vault/request",
      op: "encrypt",
      plaintext: "sk-test-groq-0001",
    });
    await expect(encrypted).resolves.toBe("Y2lwaGVy");
  });

  it("reads_the_status_result", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const status = vault.status();
    port.emit({
      type: "vault/response",
      id: idOfRequest(port),
      ok: true,
      result: { available: false, reason: "no keyring" },
    });

    await expect(status).resolves.toEqual({
      available: false,
      reason: "no keyring",
    });
  });

  it("matches_concurrent_responses_by_request_id", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const first = vault.decrypt("Zmlyc3Q=");
    const second = vault.decrypt("c2Vjb25k");
    port.emit({
      type: "vault/response",
      id: idOfRequest(port, 1),
      ok: true,
      result: "second",
    });
    port.emit({
      type: "vault/response",
      id: idOfRequest(port, 0),
      ok: true,
      result: "first",
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});

describe("parent port vault failures", () => {
  it("rejects_with_the_error_text_of_a_failure_response", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const encrypted = vault.encrypt("sk-test-groq-0001");
    port.emit({
      type: "vault/response",
      id: idOfRequest(port),
      ok: false,
      error: "Secure key storage is unavailable: no keyring",
    });

    await expect(encrypted).rejects.toThrow(
      "Secure key storage is unavailable: no keyring",
    );
  });

  it("ignores_unknown_ids_and_foreign_messages", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const decrypted = vault.decrypt("c2VjcmV0");
    port.emit({ type: "vault/response", id: "other", ok: true, result: "x" });
    port.emit({ type: "connect" });
    port.emit("noise");
    port.emit({ type: "vault/response", id: idOfRequest(port), ok: "maybe" });
    port.emit({
      type: "vault/response",
      id: idOfRequest(port),
      ok: true,
      result: "secret",
    });

    await expect(decrypted).resolves.toBe("secret");
  });
});

describe("parent port vault timeouts", () => {
  it("rejects_when_no_response_arrives_in_time", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const decrypted = vault.decrypt("c2VjcmV0");
    const outcome = expect(decrypted).rejects.toThrow(
      "Secure key storage did not respond",
    );
    await vi.advanceTimersByTimeAsync(CRYPTO_TIMEOUT_MS);

    await outcome;
  });

  it("status_uses_short_timeout", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const status = vault.status();
    const outcome = expect(status).rejects.toThrow(
      "Secure key storage did not respond",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await outcome;
  });

  it("crypto_requests_use_long_timeout", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const decrypted = vault.decrypt("c2VjcmV0");
    const encrypted = vault.encrypt("secret");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    port.emit({
      type: "vault/response",
      id: idOfRequest(port, 0),
      ok: true,
      result: "secret",
    });
    port.emit({
      type: "vault/response",
      id: idOfRequest(port, 1),
      ok: true,
      result: "c2VjcmV0",
    });

    await expect(decrypted).resolves.toBe("secret");
    await expect(encrypted).resolves.toBe("c2VjcmV0");
  });

  it("crypto_requests_time_out_after_the_injected_limit", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port, { statusMs: 10, cryptoMs: 500 });

    const decrypted = vault.decrypt("c2VjcmV0");
    const outcome = expect(decrypted).rejects.toThrow(
      "Secure key storage did not respond",
    );
    await vi.advanceTimersByTimeAsync(500);

    await outcome;
  });

  it("does_not_time_out_a_request_that_was_answered", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);
    const decrypted = vault.decrypt("c2VjcmV0");
    port.emit({
      type: "vault/response",
      id: idOfRequest(port),
      ok: true,
      result: "secret",
    });

    expect(vi.getTimerCount()).toBe(0);
    await expect(decrypted).resolves.toBe("secret");
  });

  it("rejects_a_status_response_of_the_wrong_shape", async () => {
    const port = fakePort();
    const vault = createParentPortVault(port);

    const status = vault.status();
    port.emit({
      type: "vault/response",
      id: idOfRequest(port),
      ok: true,
      result: "not a status",
    });

    await expect(status).rejects.toThrow(
      "Secure key storage returned an unexpected result",
    );
  });
});
