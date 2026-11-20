import { posix } from "node:path";

import { PROVIDER_KEY_ENV_NAMES } from "../domain/apiProviders";
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
export const JOB_PID_LIST_INITIAL_CAPACITY = 64;
export const JOB_PID_LIST_MAX_CAPACITY = 65_536;
export const JOB_ASSIGN_EXIT_GRACE_MS = 250;
export const SYSTEMCTL_BINARY = "systemctl";
export const KILL_SIGNAL_ARG = "--signal=SIGKILL";
export const MARKER_KILL_MAX_ROUNDS = 20;
export const PS_BINARY = "ps";
export const PS_TABLE_ARGS = [
  "axeww",
  "-o",
  "pid=,ppid=,lstart=,command=",
] as const;
export const PS_ENV: Readonly<Record<string, string>> = { LC_ALL: "C" };
export const PS_CALL_TIMEOUT_MS = 5000;
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
  "OPENCODE_",
  "AGY_",
  "ANTIGRAVITY_",
];
export const ENV_DENY_EXACT: readonly string[] = [
  "NODE_OPTIONS",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  ...PROVIDER_KEY_ENV_NAMES,
];

export const CLAUDE_RATE_LIMIT_META_KEY = "_claude/rateLimit";
export const UNKNOWN_RATE_LIMIT_STATUS = "unknown";
export const DEFAULT_TOOL_KIND = "other";
export const DEFAULT_TOOL_STATUS: ToolCallStatus = "pending";
export const TOOL_OUTPUT_SEPARATOR = "\n";
export const MODE_BYPASS = "bypassPermissions";
export const MODE_DEFAULT = "default";
export const MODEL_CONFIG_ID = "model";
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
export const API_KEYS_FILE = "api-keys.json";
export const KEY_STORE_FILE_MODE = 0o600;
export const VAULT_CRYPTO_TIMEOUT_MS = 120_000;
export const KEY_DECRYPT_RETRY_INTERVAL_MS = 5000;
export const STORAGE_VERSION = 1;
export const TEMP_FILE_SUFFIX = ".tmp";

export const AGENT_STOP_GRACE_MS = 5000;
export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_RUN_ID_PREFIX = "probe-";
export const CONTAINER_UNAVAILABLE_MESSAGE =
  "Process container is not available";
export const CLAUDE_BINARY = "claude";
export const CODEX_BINARY = "codex";
export const AGY_BINARY = "agy";
export const CODEX_CONFIG_FILE_NAME = "config.toml";
export const CODEX_FILE_CREDENTIAL_STORE_CONFIG =
  'cli_auth_credentials_store = "file"\n';
export const SESSION_CLOSED_MESSAGE = "The session is closed";
export const SESSION_START_STOPPED_MESSAGE =
  "The session was stopped before it started";
export const FILE_URL_PREFIX = "file://";
export const ACP_KINDS_READ: readonly string[] = ["read", "search"];
export const ACP_KINDS_EDIT: readonly string[] = ["edit", "delete", "move"];
export const ACP_KINDS_EXECUTE: readonly string[] = ["execute"];
export const OPTION_KIND_ALLOW_ONCE = "allow_once";
export const OPTION_KIND_REJECT_ONCE = "reject_once";
export const OPTION_KIND_ALLOW_ALWAYS = "allow_always";
export const CODEX_HOME_ENV = "CODEX_HOME";
export const TERMINAL_REPLAY_MAX_CHARS = 262_144;
export const TERMINAL_HIGH_WATERMARK_CHARS = 524_288;
export const TERMINAL_LOW_WATERMARK_CHARS = 131_072;
export const TERMINAL_FLUSH_MS = 16;
export const TERMINAL_FLUSH_MAX_CHARS = 65_536;
export const TERMINAL_STOP_GRACE_MS = 1000;
export const TERMINAL_TYPE = "xterm-256color";
export const TERMINAL_COLOR_TERM = "truecolor";
export const TERMINAL_PROGRAM = "Codeweave";
export const TERMINAL_STOP_SIGNAL = "SIGHUP";
export const TERMINAL_KILL_SIGNAL = "SIGKILL";
export const POSIX_SHELL_FALLBACKS: readonly string[] = [
  "/bin/bash",
  "/bin/zsh",
  "/bin/sh",
];
export const POWERSHELL_CORE_BINARY = "pwsh.exe";
export const WINDOWS_POWERSHELL_RELATIVE_PATH =
  "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";
export const WINDOWS_COMMAND_INTERPRETER = "cmd.exe";
export const POWERSHELL_NAME_PATTERN = /^(pwsh|powershell)(\.exe)?$/i;
export const POWERSHELL_ARGS: readonly string[] = ["-NoLogo"];
export const LOGIN_SHELL_ARGS: readonly string[] = ["-l"];
export const DIFF_MAX_FILE_BYTES = 1024 * 1024;
export const DIFF_MAX_PATCH_CHARS = 64_000;
export const DIFF_CONTEXT_LINES = 3;
export const DIFF_TIMEOUT_MS = 500;
export const DIFF_MAX_EDIT_LENGTH = 20_000;
export const ABSENT_PROCESS_ERRNO_CODE = "ESRCH";
export const LOGIN_SHELL_PATH_ARGS: readonly string[] = ["-ilc"];
export const LOGIN_SHELL_PATH_MARKER = "__CODEWEAVE_PATH__";
export const LOGIN_SHELL_PATH_COMMAND =
  "printf '__CODEWEAVE_%s__%s__CODEWEAVE_%s__' PATH \"$PATH\" PATH";
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 3000;
export const USER_BIN_DIRS: readonly string[] = [
  ".local/bin",
  ".opencode/bin",
  ".cargo/bin",
  ".bun/bin",
  ".npm-global/bin",
  ".volta/bin",
];
export const LINUX_USER_BIN_DIRS: readonly string[] = [
  ".local/share/pnpm",
  ".local/share/fnm/aliases/default/bin",
];
export const LINUXBREW_ACCOUNT_DIR = "/home/linuxbrew";
export const LINUX_SYSTEM_BIN_DIRS: readonly string[] = [
  posix.join(LINUXBREW_ACCOUNT_DIR, ".linuxbrew", "bin"),
];
export const MACOS_USER_BIN_DIRS: readonly string[] = [
  "Library/pnpm",
  "Library/Application Support/fnm/aliases/default/bin",
];
export const MACOS_SYSTEM_BIN_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
];
export const ENABLE_TOOL_SEARCH_ENV = "ENABLE_TOOL_SEARCH";
export const FLAG_DISABLED = "false";
export const MCP_HTTP_SERVER_TYPE = "http";
export const MCP_TOOL_NAME_PREFIX = "mcp__";
export const MCP_TOOL_NAME_SEPARATOR = "__";
export const AUTHORIZATION_HEADER = "Authorization";
export const BEARER_SCHEME = "Bearer";
