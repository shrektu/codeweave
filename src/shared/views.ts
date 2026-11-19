import { z } from "zod";

import {
  API_PROVIDERS,
  ApiAuth,
  ApiProviderId,
  TRAINING_UNKNOWN,
} from "../domain/apiProviders";
import { DiffOmission, FileChange } from "../domain/events";
import {
  DecisionReason,
  FlowNodeRunStatus,
  FlowRunStatus,
} from "../domain/flowRun";
import { RouteSource } from "../domain/routing";
import { TaskClass, TaskClassSchema } from "../domain/taskClass";
import {
  EdgeKind,
  EffectLevel,
  PermissionProfile,
  ProviderId,
  SwitchReason,
  TerminalStatus,
  UpdateChannel,
} from "../domain/types";

import { SWITCH_LOG_SNAPSHOT_LIMIT } from "./constants";

const NonEmptyString = z.string().min(1);
const NO_CONSOLE_LOGIN_MESSAGE = "This provider has no Console login";

export const AccountRuntimeViewSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({ status: z.literal("exhausted"), resetsAt: z.number() }),
  z.strictObject({ status: z.literal("needs_login") }),
]);
export type AccountRuntimeView = z.infer<typeof AccountRuntimeViewSchema>;

export const LimitViewSchema = z.strictObject({
  accountId: z.string(),
  status: z.string(),
  resetsAt: z.number().nullable(),
  rateLimitType: z.string().nullable(),
  utilization: z.number().nullable(),
  observedAt: z.number(),
});
export type LimitView = z.infer<typeof LimitViewSchema>;

export const ApiAccountSchema = z
  .strictObject({
    provider: z.enum(ApiProviderId),
    model: NonEmptyString,
    baseUrl: z.url().nullable(),
    rotation: z.boolean(),
    auth: z.enum(ApiAuth).default(ApiAuth.apiKey),
  })
  .refine(
    (api) =>
      api.auth !== ApiAuth.consoleLogin ||
      API_PROVIDERS[api.provider].consoleLogin,
    { message: NO_CONSOLE_LOGIN_MESSAGE, path: ["auth"] },
  );

