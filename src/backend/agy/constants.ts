export const AgyEventName = {
  init: "init",
  stepUpdate: "step_update",
  result: "result",
} as const;

export const AgyStepType = {
  agentResponse: "agent_response",
  tool: "tool",
  errorMessage: "error_message",
} as const;

export const AgyStepState = {
  active: "ACTIVE",
  done: "DONE",
  error: "ERROR",
} as const;

export const AgyResultStatus = {
  success: "SUCCESS",
  error: "ERROR",
} as const;

export const FINISHED_REASON_INTERRUPTED = "interrupted";

export const AgyToolName = {
  runCommand: "run_command",
  writeFile: "write_file",
  editFile: "edit_file",
  writeToFile: "write_to_file",
  replaceFileContent: "replace_file_content",
  multiReplaceFileContent: "multi_replace_file_content",
  sedFile: "sed_file",
  notebookEdit: "notebook_edit",
  readFile: "read_file",
  viewFile: "view_file",
  listDir: "list_dir",
  grepSearch: "grep_search",
  findByName: "find_by_name",
  readUrlContent: "read_url_content",
  searchWeb: "search_web",
  invokeSubagent: "invoke_subagent",
  defineSubagent: "define_subagent",
  manageSubagents: "manage_subagents",
  schedule: "schedule",
  browserSubagent: "browser_subagent",
  notebookExecution: "notebook_execution",
  sendCommandInput: "send_command_input",
  runWorkflow: "run_workflow",
} as const;

export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  AgyToolName.invokeSubagent,
  AgyToolName.defineSubagent,
  AgyToolName.manageSubagents,
  AgyToolName.schedule,
  AgyToolName.browserSubagent,
]);

export const AgyToolKind = {
  execute: "execute",
  edit: "edit",
  read: "read",
  fetch: "fetch",
} as const;
export type AgyToolKind = (typeof AgyToolKind)[keyof typeof AgyToolKind];

export const TOOL_KIND_BY_NAME: ReadonlyMap<string, AgyToolKind> = new Map([
  [AgyToolName.runCommand, AgyToolKind.execute],
  [AgyToolName.notebookExecution, AgyToolKind.execute],
  [AgyToolName.sendCommandInput, AgyToolKind.execute],
  [AgyToolName.runWorkflow, AgyToolKind.execute],
  [AgyToolName.writeFile, AgyToolKind.edit],
  [AgyToolName.editFile, AgyToolKind.edit],
  [AgyToolName.writeToFile, AgyToolKind.edit],
  [AgyToolName.replaceFileContent, AgyToolKind.edit],
  [AgyToolName.multiReplaceFileContent, AgyToolKind.edit],
  [AgyToolName.sedFile, AgyToolKind.edit],
  [AgyToolName.notebookEdit, AgyToolKind.edit],
  [AgyToolName.readFile, AgyToolKind.read],
  [AgyToolName.viewFile, AgyToolKind.read],
  [AgyToolName.listDir, AgyToolKind.read],
  [AgyToolName.grepSearch, AgyToolKind.read],
  [AgyToolName.findByName, AgyToolKind.read],
  [AgyToolName.readUrlContent, AgyToolKind.fetch],
  [AgyToolName.searchWeb, AgyToolKind.fetch],
]);

export const TOOL_PARAM_COMMAND_LINE = "CommandLine";
export const TOOL_PARAM_PATH = "Path";
export const TOOL_PARAM_PATH_KEYS: readonly string[] = [
  TOOL_PARAM_PATH,
  "TargetFile",
  "AbsolutePath",
];
export const TOOL_PARAM_CWD_KEYS: readonly string[] = [
  "Cwd",
  "WorkingDirectory",
];
export const AGENTS_DIR_NAME = ".agents";
export const AGENTS_DIR_TEAMWORK_SUBDIR = "teamwork";
export const AGENTS_DIR_COMMAND_PATTERN = /(?<![\w.-])\.agents(?![\w.-])/i;
export const AGENTS_DIR_COMMAND_MAX_NESTING = 4;
export const MESSAGE_ID_SEPARATOR = ":";

export const AgyMode = {
  plan: "plan",
} as const;
export type AgyMode = (typeof AgyMode)[keyof typeof AgyMode];

export const AgyToolPermission = {
  alwaysProceed: "always-proceed",
} as const;
export type AgyToolPermission =
  (typeof AgyToolPermission)[keyof typeof AgyToolPermission];

