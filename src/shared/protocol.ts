import { z } from "zod";

import { EffectLevel, PermissionProfile } from "../domain/types";

import {
  CONNECT_MESSAGE_TYPE,
  SHUTDOWN_DONE_MESSAGE_TYPE,
  SHUTDOWN_MESSAGE_TYPE,
} from "./constants";
import {
  AccountViewSchema,
  FlowRefSchema,
  FlowsListSchema,
  SessionViewSchema,
  SettingsViewSchema,
  SnapshotSchema,
  SwitchLogEntryViewSchema,
} from "./views";

export const IpcErrorCode = {
  VALIDATION: "VALIDATION",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  INTERNAL: "INTERNAL",
  SESSION_BUSY: "SESSION_BUSY",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNAVAILABLE: "UNAVAILABLE",
  EXPIRED: "EXPIRED",
} as const;
export type IpcErrorCode = (typeof IpcErrorCode)[keyof typeof IpcErrorCode];

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}

const NonEmptyString = z.string().min(1);
const NonBlankString = z.string().refine((text) => text.trim().length > 0);
const EmptyParamsSchema = z.strictObject({});

const SettingsPatchSchema = z
  .strictObject({
    permissionProfile: z.enum(PermissionProfile).optional(),
    effectLevel: z.enum(EffectLevel).optional(),
    claudeExecutable: z.string().nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined));

export const ParamsSchemas = {
  ping: EmptyParamsSchema,
  "sessions/snapshot": EmptyParamsSchema,
  "session/start": z.strictObject({
    cwd: NonEmptyString,
    profile: z.enum(PermissionProfile).optional(),
    flowRef: FlowRefSchema.optional(),
  }),
  "session/prompt": z.strictObject({ text: NonBlankString }),
  "session/stop": EmptyParamsSchema,
  "permission/answer": z.strictObject({
    requestId: NonEmptyString,
    optionId: NonEmptyString,
  }),
  "accounts/list": EmptyParamsSchema,
  "accounts/suggest": EmptyParamsSchema,
  "accounts/add": z.strictObject({
    label: NonBlankString,
    configDir: NonEmptyString,
  }),
  "accounts/remove": z.strictObject({ id: z.string() }),
  "accounts/move": z.strictObject({
    id: z.string(),
    direction: z.enum(["up", "down"]),
  }),
  "settings/get": EmptyParamsSchema,
  "settings/set": SettingsPatchSchema,
  "switchLog/list": EmptyParamsSchema,
  "flows/list": z.strictObject({ cwd: NonEmptyString }),
} as const;

export type RequestMethod = keyof typeof ParamsSchemas;
export type ParamsMap = {
  [M in RequestMethod]: z.infer<(typeof ParamsSchemas)[M]>;
};

function requestSchema<M extends RequestMethod>(
  method: M,
): z.ZodObject<{
  v: z.ZodInt;
  id: z.ZodString;
  method: z.ZodLiteral<M>;
  params: (typeof ParamsSchemas)[M];
}> {
  return z.strictObject({
    v: z.int(),
    id: z.string().min(1),
    method: z.literal(method),
    params: ParamsSchemas[method],
  });
}

export const RequestSchema = z.discriminatedUnion("method", [
  requestSchema("ping"),
  requestSchema("sessions/snapshot"),
  requestSchema("session/start"),
  requestSchema("session/prompt"),
  requestSchema("session/stop"),
  requestSchema("permission/answer"),
  requestSchema("accounts/list"),
  requestSchema("accounts/suggest"),
  requestSchema("accounts/add"),
  requestSchema("accounts/remove"),
  requestSchema("accounts/move"),
  requestSchema("settings/get"),
  requestSchema("settings/set"),
  requestSchema("switchLog/list"),
  requestSchema("flows/list"),
]);
export type IpcRequest = z.infer<typeof RequestSchema>;

export const PingResultSchema = z.strictObject({
  pong: z.literal(true),
  backendPid: z.int(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

const AccountsResultSchema = z.strictObject({
  accounts: z.array(AccountViewSchema),
});

const resultSchemaDefinitions = {
  ping: PingResultSchema,
  "sessions/snapshot": SnapshotSchema,
  "session/start": SessionViewSchema,
  "session/prompt": z.strictObject({ accepted: z.literal(true) }),
  "session/stop": z.strictObject({ stopped: z.boolean() }),
  "permission/answer": z.strictObject({ ok: z.literal(true) }),
  "accounts/list": AccountsResultSchema,
  "accounts/suggest": z.strictObject({ configDir: z.string() }),
  "accounts/add": z.strictObject({ account: AccountViewSchema }),
  "accounts/remove": AccountsResultSchema,
  "accounts/move": AccountsResultSchema,
  "settings/get": SettingsViewSchema,
  "settings/set": SettingsViewSchema,
  "switchLog/list": z.strictObject({
    entries: z.array(SwitchLogEntryViewSchema),
  }),
  "flows/list": FlowsListSchema,
} as const;

export type ResultMap = {
  [M in RequestMethod]: z.infer<(typeof resultSchemaDefinitions)[M]>;
};

export const ResultSchemas: {
  [M in RequestMethod]: z.ZodType<ResultMap[M]>;
} = resultSchemaDefinitions;

const SuccessResponseSchema = z.strictObject({
  v: z.int(),
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
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

export const EventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    v: z.int(),
    event: z.literal("session/changed"),
    payload: SessionViewSchema.nullable(),
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("accounts/changed"),
    payload: AccountsResultSchema,
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("settings/changed"),
    payload: SettingsViewSchema,
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("switchLog/appended"),
    payload: SwitchLogEntryViewSchema,
  }),
]);
export type IpcEvent = z.infer<typeof EventSchema>;
export type EventName = IpcEvent["event"];
export type EventPayloadMap = {
  [E in EventName]: Extract<IpcEvent, { event: E }>["payload"];
};

export const ConnectMessageSchema = z.strictObject({
  type: z.literal(CONNECT_MESSAGE_TYPE),
});
export type ConnectMessage = z.infer<typeof ConnectMessageSchema>;

export const ShutdownMessageSchema = z.strictObject({
  type: z.literal(SHUTDOWN_MESSAGE_TYPE),
});
export type ShutdownMessage = z.infer<typeof ShutdownMessageSchema>;

export const ShutdownDoneMessageSchema = z.strictObject({
  type: z.literal(SHUTDOWN_DONE_MESSAGE_TYPE),
});
export type ShutdownDoneMessage = z.infer<typeof ShutdownDoneMessageSchema>;
