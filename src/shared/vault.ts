import { z } from "zod";

import {
  VAULT_REQUEST_MESSAGE_TYPE,
  VAULT_RESPONSE_MESSAGE_TYPE,
} from "./constants";

export const VaultOp = {
  status: "status",
  encrypt: "encrypt",
  decrypt: "decrypt",
} as const;
export type VaultOp = (typeof VaultOp)[keyof typeof VaultOp];

export const VaultStatusSchema = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type VaultStatus = z.infer<typeof VaultStatusSchema>;

const requestEnvelope = {
  type: z.literal(VAULT_REQUEST_MESSAGE_TYPE),
  id: z.string().min(1),
};

export const VaultRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ ...requestEnvelope, op: z.literal(VaultOp.status) }),
  z.strictObject({
    ...requestEnvelope,
    op: z.literal(VaultOp.encrypt),
    plaintext: z.string(),
  }),
  z.strictObject({
    ...requestEnvelope,
    op: z.literal(VaultOp.decrypt),
    ciphertext: z.string(),
  }),
]);
export type VaultRequest = z.infer<typeof VaultRequestSchema>;

const responseEnvelope = {
  type: z.literal(VAULT_RESPONSE_MESSAGE_TYPE),
  id: z.string().min(1),
};

export const VaultResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ...responseEnvelope,
    ok: z.literal(true),
    result: z.union([VaultStatusSchema, z.string()]),
  }),
  z.strictObject({
    ...responseEnvelope,
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type VaultResponse = z.infer<typeof VaultResponseSchema>;
