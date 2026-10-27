import { z } from "zod";

import { CONNECT_MESSAGE_TYPE } from "./constants";

export const IpcErrorCode = {
  VALIDATION: "VALIDATION",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  INTERNAL: "INTERNAL",
} as const;
export type IpcErrorCode = (typeof IpcErrorCode)[keyof typeof IpcErrorCode];

const PingRequestSchema = z.strictObject({
  v: z.int(),
  id: z.string().min(1),
  method: z.literal("ping"),
});

export const RequestSchema = z.discriminatedUnion("method", [
  PingRequestSchema,
]);
export type IpcRequest = z.infer<typeof RequestSchema>;
export type RequestMethod = IpcRequest["method"];

export const PingResultSchema = z.strictObject({
  pong: z.literal(true),
  backendPid: z.int(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

export interface ResultMap {
  ping: PingResult;
}

export const ResultSchemas: {
  [M in RequestMethod]: z.ZodType<ResultMap[M]>;
} = {
  ping: PingResultSchema,
};

const SuccessResponseSchema = z.strictObject({
  v: z.int(),
  id: z.string(),
  ok: z.literal(true),
  result: z.union([PingResultSchema]),
});

const ErrorResponseSchema = z.strictObject({
  v: z.int(),
  id: z.string().nullable(),
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum(IpcErrorCode),
    message: z.string(),
  }),
});

export const ResponseSchema = z.discriminatedUnion("ok", [
  SuccessResponseSchema,
  ErrorResponseSchema,
]);
export type IpcResponse = z.infer<typeof ResponseSchema>;

export const ConnectMessageSchema = z.strictObject({
  type: z.literal(CONNECT_MESSAGE_TYPE),
});
export type ConnectMessage = z.infer<typeof ConnectMessageSchema>;