export const AgyFlag = {
  inputFormat: "--input-format",
  outputFormat: "--output-format",
  settings: "--settings",
  mode: "--mode",
  conversation: "--conversation",
  prompt: "-p",
} as const;
export const GEMINI_DIR_FLAG_PREFIX = "--gemini_dir=";
export const AGY_PROFILE_ENV = "CODEWEAVE_AGY_PROFILE";
export const AGY_WORKTREE_ENV = "CODEWEAVE_AGY_WORKTREE";
export const AGY_SNAPSHOT_DIR_ENV = "CODEWEAVE_AGY_SNAPSHOT_DIR";
export const AGY_SNAPSHOT_DIR_PREFIX = "codeweave-agy-snap-";
export const SNAPSHOT_RECORD_SEPARATOR = "~";
export const SNAPSHOT_RECORD_EXTENSION = ".json";
export const SNAPSHOT_CONVERSATION_ID_PATTERN = /^[\w-]+$/;
export const SNAPSHOT_STEP_INDEX_PATTERN = /^\d+$/;

export const HOOK_CONFIG_DIR_NAME = "config";
export const HOOKS_JSON_FILE = "hooks.json";
export const HOOK_WRAPPER_BASENAME = "codeweave-agy-hook";
export const HOOK_WRAPPER_POSIX_EXTENSION = ".sh";
export const HOOK_WRAPPER_WINDOWS_EXTENSION = ".cmd";
export const HOOK_ENTRY_FILE = "agyHook.js";
export const HOOK_GROUP_NAME = "codeweave";
export const HOOK_EVENT_PRE_TOOL_USE = "PreToolUse";
export const HOOK_MATCHER_ALL = ".*";
export const HOOK_COMMAND_TYPE = "command";
export const HOOK_TIMEOUT_SECONDS = 10;

export const AgyHookDecisionKind = {
  allow: "allow",
  deny: "deny",
} as const;
export type AgyHookDecisionKind =
  (typeof AgyHookDecisionKind)[keyof typeof AgyHookDecisionKind];

export const HOOK_NEEDS_APPROVAL_REASON =
  "needs approval; Codeweave cannot ask in agy headless mode";
export const HOOK_SUBAGENT_DENIED_REASON =
  "subagent and scheduling tools are not allowed under this profile";
export const HOOK_AGENTS_DIR_REASON =
  "agy workspace config (.agents) is protected";
export const WORKSPACE_CONFIG_CHANGED_MESSAGE =
  "Gemini workspace config (.agents) changed during this session; review it and start a new session";
export const WORKSPACE_WALK_LIMIT_MESSAGE =
  "Gemini workspace config (.agents) is too large to verify; reduce it or its linked directories";
export const WORKSPACE_WALK_MAX_ENTRIES = 10_000;
export const WORKSPACE_WALK_MAX_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_WALK_MAX_DEPTH = 64;
export const HOOK_INVALID_INPUT_REASON =
  "Codeweave could not read the tool call; denied";
export const HOOK_INVALID_PROFILE_REASON =
  "Codeweave permission profile is missing or unknown; denied";
export const HOOK_INTERNAL_ERROR_REASON =
  "Codeweave policy hook failed; denied";
export const OUTPUT_FORMAT_STREAM_JSON = "stream-json";
export const OUTPUT_FORMAT_JSON = "json";
export const EMPTY_PROMPT_ARG = "-p=";
export const USAGE_COMMAND = "/usage";
export const STDIN_USER_EVENT = "user";
export const STDIN_USER_ROLE = "user";

export const GEMINI_USAGE_GROUP = "Gemini Models";
export const USAGE_WINDOW_FIVE_HOUR = "5h";
export const USAGE_WINDOW_WEEKLY = "weekly";
export const START_PROBE_TIMEOUT_MS = 5000;
export const EXIT_DRAIN_MS = 200;
export const STOP_SETTLE_FACTOR = 2;

export const AGY_ERROR_PREFIX = "AGY_ERROR:";
export const AUTH_REQUIRED_STDERR_PREFIX = "Authentication required";
export const AUTH_FAILED_RESULT_ERROR = "authentication failed or timed out";
export const QUOTA_MARKERS: readonly string[] = [
  "429",
  "resource_exhausted",
  "exhausted your quota",
  "out of quota",
];
export const AUTH_MARKERS: readonly string[] = [
  "authentication",
  "unauthenticated",
];

export const NO_OUTPUT_DENIED_MESSAGE =
  "no output; agy may have denied this command in headless mode";
export const NEEDS_LOGIN_MESSAGE = "Antigravity login required";
export const MODEL_FAILED_MESSAGE = "The model request failed";
export const PROBE_NOT_STOPPED_MESSAGE = "The agy usage probe did not stop";
export const PREVIOUS_PROCESS_NOT_STOPPED_MESSAGE =
  "The previous agy process did not stop";
