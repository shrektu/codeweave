import { z } from "zod";

import { AgyEventName } from "./constants";

const ToolInfoSchema = z.looseObject({
  name: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  error: z
    .looseObject({
      type: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

export const StepUpdateSchema = z.looseObject({
  conversation_id: z.string().optional(),
  step_index: z.number(),
  state: z.string(),
  step_type: z.string(),
  text_delta: z.string().optional(),
  tool_name: z.string().optional(),
  tool_info: ToolInfoSchema.optional(),
});
export type StepUpdate = z.infer<typeof StepUpdateSchema>;

export const ResultSchema = z.looseObject({
  conversation_id: z.string().optional(),
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  finished_reason: z.string().optional(),
});
export type AgyResult = z.infer<typeof ResultSchema>;

const InitEventSchema = z.looseObject({
  event: z.literal(AgyEventName.init),
  conversation_id: z.string().optional(),
});
const StepEventSchema = z.looseObject({
  event: z.literal(AgyEventName.stepUpdate),
  step_update: StepUpdateSchema,
});
const ResultEventSchema = z.looseObject({
  event: z.literal(AgyEventName.result),
  result: ResultSchema,
});

const AgyEventSchema = z.discriminatedUnion("event", [
  InitEventSchema,
  StepEventSchema,
  ResultEventSchema,
]);
export type AgyEvent = z.infer<typeof AgyEventSchema>;

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn("agy sent an unparseable line", error);
    return undefined;
  }
}

export function parseAgyEvent(line: string): AgyEvent | null {
  const parsed = AgyEventSchema.safeParse(parseJson(line));
  return parsed.success ? parsed.data : null;
}

const AgyErrorLineSchema = z.looseObject({
  short_error: z.string().optional(),
  status: z.string().optional(),
  error_code: z.number().optional(),
});
export type AgyErrorLine = z.infer<typeof AgyErrorLineSchema>;

export function parseAgyErrorLine(json: string): AgyErrorLine | null {
  const parsed = AgyErrorLineSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : null;
}

export const HookPayloadSchema = z.looseObject({
  toolCall: z.looseObject({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  workspacePaths: z.array(z.string()).default([]),
});
export type AgyHookPayload = z.infer<typeof HookPayloadSchema>;

const UsageBucketSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number(),
  reset_time: z.string().optional(),
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

const UsageGroupSchema = z.looseObject({
  name: z.string(),
  buckets: z.array(UsageBucketSchema),
});

export const UsageOutputSchema = z.looseObject({
  status: z.string(),
  error: z.string().optional(),
  command: z
    .looseObject({
      data: z.looseObject({ groups: z.array(UsageGroupSchema) }).optional(),
    })
    .optional(),
});
export type UsageOutput = z.infer<typeof UsageOutputSchema>;
