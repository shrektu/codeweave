import { z } from "zod";

import {
  EffectLevel,
  PermissionProfile,
  ProviderId,
  SwitchReason,
} from "../domain/types";

import { SWITCH_LOG_SNAPSHOT_LIMIT } from "./constants";

const NonEmptyString = z.string().min(1);

export const AccountRuntimeViewSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({ status: z.literal("exhausted"), resetsAt: z.number() }),
  z.strictObject({ status: z.literal("needs_login") }),
]);
export type AccountRuntimeView = z.infer<typeof AccountRuntimeViewSchema>;

export const AccountViewSchema = z.strictObject({
  id: z.string(),
  provider: z.enum(ProviderId),
  label: z.string(),
  configDir: z.string(),
  order: z.int(),
  runtime: AccountRuntimeViewSchema,
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const LimitViewSchema = z.strictObject({
  accountId: z.string(),
  status: z.string(),
  resetsAt: z.number().nullable(),
  rateLimitType: z.string().nullable(),
  utilization: z.number().nullable(),
  observedAt: z.number(),
});
export type LimitView = z.infer<typeof LimitViewSchema>;

export const ToolCallViewSchema = z.strictObject({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  command: z.string().optional(),
  output: z.string().optional(),
  seq: z.number().int(),
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;

export const MessageViewSchema = z.strictObject({
  id: z.string().nullable(),
  text: z.string(),
  seq: z.number().int(),
});
export type MessageView = z.infer<typeof MessageViewSchema>;

export const PermissionViewSchema = z.strictObject({
  requestId: z.string(),
  toolCallId: z.string(),
  title: z.string(),
  command: z.string().optional(),
  seq: z.number().int(),
  options: z
    .array(
      z.strictObject({
        optionId: z.string(),
        name: z.string(),
        kind: z.string(),
      }),
    )
    .min(1),
});
export type PermissionView = z.infer<typeof PermissionViewSchema>;

export const RotationPhaseViewSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("running"), accountId: z.string() }),
  z.strictObject({
    phase: z.literal("switching"),
    from: z.string(),
    to: z.string(),
  }),
  z.strictObject({
    phase: z.literal("waiting"),
    accountId: z.string(),
    until: z.number(),
  }),
  z.strictObject({
    phase: z.literal("failed"),
    reason: z.string(),
    runningAccountId: z.string().nullable(),
  }),
  z.strictObject({ phase: z.literal("halted") }),
  z.strictObject({ phase: z.literal("stopped") }),
]);
export type RotationPhaseView = z.infer<typeof RotationPhaseViewSchema>;

export const FlowRefSchema = z.strictObject({
  flowId: NonEmptyString,
  nodeId: NonEmptyString,
});
export type FlowRef = z.infer<typeof FlowRefSchema>;

export const LastTurnViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ended"), stopReason: z.string() }),
  z.strictObject({ kind: z.literal("failed"), message: z.string() }),
]);

export const SessionViewSchema = z.strictObject({
  id: z.string(),
  cwd: z.string(),
  profile: z.enum(PermissionProfile),
  phase: RotationPhaseViewSchema,
  activeAccountId: z.string().nullable(),
  messages: z.array(MessageViewSchema),
  toolCalls: z.array(ToolCallViewSchema),
  permissions: z.array(PermissionViewSchema),
  limits: z.array(LimitViewSchema),
  lastTurn: LastTurnViewSchema.nullable(),
  turnInFlight: z.boolean(),
  flowRef: FlowRefSchema.nullable(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const SettingsViewSchema = z.strictObject({
  permissionProfile: z.enum(PermissionProfile),
  effectLevel: z.enum(EffectLevel),
  claudeExecutable: z.string().nullable(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const SwitchLogEntryViewSchema = z.strictObject({
  at: z.number(),
  sessionId: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  reason: z.enum(SwitchReason),
  resetsAt: z.number().nullable(),
  contextPackageChars: z.number(),
});
export type SwitchLogEntryView = z.infer<typeof SwitchLogEntryViewSchema>;

export const SnapshotSchema = z.strictObject({
  session: SessionViewSchema.nullable(),
  accounts: z.array(AccountViewSchema),
  settings: SettingsViewSchema,
  switchLog: z.array(SwitchLogEntryViewSchema).max(SWITCH_LOG_SNAPSHOT_LIMIT),
  container: z.strictObject({
    available: z.boolean(),
    message: z.string().nullable(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
