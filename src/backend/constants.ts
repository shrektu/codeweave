import type { ToolCallStatus } from "../domain/events";

export const SCOPE_UNIT_PREFIX = "codeweave-";
export const SCOPE_UNIT_SUFFIX = ".scope";
export const SCOPE_UNIT_GLOB = `${SCOPE_UNIT_PREFIX}*`;
export const STOP_CONFIRM_TIMEOUT_MS = 5000;
export const EMPTY_POLL_INTERVAL_MS = 50;
export const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const EXEC_TIMEOUT_MS = 30_000;
export const SYSTEMD_CALL_TIMEOUT_MS = 5000;
export const EXEC_KILL_SIGNAL = "SIGKILL";
export const INSTANCE_FILE = "instance.json";
export const INSTANCE_HISTORY_LIMIT = 8;
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_]+$/;
export const SELF_CGROUP_FILE = "/proc/self/cgroup";
export const UNIT_NAME_SEPARATOR = "-";
export const GIT_BINARY = "git";
export const RUN_ID_ENV = "CODEWEAVE_RUN_ID";
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const RUN_MARKER_SEPARATOR = ":";
export const CGROUP_ROOT = "/sys/fs/cgroup";
export const CGROUP_PROCS_FILE = "cgroup.procs";
export const CGROUP_GONE_ERRNO_CODES: readonly string[] = ["ENODEV", "ENOENT"];
export const SYSTEMD_RUN_BINARY = "systemd-run";
export const SYSTEMCTL_BINARY = "systemctl";
export const KILL_SIGNAL_ARG = "--signal=SIGKILL";
export const MARKER_KILL_MAX_ROUNDS = 20;
export const PROC_ROOT = "/proc";
export const PROC_MISSING_ERRNO_CODES: readonly string[] = [
  "EACCES",
  "ENOENT",
  "ESRCH",
  "EPERM",
];

export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
export const CLAUDE_EXECUTABLE_ENV = "CLAUDE_CODE_EXECUTABLE";
export const CLAUDE_DISABLE_CRON_ENV = "CLAUDE_CODE_DISABLE_CRON";
export const CLAUDE_BASH_MAINTAIN_DIR_ENV =
  "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR";
export const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";
export const FLAG_ENABLED = "1";
export const DEFAULT_CLAUDE_DIR_NAME = ".claude";
export const ENV_DENY_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CLAUDECODE",
  "CODEX_",
  "OPENAI_",
  "GEMINI_",
  "ELECTRON_",
];
export const ENV_DENY_EXACT: readonly string[] = [
  "GOOGLE_API_KEY",
  "NODE_OPTIONS",
];

export const CLAUDE_RATE_LIMIT_META_KEY = "_claude/rateLimit";
export const UNKNOWN_RATE_LIMIT_STATUS = "unknown";
export const DEFAULT_TOOL_KIND = "other";
export const DEFAULT_TOOL_STATUS: ToolCallStatus = "pending";
export const TOOL_OUTPUT_SEPARATOR = "\n";
export const MODE_BYPASS = "bypassPermissions";
export const MODE_DEFAULT = "default";
export const STDERR_TAIL_CHARS = 4096;
export const PROCESS_EXITED_MESSAGE = "Agent process exited";
export const DEFAULT_STOP_GRACE_MS = 3000;
export const LAUNCHER_SCRIPT = `delete process.env.${ELECTRON_RUN_AS_NODE_ENV};import(require("node:url").pathToFileURL(process.argv[1]).href)`;
export const ASAR_SEGMENT_PATTERN = /app\.asar(?=[\\/])/;
export const ASAR_UNPACKED_SEGMENT = "app.asar.unpacked";
export const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_ACP_ENTRY = "dist/index.js";

export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
export const WINDOWS_PATH_DELIMITER = ";";

export const ACCOUNTS_FILE = "accounts.json";
export const SETTINGS_FILE = "settings.json";
export const SWITCH_LOG_FILE = "switch-log.jsonl";
export const ACCOUNTS_DIR_NAME = "accounts";
export const STORAGE_VERSION = 1;
export const TEMP_FILE_SUFFIX = ".tmp";

export const AGENT_STOP_GRACE_MS = 5000;
export const CONTAINER_UNAVAILABLE_MESSAGE =
  "Process container is not available";
export const CLAUDE_BINARY = "claude";
export const SESSION_CLOSED_MESSAGE = "The session is closed";
export const FILE_URL_PREFIX = "file://";
export const ACP_KINDS_READ: readonly string[] = ["read", "search"];
export const ACP_KINDS_EDIT: readonly string[] = ["edit", "delete", "move"];
export const ACP_KINDS_EXECUTE: readonly string[] = ["execute"];
export const OPTION_KIND_ALLOW_ONCE = "allow_once";
export const OPTION_KIND_REJECT_ONCE = "reject_once";
export const OPTION_KIND_ALLOW_ALWAYS = "allow_always";
export const CODEX_HOME_ENV = "CODEX_HOME";
