import { z } from "zod";

import {
  OpencodeEventType,
  OpencodePartType,
  OpencodeStatusType,
  OpencodeToolStatus,
} from "./constants";

export const SessionResponseSchema = z.looseObject({ id: z.string() });

export const LatestMessagesSchema = z.array(
  z.looseObject({ info: z.looseObject({ id: z.string() }) }),
);

export const SessionStatusMapSchema = z.record(
  z.string(),
  z.looseObject({ type: z.string() }),
);

export const ProvidersResponseSchema = z.object({
  providers: z.array(
    z.object({ id: z.string(), models: z.record(z.string(), z.unknown()) }),
  ),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export const TextPartSchema = z.looseObject({
  type: z.literal(OpencodePartType.text),
  id: z.string(),
  sessionID: z.string().optional(),
  messageID: z.string().optional(),
  synthetic: z.boolean().optional(),
  text: z.string(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ToolStateSchema = z.looseObject({
  status: z.enum(OpencodeToolStatus),
  input: z.unknown().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  title: z.string().optional(),
});
export type ToolState = z.infer<typeof ToolStateSchema>;

export const ToolPartSchema = z.looseObject({
  type: z.literal(OpencodePartType.tool),
  id: z.string(),
  sessionID: z.string().optional(),
  callID: z.string(),
  tool: z.string(),
  state: ToolStateSchema,
});
export type ToolPart = z.infer<typeof ToolPartSchema>;

const PartUpdatedSchema = z.looseObject({
  type: z.literal(OpencodeEventType.partUpdated),
  properties: z.looseObject({
    part: z.discriminatedUnion("type", [TextPartSchema, ToolPartSchema]),
  }),
});

export const PermissionAskedPropertiesSchema = z.looseObject({
  id: z.string(),
  sessionID: z.string().optional(),
  permission: z.string(),
  patterns: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  tool: z.looseObject({ callID: z.string().optional() }).optional(),
});
export type PermissionAskedProperties = z.infer<
  typeof PermissionAskedPropertiesSchema
>;

const PermissionAskedSchema = z.looseObject({
  type: z.literal(OpencodeEventType.permissionAsked),
  properties: PermissionAskedPropertiesSchema,
});

const SessionStatusSchema = z.looseObject({
  type: z.literal(OpencodeEventType.sessionStatus),
  properties: z.looseObject({
    sessionID: z.string().optional(),
    status: z.discriminatedUnion("type", [
      z.looseObject({ type: z.literal(OpencodeStatusType.busy) }),
      z.looseObject({ type: z.literal(OpencodeStatusType.idle) }),
      z.looseObject({
        type: z.literal(OpencodeStatusType.retry),
        message: z.string().optional(),
        next: z.number().optional(),
      }),
    ]),
  }),
});

const SessionIdleSchema = z.looseObject({
  type: z.literal(OpencodeEventType.sessionIdle),
  properties: z.looseObject({ sessionID: z.string().optional() }),
});

export const SessionErrorInfoSchema = z.looseObject({
  name: z.string(),
  data: z
    .looseObject({
      message: z.string().optional(),
      statusCode: z.number().optional(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
export type SessionErrorInfo = z.infer<typeof SessionErrorInfoSchema>;

const SessionErrorSchema = z.looseObject({
  type: z.literal(OpencodeEventType.sessionError),
  properties: z.looseObject({
    sessionID: z.string().optional(),
    error: SessionErrorInfoSchema.optional(),
  }),
});

const MessageUpdatedSchema = z.looseObject({
  type: z.literal(OpencodeEventType.messageUpdated),
  properties: z.looseObject({
    info: z.looseObject({
      id: z.string(),
      role: z.string(),
      sessionID: z.string().optional(),
      modelID: z.string().optional(),
    }),
  }),
});

export const SessionInfoSchema = z.looseObject({
  id: z.string(),
  parentID: z.string().nullish(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

const SessionLifecycleSchema = z.looseObject({
  type: z.literal([
    OpencodeEventType.sessionCreated,
    OpencodeEventType.sessionUpdated,
  ]),
  properties: z.looseObject({ info: SessionInfoSchema }),
});

export const OpencodeEventSchema = z.discriminatedUnion("type", [
  MessageUpdatedSchema,
  SessionLifecycleSchema,
  PartUpdatedSchema,
  PermissionAskedSchema,
  SessionStatusSchema,
  SessionIdleSchema,
  SessionErrorSchema,
]);
export type OpencodeEvent = z.infer<typeof OpencodeEventSchema>;

export function parseOpencodeEvent(payload: unknown): OpencodeEvent | null {
  const parsed = OpencodeEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
