import { randomUUID } from "node:crypto";

import {
  VAULT_REQUEST_MESSAGE_TYPE,
  VAULT_REQUEST_TIMEOUT_MS,
} from "../../shared/constants";
import {
  VaultOp,
  VaultResponseSchema,
  VaultStatusSchema,
  type VaultRequest,
  type VaultStatus,
} from "../../shared/vault";
import { VAULT_CRYPTO_TIMEOUT_MS } from "../constants";

export type { VaultStatus };

export interface SecretVault {
  status(): Promise<VaultStatus>;
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface ParentPortLike {
  postMessage(message: VaultRequest): void;
  on(
    event: "message",
    listener: (message: { readonly data: unknown }) => void,
  ): unknown;
}

type VaultRequestBody =
  | { readonly op: typeof VaultOp.status }
  | { readonly op: typeof VaultOp.encrypt; readonly plaintext: string }
  | { readonly op: typeof VaultOp.decrypt; readonly ciphertext: string };

interface PendingRequest {
  readonly resolve: (result: VaultStatus | string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const MESSAGE_EVENT = "message";
const NO_RESPONSE_MESSAGE = "Secure key storage did not respond";
const UNEXPECTED_RESULT_MESSAGE =
  "Secure key storage returned an unexpected result";

export interface VaultTimeouts {
  readonly statusMs: number;
  readonly cryptoMs: number;
}

const DEFAULT_TIMEOUTS: VaultTimeouts = {
  statusMs: VAULT_REQUEST_TIMEOUT_MS,
  cryptoMs: VAULT_CRYPTO_TIMEOUT_MS,
};

export function createParentPortVault(
  port: ParentPortLike,
  timeouts: VaultTimeouts = DEFAULT_TIMEOUTS,
): SecretVault {
  const pending = new Map<string, PendingRequest>();

  port.on(MESSAGE_EVENT, (message) => {
    const response = VaultResponseSchema.safeParse(message.data);
    if (!response.success) {
      return;
    }
    const request = pending.get(response.data.id);
    if (request === undefined) {
      return;
    }
    pending.delete(response.data.id);
    clearTimeout(request.timer);
    if (response.data.ok) {
      request.resolve(response.data.result);
    } else {
      request.reject(new Error(response.data.error));
    }
  });

  const send = (
    body: VaultRequestBody,
    timeoutMs: number,
  ): Promise<VaultStatus | string> =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(NO_RESPONSE_MESSAGE));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ type: VAULT_REQUEST_MESSAGE_TYPE, id, ...body });
    });

  const sendForText = async (body: VaultRequestBody): Promise<string> => {
    const result = await send(body, timeouts.cryptoMs);
    if (typeof result !== "string") {
      throw new Error(UNEXPECTED_RESULT_MESSAGE);
    }
    return result;
  };

  return {
    status: async () => {
      const parsed = VaultStatusSchema.safeParse(
        await send({ op: VaultOp.status }, timeouts.statusMs),
      );
      if (!parsed.success) {
        throw new Error(UNEXPECTED_RESULT_MESSAGE);
      }
      return parsed.data;
    },
    encrypt: (plaintext) => sendForText({ op: VaultOp.encrypt, plaintext }),
    decrypt: (ciphertext) => sendForText({ op: VaultOp.decrypt, ciphertext }),
  };
}
