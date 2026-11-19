export const CodexMethod = {
  initialize: "initialize",
  initialized: "initialized",
  accountRead: "account/read",
  rateLimitsRead: "account/rateLimits/read",
  threadStart: "thread/start",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
} as const;

export const CodexNotification = {
  turnCompleted: "turn/completed",
  error: "error",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  rateLimitsUpdated: "account/rateLimits/updated",
  modelRerouted: "model/rerouted",
} as const;

export const CodexServerRequest = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
} as const;

export const CodexItemType = {
  agentMessage: "agentMessage",
  commandExecution: "commandExecution",
  fileChange: "fileChange",
  mcpToolCall: "mcpToolCall",
  webSearch: "webSearch",
} as const;

export const CodexItemStatus = {
  inProgress: "inProgress",
  completed: "completed",
  failed: "failed",
  declined: "declined",
} as const;

export const CodexTurnStatus = {
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
} as const;

export const CodexApprovalPolicy = {
  untrusted: "untrusted",
  never: "never",
} as const;
export type CodexApprovalPolicy =
  (typeof CodexApprovalPolicy)[keyof typeof CodexApprovalPolicy];

export const CodexSandboxMode = {
  readOnly: "read-only",
  workspaceWrite: "workspace-write",
  dangerFullAccess: "danger-full-access",
} as const;
export type CodexSandboxMode =
  (typeof CodexSandboxMode)[keyof typeof CodexSandboxMode];

export const CodexSandboxPolicyType = {
  readOnly: "readOnly",
  workspaceWrite: "workspaceWrite",
  dangerFullAccess: "dangerFullAccess",
} as const;

export const CodexDecision = {
  accept: "accept",
  acceptForSession: "acceptForSession",
  decline: "decline",
} as const;

export const CodexPermissionChoice = {
  grant: "grant",
  deny: "deny",
} as const;

export const CodexPermissionScope = {
  turn: "turn",
} as const;

export const CodexErrorInfoName = {
  usageLimitExceeded: "usageLimitExceeded",
  unauthorized: "unauthorized",
} as const;

export const APPROVALS_REVIEWER_USER = "user";
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const RPC_CODE_METHOD_NOT_FOUND = -32601;
export const RPC_CODE_INVALID_PARAMS = -32602;
export const RPC_MESSAGE_METHOD_NOT_FOUND = "Method not found";
export const RPC_MESSAGE_INVALID_PARAMS = "Invalid params";
export const RPC_MESSAGE_PEER_CLOSED = "Codex app-server connection closed";
export const RPC_CODE_PEER_CLOSED = -32099;

export const CLIENT_NAME = "codeweave";
export const CLIENT_TITLE = "Codeweave";
export const CLIENT_VERSION = "0.0.0";
export const APP_SERVER_ARG = "app-server";

export const WINDOWS_CMD_FALLBACK = "cmd.exe";
export const WINDOWS_CMD_ARGS: readonly string[] = ["/d", "/s", "/c"];
export const WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat)$/i;
export const WINDOWS_PLATFORM: NodeJS.Platform = "win32";

export const STOP_REASON_END_TURN = "end_turn";
export const STOP_REASON_CANCELLED = "cancelled";

export const TITLE_RUN_COMMAND = "Run command";
export const TITLE_EDIT_FILES = "Edit files";
export const TITLE_EDIT_PREFIX = "Edit ";
export const TITLE_PERMISSIONS = "Grant permissions";
export const TITLE_SEPARATOR = ", ";
export const MCP_TITLE_SEPARATOR = ".";
export const TURN_FAILED_MESSAGE = "Turn failed";
export const NEEDS_LOGIN_MESSAGE = "Codex login required";

export const OPTION_NAME_ALLOW = "Allow";
export const OPTION_NAME_ALLOW_SESSION = "Allow for session";
export const OPTION_NAME_DECLINE = "Decline";
export const OPTION_NAME_GRANT = "Grant";
export const OPTION_NAME_DENY = "Deny";

export const TOOL_KIND_EXECUTE = "execute";
export const TOOL_KIND_EDIT = "edit";
export const TOOL_KIND_SEARCH = "search";

export const PERCENT_SCALE = 100;
export const RATE_LIMIT_STATUS_ALLOWED = "allowed";
export const WINDOW_MINUTES_FIVE_HOUR = 300;
export const WINDOW_MINUTES_SEVEN_DAY = 10_080;
export const DEFAULT_RATE_LIMIT_READ_TIMEOUT_MS = 5000;
