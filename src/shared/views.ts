import { z } from "zod";

import {
  API_PROVIDERS,
  ApiAuth,
  ApiProviderId,
  TRAINING_UNKNOWN,
} from "../domain/apiProviders";
import { ATTACHMENT_ID_PATTERN, ImageMimeType } from "../domain/attachments";
import { RestoreAction, RestoreSkipReason } from "../domain/checkpoints";
import { DiffOmission, FileChange } from "../domain/events";
import {
  DecisionReason,
  FlowDecision,
  FlowNodeRunStatus,
  FlowRunStatus,
} from "../domain/flowRun";
import { RouteSource } from "../domain/routing";
import { TaskClass, TaskClassSchema } from "../domain/taskClass";
import { emptyUsageLedger } from "../domain/usageLedger";
import {
  Appearance,
  DefinitionSource,
  EdgeKind,
  EffectLevel,
  FlowPlacement,
  FlowRunOrigin,
  LimitAvailability,
  PermissionProfile,
  ProviderId,
  SlashCommandKind,
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

export const LimitWindowViewSchema = z.strictObject({
  id: z.string(),
  scope: z.string().nullable(),
  period: z.string().nullable(),
  utilization: z.number().nullable(),
  resetsAt: z.number().nullable(),
  exhausted: z.boolean(),
});
export type LimitWindowView = z.infer<typeof LimitWindowViewSchema>;

export const LimitViewSchema = z.strictObject({
  accountId: z.string(),
  status: z.string(),
  resetsAt: z.number().nullable(),
  rateLimitType: z.string().nullable(),
  utilization: z.number().nullable(),
  windows: z.array(LimitWindowViewSchema),
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
  limitAvailability: z.enum(LimitAvailability),
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

export const EditViewSchema = z.strictObject({
  toolCallId: z.string(),
  runId: z.string().nullable(),
  agent: z.string(),
  diff: FileDiffViewSchema,
});
export type EditView = z.infer<typeof EditViewSchema>;

export const EditedFileViewSchema = z.strictObject({
  path: z.string(),
  change: z.enum(FileChange),
  edits: z.array(EditViewSchema),
});
export type EditedFileView = z.infer<typeof EditedFileViewSchema>;

export const SessionEditsViewSchema = z.strictObject({
  sessionId: NonEmptyString,
  files: z.array(EditedFileViewSchema),
});
export type SessionEditsView = z.infer<typeof SessionEditsViewSchema>;

export const RestorePlanFileViewSchema = z.strictObject({
  path: z.string(),
  action: z.enum(RestoreAction),
  skip: z.enum(RestoreSkipReason).nullable(),
});
export type RestorePlanFileView = z.infer<typeof RestorePlanFileViewSchema>;

export const RestorePlanViewSchema = z.strictObject({
  sessionId: NonEmptyString,
  promptSeq: z.int(),
  files: z.array(RestorePlanFileViewSchema),
});
export type RestorePlanView = z.infer<typeof RestorePlanViewSchema>;

export const RestoreReportViewSchema = z.strictObject({
  restored: z.array(z.string()),
  deleted: z.array(z.string()),
  skipped: z.array(
    z.strictObject({ path: z.string(), reason: z.enum(RestoreSkipReason) }),
  ),
});
export type RestoreReportView = z.infer<typeof RestoreReportViewSchema>;

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

export const AttachmentViewSchema = z.strictObject({
  id: z.string().regex(ATTACHMENT_ID_PATTERN),
  name: z.string().min(1).max(255),
  mimeType: z.enum(ImageMimeType),
  bytes: z.int().positive(),
});
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const FileKind = z.enum(["file", "dir"]);
export type FileKind = z.infer<typeof FileKind>;

export const FileCompletionItemSchema = z.strictObject({
  path: z.string(),
  kind: FileKind,
});
export type FileCompletionItem = z.infer<typeof FileCompletionItemSchema>;

export const PromptViewSchema = z.strictObject({
  seq: z.int(),
  text: z.string(),
  attachments: z.array(AttachmentViewSchema).default([]),
});
export type PromptView = z.infer<typeof PromptViewSchema>;

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

export const ContextUsageViewSchema = z.strictObject({
  usedTokens: z.int().nonnegative(),
  limitTokens: z.int().positive().nullable(),
});
export type ContextUsageView = z.infer<typeof ContextUsageViewSchema>;

const TokenCountsViewSchema = z.strictObject({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cacheRead: z.int().nonnegative(),
  cacheWrite: z.int().nonnegative(),
  reasoning: z.int().nonnegative(),
});

const UsageTotalsViewSchema = z.strictObject({
  tokens: TokenCountsViewSchema,
  costs: z.record(z.string(), z.number().nonnegative()),
  tokensReported: z.boolean(),
  costReported: z.boolean(),
});

const UsageReporterViewSchema = z.strictObject({
  tokens: z.boolean(),
  cost: z.boolean(),
});

export const UsageLedgerViewSchema = z.strictObject({
  base: UsageTotalsViewSchema,
  sources: z.record(z.string(), UsageTotalsViewSchema),
  reporters: z
    .partialRecord(z.enum(ProviderId), UsageReporterViewSchema)
    .default({}),
});
export type UsageLedgerView = z.infer<typeof UsageLedgerViewSchema>;

export const SessionViewSchema = z.strictObject({
  id: z.string(),
  createdAt: z.int().nonnegative(),
  cwd: z.string(),
  explicitFolder: z.boolean(),
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
  currentModel: z.string().nullable(),
  contextUsage: ContextUsageViewSchema.nullable(),
  usage: UsageLedgerViewSchema,
  turns: z.array(TurnRouteViewSchema),
  orchestrate: z.boolean(),
  imageInput: z.boolean(),
  canCompact: z.boolean(),
  prompts: z.array(PromptViewSchema),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const RewindResultViewSchema = z.strictObject({
  promptText: z.string(),
  report: RestoreReportViewSchema.nullable(),
  session: SessionViewSchema.nullable(),
});
export type RewindResultView = z.infer<typeof RewindResultViewSchema>;

export const SessionHistoryEntrySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  provider: z.enum(ProviderId),
  orchestrate: z.boolean(),
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
  archived: z.boolean(),
});
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;

export const NativeSessionRefSchema = z.strictObject({
  accountId: z.string(),
  nativeSessionId: z.string(),
});
export type NativeSessionRef = z.infer<typeof NativeSessionRefSchema>;

export const StoredSessionSchema = z.strictObject({
  version: z.int(),
  id: z.string(),
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
  title: z.string(),
  cwd: z.string(),
  explicitFolder: z.boolean(),
  provider: z.enum(ProviderId),
  profile: z.enum(PermissionProfile),
  orchestrate: z.boolean(),
  archived: z.boolean(),
  prompts: z.array(PromptViewSchema),
  messages: z.array(MessageViewSchema),
  toolCalls: z.array(ToolCallViewSchema),
  turns: z.array(TurnRouteViewSchema),
  lastTurn: LastTurnViewSchema.nullable(),
  usage: UsageLedgerViewSchema.default(emptyUsageLedger()),
  nativeSessions: z.array(NativeSessionRefSchema).default([]),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export const AgentViewSchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  source: z.enum(DefinitionSource),
  revision: z.string(),
  role: z.string(),
  provider: z.enum(ProviderId),
  model: z.string().nullable(),
  permissionProfile: z.enum(PermissionProfile),
  taskClass: TaskClassSchema.nullable(),
  body: z.string(),
  usedBy: z.array(
    z.strictObject({
      file: z.string(),
      source: z.enum(DefinitionSource),
      title: z.string(),
    }),
  ),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

export const FlowViewSchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  source: z.enum(DefinitionSource),
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
  source: z.enum(DefinitionSource),
  messages: z.array(z.string()),
});
export type FlowFileError = z.infer<typeof FlowFileErrorSchema>;

export const FlowsListSchema = z.strictObject({
  flows: z.array(FlowViewSchema),
  agents: z.array(AgentViewSchema),
  errors: z.array(FlowFileErrorSchema),
  locations: z.strictObject({
    project: z.string().nullable(),
    library: z.string(),
  }),
});
export type FlowsList = z.infer<typeof FlowsListSchema>;

export const SlashCommandViewSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  kind: z.enum(SlashCommandKind),
  source: z.enum(DefinitionSource),
  file: z.string(),
  body: z.string(),
});
export type SlashCommandView = z.infer<typeof SlashCommandViewSchema>;

export const SlashCommandsListSchema = z.strictObject({
  commands: z.array(SlashCommandViewSchema),
  errors: z.array(FlowFileErrorSchema),
});
export type SlashCommandsList = z.infer<typeof SlashCommandsListSchema>;

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
      model: z.string().nullable(),
    }),
  ),
  decision: z
    .strictObject({
      reason: z.enum(DecisionReason),
      nodeId: z.string(),
    })
    .nullable(),
  decisions: z.array(
    z.strictObject({
      nodeId: z.string(),
      reason: z.enum(DecisionReason),
      decision: z.enum(FlowDecision),
      note: z.string().nullable(),
    }),
  ),
  failure: z.string().nullable(),
  origin: z.enum(FlowRunOrigin),
  placement: z.enum(FlowPlacement),
  branch: z.string().nullable(),
  ownerSessionId: z.string().nullable(),
});
export type FlowRunView = z.infer<typeof FlowRunViewSchema>;

