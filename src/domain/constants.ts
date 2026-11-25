export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;

export const DEFAULT_COOLDOWN_MINUTES = 60;
export const DEFAULT_COOLDOWN_SECONDS =
  DEFAULT_COOLDOWN_MINUTES * SECONDS_PER_MINUTE;

export const EPOCH_MILLIS_THRESHOLD = 100_000_000_000;

export const DEFAULT_MAX_RESULT_CHARS = 2000;
export const DEFAULT_HANDOFF_CHARS = 16_000;
export const SESSION_TITLE_MAX_CHARS = 80;

export const MAX_PARALLEL_FLOWS = 3;
export const RETAINED_FLOW_RUNS = 20;
export const FLOW_TOOL_SERVER_NAME = "codeweave";

export const MIN_FLOW_ROUNDS = 1;
export const MAX_FLOW_ROUNDS = 10;
export const DEFAULT_FLOW_ROUNDS = 2;

export const ERROR_KIND_RATE_LIMIT = "rate_limit";
export const ERROR_KIND_AUTH_REQUIRED = "auth_required";
export const RPC_CODE_AUTH_REJECTED = -32000;
export const RATE_LIMIT_STATUS_REJECTED = "rejected";
export const RATE_LIMIT_TYPE_FIVE_HOUR = "five_hour";
export const RATE_LIMIT_TYPE_SEVEN_DAY = "seven_day";

export const SIDE_EFFECT_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b/,
  /\bmigrat(?:e|ions?)\b/i,
  /\b(?:curl|wget)\b/,
  /\bhttps?:/,
  /\b(?:npm|pnpm)\s+publish\b/,
  /\bdeploy\b/i,
  /\brm\s+-(?:rf|fr)\b/,
  /\bkubectl\b/,
  /\bterraform\s+apply\b/,
];

export const OLD_PROCESS_STILL_RUNNING = "old process still running";
export const PORT_CALL_FAILED = "port call failed";
export const UNKNOWN_ERROR = "unknown error";
export const MIN_SECRET_LENGTH = 8;
export const SECRET_HINT_LENGTH = 4;
export const NO_MESSAGE_KEY = "";
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const MODEL_AUTO = "auto";
export const FLOW_TOOL_PAGE_CHARS = 20_000;
export const FLOW_DECISION_NOTE_CHARS = 1000;
export const FLOW_REPOSITORY_PATH_MAX_CHARS = 4096;
export const FLOW_TOOL_SERVER_VERSION = "1.0.0";
export const FLOW_TOOL_PATH = "/mcp";
export const FLOW_TOOL_MAX_BODY_BYTES = 1024 * 1024;
export const FLOW_TOOL_BIND_HOST = "127.0.0.1";
export const FLOW_TOOL_ALIAS_HOST = "localhost";
export const FLOW_TOOL_TOKEN_BYTES = 32;
export const ORCHESTRATOR_WAKEUP_PREFIX = "[Codeweave]";
export const ORCHESTRATOR_MAX_FIX_ROUNDS = 2;
export const SYNTHETIC_MODEL_NAME = "<synthetic>";
