import {
  TOOL_KIND_EDIT,
  TOOL_KIND_EXECUTE,
  TOOL_KIND_FETCH,
  TOOL_KIND_READ,
  TOOL_KIND_SEARCH,
} from "../constants";

export const OpencodeV2Path = {
  provider: "/api/provider",
  session: "/api/session",
  activeSessions: "/api/session/active",
  event: "/api/event",
  prompt: "prompt",
  interrupt: "interrupt",
  permission: "permission",
  reply: "reply",
  agent: "agent",
  model: "model",
} as const;

export const QUERY_LOCATION_DIRECTORY = "location[directory]";

export const OpencodeV2EventType = {
  serverConnected: "server.connected",
  sessionCreated: "session.created",
  executionStarted: "session.execution.started",
  executionSucceeded: "session.execution.succeeded",
  executionFailed: "session.execution.failed",
  executionInterrupted: "session.execution.interrupted",
  stepStarted: "session.step.started",
  textDelta: "session.text.delta",
  textEnded: "session.text.ended",
  toolInputStarted: "session.tool.input.started",
  toolCalled: "session.tool.called",
  toolProgress: "session.tool.progress",
  toolSuccess: "session.tool.success",
  toolFailed: "session.tool.failed",
  retryScheduled: "session.retry.scheduled",
  permissionAsked: "permission.asked",
} as const;

export const OpencodeV2ErrorType = {
  aborted: "aborted",
  auth: "provider.auth",
  rateLimit: "provider.rate-limit",
  goLimit: "provider.go-limit",
  quota: "provider.quota",
  freeLimit: "provider.free-limit",
  budgetLimit: "provider.budget-limit",
  modelBudgetLimit: "provider.model-budget-limit",
  chatgptLimit: "provider.chatgpt-limit",
} as const;

export const RATE_LIMIT_ERROR_TYPES: readonly string[] = [
  OpencodeV2ErrorType.rateLimit,
  OpencodeV2ErrorType.goLimit,
  OpencodeV2ErrorType.quota,
  OpencodeV2ErrorType.freeLimit,
  OpencodeV2ErrorType.budgetLimit,
  OpencodeV2ErrorType.modelBudgetLimit,
  OpencodeV2ErrorType.chatgptLimit,
];

export const OpencodeV2Action = {
  shell: "shell",
  edit: "edit",
  webfetch: "webfetch",
  externalDirectory: "external_directory",
} as const;

export const OpencodeV2Effect = {
  ask: "ask",
  allow: "allow",
  deny: "deny",
} as const;
export type OpencodeV2Effect =
  (typeof OpencodeV2Effect)[keyof typeof OpencodeV2Effect];

export const UPDATE_DISABLED = "disable";
export const POLICY_PROVIDER_USE = "provider.use";
export const RESOURCE_WILDCARD = "*";

export const TEXT_CONTENT_TYPE = "text";
export const DEFAULT_TOOL_TITLE = "tool";
export const MESSAGE_ORDINAL_SEPARATOR = ":";

export const V2_TOOL_KINDS: Readonly<Record<string, string>> = {
  shell: TOOL_KIND_EXECUTE,
  edit: TOOL_KIND_EDIT,
  write: TOOL_KIND_EDIT,
  patch: TOOL_KIND_EDIT,
  read: TOOL_KIND_READ,
  glob: TOOL_KIND_SEARCH,
  grep: TOOL_KIND_SEARCH,
  webfetch: TOOL_KIND_FETCH,
  websearch: TOOL_KIND_FETCH,
};
