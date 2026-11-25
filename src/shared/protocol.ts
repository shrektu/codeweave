import { z } from "zod";

import { ApiAuth } from "../domain/apiProviders";
import { MIN_SECRET_LENGTH } from "../domain/constants";
import { FlowDecision } from "../domain/flowRun";
import { AgentSchema, FlowSchema } from "../domain/flows";
import { TaskClassSchema } from "../domain/taskClass";
import {
  Appearance,
  DefinitionSource,
  EffectLevel,
  PermissionProfile,
  ProviderId,
  UpdateChannel,
} from "../domain/types";

import {
  CONNECT_MESSAGE_TYPE,
  SHUTDOWN_DONE_MESSAGE_TYPE,
  SHUTDOWN_MESSAGE_TYPE,
  TERMINAL_INPUT_MAX_CHARS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "./constants";
import { VaultStatusSchema } from "./vault";
import {
  AccountViewSchema,
  ApiAccountSchema,
  FlowRefSchema,
  FlowRunViewSchema,
  FlowsListSchema,
  ModelCatalogSchema,
  SessionEditsViewSchema,
  SessionHistoryEntrySchema,
  SessionViewSchema,
  SettingsViewSchema,
  SnapshotSchema,
  StoredSessionSchema,
  SwitchLogEntryViewSchema,
  TerminalViewSchema,
} from "./views";

export const PROJECT_FOLDER_REQUIRED_MESSAGE =
  "A project folder is required for project definitions";

const PROJECT_FOLDER_CHECK_OPTIONS = {
  message: PROJECT_FOLDER_REQUIRED_MESSAGE,
  path: ["cwd"],
};

function hasRequiredProjectFolder(value: {
  readonly source?: DefinitionSource | undefined;
  readonly cwd?: string | undefined;
}): boolean {
  return value.source !== DefinitionSource.project || value.cwd !== undefined;
}

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
const SessionIdParamsSchema = z.strictObject({ sessionId: NonEmptyString });
const PERMISSION_TARGET_MESSAGE = "Specify exactly one of sessionId or runId";
const ApiKeySchema = z.string().min(MIN_SECRET_LENGTH);
export const API_KEY_REQUIRED_MESSAGE = "API key is required";
export const CONSOLE_LOGIN_WITH_KEY_MESSAGE =
  "A Console login account takes no API key";
const TerminalColsSchema = z
  .int()
  .min(TERMINAL_MIN_COLS)
  .max(TERMINAL_MAX_COLS);
const TerminalRowsSchema = z
  .int()
  .min(TERMINAL_MIN_ROWS)
  .max(TERMINAL_MAX_ROWS);
const TerminalIdParamsSchema = z.strictObject({ id: NonEmptyString });
const OkResultSchema = z.strictObject({ ok: z.literal(true) });

const ModelChoiceSchema = z.strictObject({
  provider: z.enum(ProviderId),
  model: NonBlankString,
});

const SettingsPatchSchema = z
  .strictObject({
    permissionProfile: z.enum(PermissionProfile).optional(),
    effectLevel: z.enum(EffectLevel).optional(),
    appearance: z.enum(Appearance).optional(),
    claudeExecutable: z.string().nullable().optional(),
    codexExecutable: z.string().nullable().optional(),
    agyExecutable: z.string().nullable().optional(),
    opencodeExecutable: z.string().nullable().optional(),
    terminalShell: z.string().nullable().optional(),
    updateCheck: z.boolean().optional(),
    updateChannel: z.enum(UpdateChannel).optional(),
    defaultTaskClass: TaskClassSchema.optional(),
    definitionLibrary: z.string().nullable().optional(),
    defaultWorkspace: z.string().nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined));

export const ParamsSchemas = {
  ping: EmptyParamsSchema,
  "sessions/snapshot": EmptyParamsSchema,
  "session/start": z.strictObject({
    cwd: NonEmptyString.optional(),
    profile: z.enum(PermissionProfile).optional(),
    flowRef: FlowRefSchema.optional(),
    provider: z.enum(ProviderId).optional(),
    model: ModelChoiceSchema.optional(),
    taskClass: TaskClassSchema.optional(),
    orchestrate: z.boolean().optional(),
  }),
  "session/prompt": z.strictObject({
    sessionId: NonEmptyString,
    text: NonBlankString,
    taskClass: TaskClassSchema.optional(),
    model: ModelChoiceSchema.optional(),
  }),
  "session/stop": SessionIdParamsSchema,
  "session/close": SessionIdParamsSchema,
  "session/resume": z.strictObject({ sessionId: z.uuid() }),
  "history/list": EmptyParamsSchema,
  "history/get": z.strictObject({ sessionId: z.uuid() }),
  "history/archive": z.strictObject({
    sessionId: z.uuid(),
    archived: z.boolean(),
  }),
  "permission/answer": z
    .strictObject({
      requestId: NonEmptyString,
      optionId: NonEmptyString,
      sessionId: NonEmptyString.optional(),
      runId: NonEmptyString.optional(),
    })
    .refine(
      ({ sessionId, runId }) =>
        (sessionId === undefined) !== (runId === undefined),
      { message: PERMISSION_TARGET_MESSAGE },
    ),
  "accounts/list": EmptyParamsSchema,
  "accounts/suggest": EmptyParamsSchema,
  "accounts/add": z.discriminatedUnion("provider", [
    z.strictObject({
      label: NonBlankString,
      configDir: NonEmptyString,
      provider: z
        .enum([ProviderId.claude, ProviderId.codex, ProviderId.gemini])
        .optional(),
    }),
    z
      .strictObject({
        label: NonBlankString,
        configDir: NonEmptyString,
        provider: z.literal(ProviderId.opencode),
        api: ApiAccountSchema,
        apiKey: ApiKeySchema.optional(),
      })
      .refine(
        ({ api, apiKey }) =>
          api.auth !== ApiAuth.apiKey || apiKey !== undefined,
        { message: API_KEY_REQUIRED_MESSAGE, path: ["apiKey"] },
      )
      .refine(
        ({ api, apiKey }) =>
          api.auth !== ApiAuth.consoleLogin || apiKey === undefined,
        { message: CONSOLE_LOGIN_WITH_KEY_MESSAGE, path: ["apiKey"] },
      ),
  ]),
  "accounts/setKey": z.strictObject({
    id: NonEmptyString,
    apiKey: ApiKeySchema,
  }),
  "vault/status": EmptyParamsSchema,
  "models/catalog": EmptyParamsSchema,
  "accounts/remove": z.strictObject({ id: z.string() }),
  "accounts/move": z.strictObject({
    id: z.string(),
    direction: z.enum(["up", "down"]),
  }),
  "settings/get": EmptyParamsSchema,
  "settings/set": SettingsPatchSchema,
  "switchLog/list": EmptyParamsSchema,
  "flows/list": z.strictObject({ cwd: NonEmptyString.optional() }),
  "flows/save": z
    .strictObject({
      cwd: NonEmptyString.optional(),
      source: z.enum(DefinitionSource),
      file: NonEmptyString,
      revision: NonEmptyString,
      flow: FlowSchema,
    })
    .refine(hasRequiredProjectFolder, PROJECT_FOLDER_CHECK_OPTIONS),
  "agents/create": z
    .strictObject({
      cwd: NonEmptyString.optional(),
      source: z.enum(DefinitionSource).optional(),
      agent: AgentSchema,
      body: z.string(),
    })
    .refine(hasRequiredProjectFolder, PROJECT_FOLDER_CHECK_OPTIONS),
  "agents/save": z
    .strictObject({
      cwd: NonEmptyString.optional(),
      source: z.enum(DefinitionSource),
      file: NonEmptyString,
      revision: NonEmptyString,
      id: NonEmptyString,
      agent: AgentSchema,
      body: z.string(),
    })
    .refine(hasRequiredProjectFolder, PROJECT_FOLDER_CHECK_OPTIONS),
  "agents/delete": z
    .strictObject({
      cwd: NonEmptyString.optional(),
      source: z.enum(DefinitionSource),
      file: NonEmptyString,
      revision: NonEmptyString,
      id: NonEmptyString,
    })
    .refine(hasRequiredProjectFolder, PROJECT_FOLDER_CHECK_OPTIONS),
  "flow/start": z.strictObject({
    cwd: NonEmptyString,
    flowId: NonEmptyString,
    task: NonBlankString,
  }),
  "flow/stop": z.strictObject({ runId: NonEmptyString }),
  "flow/decide": z.strictObject({
    runId: NonEmptyString,
    decision: z.enum(FlowDecision),
  }),
  "terminal/open": z.strictObject({
    cwd: NonEmptyString,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
  }),
  "terminal/input": z.strictObject({
    id: NonEmptyString,
    data: z.string().min(1).max(TERMINAL_INPUT_MAX_CHARS),
  }),
  "terminal/resize": z.strictObject({
    id: NonEmptyString,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
  }),
  "terminal/ack": z.strictObject({
    id: NonEmptyString,
    chars: z.int().min(1),
  }),
  "terminal/detach": TerminalIdParamsSchema,
  "terminal/close": TerminalIdParamsSchema,
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
  requestSchema("session/close"),
  requestSchema("session/resume"),
  requestSchema("history/list"),
  requestSchema("history/get"),
  requestSchema("history/archive"),
  requestSchema("permission/answer"),
  requestSchema("accounts/list"),
  requestSchema("accounts/suggest"),
  requestSchema("accounts/add"),
  requestSchema("accounts/setKey"),
  requestSchema("accounts/remove"),
  requestSchema("accounts/move"),
  requestSchema("settings/get"),
  requestSchema("settings/set"),
  requestSchema("switchLog/list"),
  requestSchema("flows/list"),
  requestSchema("flows/save"),
  requestSchema("agents/create"),
  requestSchema("agents/save"),
  requestSchema("agents/delete"),
  requestSchema("flow/start"),
  requestSchema("flow/stop"),
  requestSchema("flow/decide"),
  requestSchema("vault/status"),
  requestSchema("models/catalog"),
  requestSchema("terminal/open"),
  requestSchema("terminal/input"),
  requestSchema("terminal/resize"),
  requestSchema("terminal/ack"),
  requestSchema("terminal/detach"),
  requestSchema("terminal/close"),
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
  "session/close": z.strictObject({ closed: z.literal(true) }),
  "session/resume": SessionViewSchema,
  "history/list": z.strictObject({
    entries: z.array(SessionHistoryEntrySchema),
  }),
  "history/get": StoredSessionSchema,
  "history/archive": SessionHistoryEntrySchema,
  "permission/answer": z.strictObject({ ok: z.literal(true) }),
  "accounts/list": AccountsResultSchema,
  "accounts/suggest": z.strictObject({ configDir: z.string() }),
  "accounts/add": z.strictObject({ account: AccountViewSchema }),
  "accounts/setKey": AccountViewSchema,
  "accounts/remove": AccountsResultSchema,
  "accounts/move": AccountsResultSchema,
  "settings/get": SettingsViewSchema,
  "settings/set": SettingsViewSchema,
  "switchLog/list": z.strictObject({
    entries: z.array(SwitchLogEntryViewSchema),
  }),
  "flows/list": FlowsListSchema,
  "flows/save": FlowsListSchema,
  "agents/create": FlowsListSchema,
  "agents/save": FlowsListSchema,
  "agents/delete": FlowsListSchema,
  "flow/start": FlowRunViewSchema,
  "flow/stop": z.strictObject({ stopped: z.boolean() }),
  "flow/decide": FlowRunViewSchema,
  "vault/status": VaultStatusSchema,
  "models/catalog": ModelCatalogSchema,
  "terminal/open": z.strictObject({
    terminal: TerminalViewSchema,
    replay: z.string(),
  }),
  "terminal/input": OkResultSchema,
  "terminal/resize": OkResultSchema,
  "terminal/ack": OkResultSchema,
  "terminal/detach": OkResultSchema,
  "terminal/close": z.strictObject({ closed: z.boolean() }),
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
    event: z.literal("session/removed"),
    payload: z.strictObject({ sessionId: z.string() }),
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("history/changed"),
    payload: SessionHistoryEntrySchema,
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
  z.strictObject({
    v: z.int(),
    event: z.literal("flow/changed"),
    payload: FlowRunViewSchema,
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("flowSession/changed"),
    payload: z.strictObject({
      runId: NonEmptyString,
      view: SessionViewSchema.nullable(),
    }),
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("editedFiles/changed"),
    payload: SessionEditsViewSchema,
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("terminal/data"),
    payload: z.strictObject({ id: NonEmptyString, data: z.string() }),
  }),
  z.strictObject({
    v: z.int(),
    event: z.literal("terminal/changed"),
    payload: TerminalViewSchema.nullable(),
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
