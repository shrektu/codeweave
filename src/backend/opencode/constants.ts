export const OpencodePath = {
  config: "/config",
  providers: "/config/providers",
  session: "/session",
  sessionStatus: "/session/status",
  message: "message",
  event: "/event",
  promptAsync: "prompt_async",
  abort: "abort",
  permissions: "permissions",
} as const;

export const OpencodeEventType = {
  partUpdated: "message.part.updated",
  permissionAsked: "permission.asked",
  sessionStatus: "session.status",
  sessionIdle: "session.idle",
  sessionError: "session.error",
  messageUpdated: "message.updated",
  sessionCreated: "session.created",
  sessionUpdated: "session.updated",
} as const;

export const OpencodeRole = {
  user: "user",
  assistant: "assistant",
} as const;

export const OpencodePartType = {
  text: "text",
  tool: "tool",
} as const;

export const OpencodeStatusType = {
  busy: "busy",
  idle: "idle",
  retry: "retry",
} as const;

export const OpencodeToolStatus = {
  pending: "pending",
  running: "running",
  completed: "completed",
  error: "error",
} as const;

export const OpencodePermissionResponse = {
  once: "once",
  always: "always",
  reject: "reject",
} as const;
export type OpencodePermissionResponse =
  (typeof OpencodePermissionResponse)[keyof typeof OpencodePermissionResponse];

export const OpencodeAgent = {
  build: "build",
  plan: "plan",
} as const;
export type OpencodeAgent = (typeof OpencodeAgent)[keyof typeof OpencodeAgent];

export const OpencodeErrorName = {
  aborted: "MessageAbortedError",
} as const;

export const OpencodeEnv = {
  home: "HOME",
  configHome: "XDG_CONFIG_HOME",
  dataHome: "XDG_DATA_HOME",
  cacheHome: "XDG_CACHE_HOME",
  stateHome: "XDG_STATE_HOME",
  config: "OPENCODE_CONFIG",
  serverPassword: "OPENCODE_SERVER_PASSWORD",
  password: "OPENCODE_PASSWORD",
} as const;

export const OPENCODE_ISOLATION_FLAGS: readonly string[] = [
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
];

export const ACCOUNT_HOME_DIR = "home";
export const ACCOUNT_CONFIG_DIR = "config";
export const ACCOUNT_DATA_DIR = "data";
export const ACCOUNT_CACHE_DIR = "cache";
export const ACCOUNT_STATE_DIR = "state";

export const SERVE_ARG = "serve";
export const HOSTNAME_ARG = "--hostname";
export const PORT_ARG = "--port";
export const PURE_ARG = "--pure";
export const LOOPBACK_HOST = "127.0.0.1";

export const SERVER_USERNAME = "opencode";
export const LISTENING_MARKER = "server listening on ";
export const READY_TIMEOUT_MS = 15_000;
export const LONG_RETRY_THRESHOLD_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const WARM_UP_TIMEOUT_MS = 60_000;
export const STALE_GATE_GRACE_MS = 3000;

export const QUERY_DIRECTORY = "directory";
export const QUERY_LIMIT = "limit";
export const LATEST_MESSAGE_LIMIT = "1";
export const CONTENT_TYPE_JSON = "application/json";
export const ACCEPT_EVENT_STREAM = "text/event-stream";

export const OPENAI_COMPATIBLE_PACKAGE = "@ai-sdk/openai-compatible";
export const PERMISSION_ASK = "ask";
export const SHARE_DISABLED = "disabled";
export const FILE_REFERENCE_PREFIX = "{file:";
export const FILE_REFERENCE_SUFFIX = "}";
export const RUN_DIR_PREFIX = "codeweave-opencode-";
export const KEY_FILE_NAME = "api-key";
export const CONFIG_FILE_NAME = "opencode.json";
export const RUN_DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;
export const XDG_RUNTIME_DIR_ENV = "XDG_RUNTIME_DIR";

export const REDACTED = "[redacted]";
export const TURN_FAILED_MESSAGE = "Turn failed";
export const STREAM_CLOSED_MESSAGE = "Event stream closed";
export const SESSION_BUSY_MESSAGE = "OpenCode session is still busy";
export const NEEDS_LOGIN_MESSAGE = "OpenCode API key is missing";
export const READY_TIMEOUT_MESSAGE = "opencode server did not start in time";

export const TITLE_RUN_COMMAND = "Run command";
export const TITLE_EDIT_FILE = "Edit file";
export const TITLE_FETCH_URL = "Fetch URL";
export const OPTION_NAME_ALLOW_ONCE = "Allow once";
export const OPTION_NAME_ALLOW_ALWAYS = "Always allow";
export const OPTION_NAME_REJECT = "Reject";

export const TOOL_KIND_EXECUTE = "execute";
export const TOOL_KIND_EDIT = "edit";
export const TOOL_KIND_READ = "read";
export const TOOL_KIND_SEARCH = "search";
export const TOOL_KIND_FETCH = "fetch";

export const VERSION_ARG = "--version";
export const VERSION_PROBE_TIMEOUT_MS = 10_000;
export const SUPPORTED_MAJOR_VERSION = 1;
export const VERSION_PATTERN = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)/;
export const VERSION_SUPPORT_HINT =
  "Codeweave works with opencode 1.19.x (npm i -g opencode-ai@1.19.5).";
export const VERSION_UNKNOWN_MESSAGE =
  "The OpenCode version could not be determined.";

export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;

export const OpencodeGeneration = { v1: "v1", v2: "v2" } as const;
export type OpencodeGeneration =
  (typeof OpencodeGeneration)[keyof typeof OpencodeGeneration];