export const SettingsViewSchema = z.strictObject({
  permissionProfile: z.enum(PermissionProfile),
  effectLevel: z.enum(EffectLevel),
  appearance: z.enum(Appearance),
  claudeExecutable: z.string().nullable(),
  codexExecutable: z.string().nullable(),
  agyExecutable: z.string().nullable(),
  opencodeExecutable: z.string().nullable(),
  terminalShell: z.string().nullable(),
  updateCheck: z.boolean(),
  notifications: z.boolean(),
  updateChannel: z.enum(UpdateChannel),
  defaultTaskClass: TaskClassSchema,
  definitionLibrary: z.string().nullable(),
  defaultWorkspace: z.string().nullable(),
  defaultWorkspaceResolved: z.string(),
  recentFolders: z.array(z.string()),
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
  sessions: z.array(SessionViewSchema),
  accounts: z.array(AccountViewSchema),
  settings: SettingsViewSchema,
  switchLog: z.array(SwitchLogEntryViewSchema).max(SWITCH_LOG_SNAPSHOT_LIMIT),
  container: z.strictObject({
    available: z.boolean(),
    message: z.string().nullable(),
  }),
  terminal: TerminalViewSchema.nullable(),
  flowRuns: z.array(FlowRunViewSchema),
  flowSessions: z.array(
    z.strictObject({ runId: NonEmptyString, view: SessionViewSchema }),
  ),
  editedFiles: z.array(SessionEditsViewSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
