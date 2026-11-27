import { z } from "zod";

import { CodexItemType } from "./constants";

export const InitializeResponseSchema = z.looseObject({
  userAgent: z.string().optional(),
  codexHome: z.string().optional(),
});

export const AccountReadResponseSchema = z.looseObject({
  account: z.looseObject({ type: z.string() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
export type AccountReadResponse = z.infer<typeof AccountReadResponseSchema>;

export const RateLimitWindowSchema = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

export const RateLimitSnapshotSchema = z.looseObject({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  primary: RateLimitWindowSchema.nullish(),
  secondary: RateLimitWindowSchema.nullish(),
  rateLimitReachedType: z.string().nullish(),
});
export type RateLimitSnapshot = z.infer<typeof RateLimitSnapshotSchema>;

export const RateLimitsReadResponseSchema = z.looseObject({
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimits: RateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshotSchema).nullish(),
});
export type RateLimitsReadResponse = z.infer<
  typeof RateLimitsReadResponseSchema
>;

export const AccountRateLimitsUpdatedSchema = z.looseObject({
  rateLimits: RateLimitSnapshotSchema,
});

export const ThreadStartResponseSchema = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string().nullish(),
  modelProvider: z.string().nullish(),
});

export const ThreadCompactStartResponseSchema = z.strictObject({});

export const ModelReroutedParamsSchema = z.looseObject({
  toModel: z.string(),
});

const TokenUsageBreakdownSchema = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
});

export const ThreadTokenUsageUpdatedParamsSchema = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.looseObject({
    total: TokenUsageBreakdownSchema,
    last: TokenUsageBreakdownSchema,
    modelContextWindow: z.number().nullable().optional(),
  }),
});

export const CodexErrorInfoSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);
export type CodexErrorInfo = z.infer<typeof CodexErrorInfoSchema>;

export const HttpConnectionFailedInfoSchema = z.object({
  httpConnectionFailed: z.looseObject({
    httpStatusCode: z.number().nullish(),
  }),
});

export const TurnErrorSchema = z.looseObject({
  message: z.string(),
  codexErrorInfo: CodexErrorInfoSchema.nullish(),
});
export type TurnError = z.infer<typeof TurnErrorSchema>;

export const TurnSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  error: TurnErrorSchema.nullish(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const TurnStartResponseSchema = z.looseObject({ turn: TurnSchema });
export const TurnStartedParamsSchema = z.looseObject({
  threadId: z.string().optional(),
  turn: TurnSchema,
});
export const TurnCompletedParamsSchema = z.looseObject({ turn: TurnSchema });
export type TurnCompletedParams = z.infer<typeof TurnCompletedParamsSchema>;

export const ErrorNotificationParamsSchema = z.looseObject({
  error: TurnErrorSchema,
  willRetry: z.boolean(),
});
export type ErrorNotificationParams = z.infer<
  typeof ErrorNotificationParamsSchema
>;

export const EmptyResultSchema = z.looseObject({});

const ItemStatusSchema = z.string().optional();

const AgentMessageItemSchema = z.looseObject({
  type: z.literal(CodexItemType.agentMessage),
  id: z.string(),
});

const CommandExecutionItemSchema = z.looseObject({
  type: z.literal(CodexItemType.commandExecution),
  id: z.string(),
  command: z.string(),
  status: ItemStatusSchema,
  aggregatedOutput: z.string().nullish(),
});

const FileChangeItemSchema = z.looseObject({
  type: z.literal(CodexItemType.fileChange),
  id: z.string(),
  status: ItemStatusSchema,
  changes: z.array(
    z.looseObject({
      path: z.string(),
      kind: z
        .looseObject({
          type: z.string(),
          move_path: z.string().nullish(),
        })
        .optional(),
      diff: z.string().optional(),
    }),
  ),
});

const McpToolCallItemSchema = z.looseObject({
  type: z.literal(CodexItemType.mcpToolCall),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  status: ItemStatusSchema,
});

const WebSearchItemSchema = z.looseObject({
  type: z.literal(CodexItemType.webSearch),
  id: z.string(),
  query: z.string(),
  status: ItemStatusSchema,
});

export const KnownThreadItemSchema = z.discriminatedUnion("type", [
  AgentMessageItemSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  McpToolCallItemSchema,
  WebSearchItemSchema,
]);
export type KnownThreadItem = z.infer<typeof KnownThreadItemSchema>;

const UnknownThreadItemSchema = z.looseObject({ type: z.string() });

export const ThreadItemSchema = z.union([
  KnownThreadItemSchema,
  UnknownThreadItemSchema,
]);
export type ThreadItem = z.infer<typeof ThreadItemSchema>;

export const ItemNotificationParamsSchema = z.looseObject({
  item: ThreadItemSchema,
});
export type ItemNotificationParams = z.infer<
  typeof ItemNotificationParamsSchema
>;

export const AgentMessageDeltaParamsSchema = z.looseObject({
  itemId: z.string(),
  delta: z.string(),
});
export type AgentMessageDeltaParams = z.infer<
  typeof AgentMessageDeltaParamsSchema
>;

export const CommandApprovalParamsSchema = z.looseObject({
  itemId: z.string(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
});
export type CommandApprovalParams = z.infer<typeof CommandApprovalParamsSchema>;

export const FileChangeApprovalParamsSchema = z.looseObject({
  itemId: z.string(),
});
export type FileChangeApprovalParams = z.infer<
  typeof FileChangeApprovalParamsSchema
>;

export const PermissionsApprovalParamsSchema = z.looseObject({
  itemId: z.string(),
  permissions: z.record(z.string(), z.unknown()),
});
export type PermissionsApprovalParams = z.infer<
  typeof PermissionsApprovalParamsSchema
>;