export const AccountViewSchema = z.strictObject({
  id: z.string(),
  provider: z.enum(ProviderId),
  label: z.string(),
  configDir: z.string(),
  order: z.int(),
  api: ApiAccountSchema.nullable(),
  hasKey: z.boolean(),
  keyHint: z.string().nullable(),
  runtime: AccountRuntimeViewSchema,
  limit: LimitViewSchema.nullable(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const FileDiffViewSchema = z.union([
  z.strictObject({
    path: z.string(),
    change: z.enum(FileChange),
    patch: z.string(),
  }),
  z.strictObject({
    path: z.string(),
    change: z.enum(FileChange),
    omitted: z.enum(DiffOmission),
  }),
]);
export type FileDiffView = z.infer<typeof FileDiffViewSchema>;

export const ToolCallViewSchema = z.strictObject({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  command: z.string().optional(),
  output: z.string().optional(),
  diffs: z.array(FileDiffViewSchema).optional(),
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

export const TurnRouteViewSchema = z.strictObject({
  promptSeq: z.int(),
  accountId: z.string(),
  model: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  apiProvider: z.enum(ApiProviderId).nullable(),
  requestedClass: z.enum(TaskClass),
  servedClass: z.enum(TaskClass).nullable(),
  source: z.enum(RouteSource),
});
export type TurnRouteView = z.infer<typeof TurnRouteViewSchema>;

export const SessionViewSchema = z.strictObject({
  id: z.string(),
  cwd: z.string(),
  provider: z.enum(ProviderId),
  profile: z.enum(PermissionProfile),
  phase: RotationPhaseViewSchema,
  activeAccountId: z.string().nullable(),
  activeProvider: z.enum(ProviderId),
  messages: z.array(MessageViewSchema),
  toolCalls: z.array(ToolCallViewSchema),
  permissions: z.array(PermissionViewSchema),
  limits: z.array(LimitViewSchema),
  lastTurn: LastTurnViewSchema.nullable(),
  turnInFlight: z.boolean(),
  flowRef: FlowRefSchema.nullable(),
  turns: z.array(TurnRouteViewSchema),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const AgentViewSchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  revision: z.string(),
  role: z.string(),
  provider: z.enum(ProviderId),
  model: z.string().nullable(),
  permissionProfile: z.enum(PermissionProfile),
  taskClass: TaskClassSchema.nullable(),
  body: z.string(),
  usedBy: z.array(z.strictObject({ file: z.string(), title: z.string() })),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

export const FlowViewSchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  revision: z.string(),
  title: z.string(),
  maxRounds: z.int(),
  nodes: z.array(
    z.strictObject({
      id: z.string(),
      agent: z.string(),
      provider: z.enum(ProviderId).nullable(),
      taskClass: TaskClassSchema.nullable(),
    }),
  ),
  edges: z.array(
    z.strictObject({
      from: z.string(),
      to: z.string(),
      kind: z.enum(EdgeKind),
      gate: z.boolean(),
    }),
  ),
});
export type FlowView = z.infer<typeof FlowViewSchema>;

export const FlowFileErrorSchema = z.strictObject({
  file: z.string(),
  messages: z.array(z.string()),
});
export type FlowFileError = z.infer<typeof FlowFileErrorSchema>;

export const FlowsListSchema = z.strictObject({
  flows: z.array(FlowViewSchema),
  agents: z.array(AgentViewSchema),
  errors: z.array(FlowFileErrorSchema),
});
export type FlowsList = z.infer<typeof FlowsListSchema>;

export const FlowRunViewSchema = z.strictObject({
  runId: NonEmptyString,
  flowId: NonEmptyString,
  flowTitle: z.string(),
  cwd: NonEmptyString,
  task: z.string(),
  status: z.enum(FlowRunStatus),
  round: z.int(),
  maxRounds: z.int(),
  currentNodeId: z.string().nullable(),
  nodes: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(FlowNodeRunStatus),
      visits: z.int(),
      result: z.string().nullable(),
    }),
  ),
  decision: z
    .strictObject({
      reason: z.enum(DecisionReason),
      nodeId: z.string(),
    })
    .nullable(),
  failure: z.string().nullable(),
});
export type FlowRunView = z.infer<typeof FlowRunViewSchema>;

export const SettingsViewSchema = z.strictObject({
  permissionProfile: z.enum(PermissionProfile),
  effectLevel: z.enum(EffectLevel),
  claudeExecutable: z.string().nullable(),
  codexExecutable: z.string().nullable(),
  agyExecutable: z.string().nullable(),
  opencodeExecutable: z.string().nullable(),
  terminalShell: z.string().nullable(),
  updateCheck: z.boolean(),
  updateChannel: z.enum(UpdateChannel),
  defaultTaskClass: TaskClassSchema,
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const TerminalViewSchema = z.strictObject({
  id: NonEmptyString,
  cwd: NonEmptyString,
  shell: NonEmptyString,
  status: z.enum(TerminalStatus),
  exitCode: z.int().nullable(),
});
export type TerminalView = z.infer<typeof TerminalViewSchema>;

export const CatalogModelSchema = z.strictObject({
  providerId: z.enum(ApiProviderId),
  modelId: NonEmptyString,
  name: z.string(),
  contextWindow: z.number().nullable(),
  costIn: z.number().nullable(),
  costOut: z.number().nullable(),
  free: z.boolean(),
  trainsOnData: z.union([z.boolean(), z.literal(TRAINING_UNKNOWN)]),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const ModelCatalogSchema = z.strictObject({
  models: z.array(CatalogModelSchema),
  error: z.string().nullable(),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

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
  terminal: TerminalViewSchema.nullable(),
  flowRun: FlowRunViewSchema.nullable(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
