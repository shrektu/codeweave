import { z } from "zod";

import { OpencodeV2EventType } from "./constants";

export const SessionCreatedResponseSchema = z.looseObject({
  data: z.looseObject({ id: z.string() }),
});

export const ActiveSessionsSchema = z.looseObject({
  data: z.record(z.string(), z.unknown()),
});

export const InterruptResponseSchema = z.looseObject({
  interrupted: z.boolean(),
});

export const V2ModelSchema = z.object({
  id: z.string().min(1),
  providerID: z.string(),
  name: z.string(),
  capabilities: z.object({
    tools: z.boolean(),
    input: z.array(z.string()),
    output: z.array(z.string()),
  }),
  cost: z.array(z.object({ input: z.number(), output: z.number() })).optional(),
  limit: z.object({ context: z.number() }).optional(),
});
export type V2Model = z.infer<typeof V2ModelSchema>;

export const ModelListResponseSchema = z.looseObject({
  data: z.array(z.unknown()),
});

export const ExecutionErrorSchema = z.looseObject({
  type: z.string(),
  message: z.string(),
  status: z.number().optional(),
  retryAfterMs: z.number().optional(),
});
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;

const SESSION_SHAPE = { sessionID: z.string() };

const ServerConnectedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.serverConnected),
  data: z.looseObject({}),
});

const SessionCreatedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.sessionCreated),
  data: z.looseObject({ ...SESSION_SHAPE, parentID: z.string().nullish() }),
});

const ExecutionStartedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.executionStarted),
  data: z.looseObject(SESSION_SHAPE),
});

const ExecutionSucceededSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.executionSucceeded),
  data: z.looseObject(SESSION_SHAPE),
});

const ExecutionFailedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.executionFailed),
  data: z.looseObject({ ...SESSION_SHAPE, error: ExecutionErrorSchema }),
});

const ExecutionInterruptedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.executionInterrupted),
  data: z.looseObject({ ...SESSION_SHAPE, reason: z.string() }),
});

const StepStartedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.stepStarted),
  data: z.looseObject({
    ...SESSION_SHAPE,
    model: z.looseObject({ id: z.string(), providerID: z.string().optional() }),
  }),
});

const TextDeltaSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.textDelta),
  data: z.looseObject({
    ...SESSION_SHAPE,
    assistantMessageID: z.string(),
    ordinal: z.number(),
    delta: z.string(),
  }),
});

const TextEndedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.textEnded),
  data: z.looseObject({
    ...SESSION_SHAPE,
    assistantMessageID: z.string(),
    ordinal: z.number(),
    text: z.string(),
  }),
});

const ToolInputStartedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.toolInputStarted),
  data: z.looseObject({
    ...SESSION_SHAPE,
    id: z.string(),
    name: z.string(),
  }),
});

const ToolCalledSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.toolCalled),
  data: z.looseObject({ ...SESSION_SHAPE, id: z.string(), input: z.unknown() }),
});

const ToolProgressSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.toolProgress),
  data: z.looseObject({ ...SESSION_SHAPE, id: z.string() }),
});

const ToolSuccessSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.toolSuccess),
  data: z.looseObject({
    ...SESSION_SHAPE,
    id: z.string(),
    content: z
      .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
      .default([]),
  }),
});

const ToolFailedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.toolFailed),
  data: z.looseObject({
    ...SESSION_SHAPE,
    id: z.string(),
    error: z.looseObject({ message: z.string() }),
  }),
});

const RetryScheduledSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.retryScheduled),
  data: z.looseObject({
    ...SESSION_SHAPE,
    attempt: z.number(),
    at: z.number(),
    error: ExecutionErrorSchema,
  }),
});

const PermissionAskedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.permissionAsked),
  data: z.looseObject({
    id: z.string(),
    ...SESSION_SHAPE,
    action: z.string(),
    resources: z.array(z.string()).default([]),
    source: z.looseObject({ id: z.string().optional() }).optional(),
  }),
});

const PermissionRepliedSchema = z.looseObject({
  type: z.literal(OpencodeV2EventType.permissionReplied),
  data: z.looseObject({
    ...SESSION_SHAPE,
    requestID: z.string(),
    reply: z.string(),
  }),
});

export const OpencodeV2EventSchema = z.discriminatedUnion("type", [
  ServerConnectedSchema,
  SessionCreatedSchema,
  ExecutionStartedSchema,
  ExecutionSucceededSchema,
  ExecutionFailedSchema,
  ExecutionInterruptedSchema,
  StepStartedSchema,
  TextDeltaSchema,
  TextEndedSchema,
  ToolInputStartedSchema,
  ToolCalledSchema,
  ToolProgressSchema,
  ToolSuccessSchema,
  ToolFailedSchema,
  RetryScheduledSchema,
  PermissionAskedSchema,
  PermissionRepliedSchema,
]);
export type OpencodeV2Event = z.infer<typeof OpencodeV2EventSchema>;

export function parseOpencodeV2Event(payload: unknown): OpencodeV2Event | null {
  const parsed = OpencodeV2EventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
