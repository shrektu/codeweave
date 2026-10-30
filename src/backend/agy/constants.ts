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
} as const;

export const AgyToolKind = {
  execute: "execute",
  edit: "edit",
  read: "read",
  fetch: "fetch",
} as const;
export type AgyToolKind = (typeof AgyToolKind)[keyof typeof AgyToolKind];

export const TOOL_KIND_BY_NAME: ReadonlyMap<string, AgyToolKind> = new Map([
  [AgyToolName.runCommand, AgyToolKind.execute],
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
export const MESSAGE_ID_SEPARATOR = ":";

export const AgyMode = {
  plan: "plan",
  acceptEdits: "accept-edits",
} as const;
export type AgyMode = (typeof AgyMode)[keyof typeof AgyMode];

export const AgyToolPermission = {
  alwaysProceed: "always-proceed",
  requestReview: "request-review",
} as const;
export type AgyToolPermission =
  (typeof AgyToolPermission)[keyof typeof AgyToolPermission];

export const RM_COMMAND = "rm";
export const RM_DANGER_FLAGS: readonly string[] = [
  "-r",
  "-R",
  "-f",
  "-rf",
  "-fr",
  "-Rf",
  "-fR",
  "--recursive",
  "--force",
];
export const GIT_PUSH_TOKENS: readonly string[] = ["git", "push"];
export const GIT_PUSH_FORCE_FLAGS: readonly string[] = [
  "--force",
  "-f",
  "--force-with-lease",
];
export const GIT_REMOTE_ORIGIN = "origin";
export const WRITE_FILE_DENY_RULE = "write_file(*)";

export const AgyFlag = {
  inputFormat: "--input-format",
  outputFormat: "--output-format",
  settings: "--settings",
  mode: "--mode",
  conversation: "--conversation",
  prompt: "-p",
} as const;
export const OUTPUT_FORMAT_STREAM_JSON = "stream-json";
export const OUTPUT_FORMAT_JSON = "json";
export const EMPTY_PROMPT_ARG = "-p=";
export const USAGE_COMMAND = "/usage";
export const STDIN_USER_EVENT = "user";
export const STDIN_USER_ROLE = "user";
export const AGY_DISABLE_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

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
