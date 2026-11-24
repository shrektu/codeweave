import {
  ERROR_KIND_AUTH_REQUIRED,
  ERROR_KIND_RATE_LIMIT,
  RATE_LIMIT_STATUS_REJECTED,
  RATE_LIMIT_TYPE_FIVE_HOUR,
  RATE_LIMIT_TYPE_SEVEN_DAY,
} from "../../domain/constants";
import type {
  AgentEvent,
  PermissionOption,
  ToolCallStatus,
} from "../../domain/events";
import type { LimitWindow } from "../../domain/limitWindows";
import { PermissionProfile } from "../../domain/types";
import {
  DEFAULT_TOOL_KIND,
  OPTION_KIND_ALLOW_ALWAYS,
  OPTION_KIND_ALLOW_ONCE,
  OPTION_KIND_REJECT_ONCE,
} from "../constants";

import {
  CodexApprovalPolicy,
  CodexDecision,
  CodexErrorInfoName,
  CodexItemStatus,
  CodexItemType,
  CodexPermissionChoice,
  CodexSandboxMode,
  CodexSandboxPolicyType,
  HTTP_STATUS_UNAUTHORIZED,
  MCP_TITLE_SEPARATOR,
  OPTION_NAME_ALLOW,
  OPTION_NAME_ALLOW_SESSION,
  OPTION_NAME_DECLINE,
  OPTION_NAME_DENY,
  OPTION_NAME_GRANT,
  PERCENT_SCALE,
  RATE_LIMIT_STATUS_ALLOWED,
  TITLE_EDIT_FILES,
  TITLE_EDIT_PREFIX,
  TITLE_PERMISSIONS,
  TITLE_RUN_COMMAND,
  TITLE_SEPARATOR,
  TOOL_KIND_EDIT,
  TOOL_KIND_EXECUTE,
  TOOL_KIND_SEARCH,
  WINDOW_MINUTES_FIVE_HOUR,
  WINDOW_MINUTES_SEVEN_DAY,
} from "./constants";
import {
  HttpConnectionFailedInfoSchema,
  KnownThreadItemSchema,
  type AgentMessageDeltaParams,
  type CodexErrorInfo,
  type CommandApprovalParams,
  type KnownThreadItem,
  type PermissionsApprovalParams,
  type RateLimitSnapshot,
  type RateLimitsReadResponse,
  type RateLimitWindow,
  type ThreadItem,
  type TurnError,
} from "./protocol";

type RateLimitEvent = Extract<AgentEvent, { type: "rate_limit" }>;
type PermissionRequestEvent = Extract<
  AgentEvent,
  { type: "permission_request" }
>;
type TurnErrorEvent = Extract<AgentEvent, { type: "turn_error" }>;

interface ToolDescription {
  readonly title: string;
  readonly kind: string;
  readonly rawInput?: unknown;
}

export interface ProfilePolicy {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandbox: CodexSandboxMode;
}

export interface ExtraRateLimit {
  readonly limitId: string;
  readonly limitName: string | null;
  readonly primary: RateLimitWindow | null;
  readonly secondary: RateLimitWindow | null;
}

export interface RateLimitState {
  readonly primary: RateLimitWindow | null;
  readonly secondary: RateLimitWindow | null;
  readonly rateLimitReachedType: string | null;
  readonly ordinaryUsageAllowed: boolean | null;
  readonly extra: readonly ExtraRateLimit[];
}

export type RateLimitsByLimitId = NonNullable<
  RateLimitsReadResponse["rateLimitsByLimitId"]
>;

export const EMPTY_RATE_LIMITS: RateLimitState = {
  primary: null,
  secondary: null,
  rateLimitReachedType: null,
  ordinaryUsageAllowed: null,
  extra: [],
};

const SLOT_PRIMARY = "primary";
const SLOT_SECONDARY = "secondary";
const LIMIT_ID_SEPARATOR = ":";

export function policyFor(profile: PermissionProfile): ProfilePolicy {
  switch (profile) {
    case PermissionProfile.bypass:
      return {
        approvalPolicy: CodexApprovalPolicy.never,
        sandbox: CodexSandboxMode.dangerFullAccess,
      };
    case PermissionProfile.plan:
      return {
        approvalPolicy: CodexApprovalPolicy.untrusted,
        sandbox: CodexSandboxMode.readOnly,
      };
    case PermissionProfile.unattended:
    case PermissionProfile.acceptEdits:
    case PermissionProfile.ask:
      return {
        approvalPolicy: CodexApprovalPolicy.untrusted,
        sandbox: CodexSandboxMode.workspaceWrite,
      };
  }
}

export function sandboxPolicyFor(
  sandbox: CodexSandboxMode,
): Readonly<Record<string, unknown>> {
  switch (sandbox) {
    case CodexSandboxMode.dangerFullAccess:
      return { type: CodexSandboxPolicyType.dangerFullAccess };
    case CodexSandboxMode.readOnly:
      return { type: CodexSandboxPolicyType.readOnly, networkAccess: false };
    case CodexSandboxMode.workspaceWrite:
      return { type: CodexSandboxPolicyType.workspaceWrite };
  }
}

function toolStatus(
  raw: string | undefined,
  fallback: ToolCallStatus,
): ToolCallStatus {
  switch (raw) {
    case CodexItemStatus.inProgress:
      return "in_progress";
    case CodexItemStatus.completed:
      return "completed";
    case CodexItemStatus.failed:
    case CodexItemStatus.declined:
      return "failed";
    default:
      return fallback;
  }
}

export function fileChangeOf(
  item: ThreadItem,
): { itemId: string; paths: string[] } | null {
  const parsed = KnownThreadItemSchema.safeParse(item);
  if (!parsed.success || parsed.data.type !== CodexItemType.fileChange) {
    return null;
  }
  return {
    itemId: parsed.data.id,
    paths: parsed.data.changes.map((change) => change.path),
  };
}

function describeItem(item: KnownThreadItem): ToolDescription | null {
  switch (item.type) {
    case CodexItemType.commandExecution:
      return {
        title: item.command,
        kind: TOOL_KIND_EXECUTE,
        rawInput: { command: item.command },
      };
    case CodexItemType.fileChange:
      return {
        title:
          TITLE_EDIT_PREFIX +
          item.changes.map((change) => change.path).join(TITLE_SEPARATOR),
        kind: TOOL_KIND_EDIT,
      };
    case CodexItemType.mcpToolCall:
      return {
        title: `${item.server}${MCP_TITLE_SEPARATOR}${item.tool}`,
        kind: DEFAULT_TOOL_KIND,
      };
    case CodexItemType.webSearch:
      return { title: item.query, kind: TOOL_KIND_SEARCH };
    case CodexItemType.agentMessage:
      return null;
  }
}

function knownTool(
  item: ThreadItem,
): { item: KnownThreadItem; description: ToolDescription } | null {
  const parsed = KnownThreadItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const description = describeItem(parsed.data);
  return description === null ? null : { item: parsed.data, description };
}

function rawInputOf(description: ToolDescription): {
  rawInput?: unknown;
} {
  return description.rawInput === undefined
    ? {}
    : { rawInput: description.rawInput };
}

function statusOf(item: KnownThreadItem): string | undefined {
  return item.type === CodexItemType.agentMessage ? undefined : item.status;
}

export function mapItemStarted(item: ThreadItem): AgentEvent[] {
  const tool = knownTool(item);
  if (tool === null) {
    return [];
  }
  const { description } = tool;
  return [
    {
      type: "tool_call",
      toolCallId: tool.item.id,
      title: description.title,
      kind: description.kind,
      status: toolStatus(statusOf(tool.item), "in_progress"),
      ...rawInputOf(description),
    },
  ];
}

export function mapItemCompleted(item: ThreadItem): AgentEvent[] {
  const tool = knownTool(item);
  if (tool === null) {
    return [];
  }
  const output =
    tool.item.type === CodexItemType.commandExecution
      ? (tool.item.aggregatedOutput ?? "")
      : "";
  return [
    {
      type: "tool_call_update",
      toolCallId: tool.item.id,
      status: toolStatus(statusOf(tool.item), "completed"),
      ...rawInputOf(tool.description),
      ...(output === "" ? {} : { output }),
    },
  ];
}

export function mapAgentMessageDelta(
  params: AgentMessageDeltaParams,
): AgentEvent {
  return { type: "text", messageId: params.itemId, text: params.delta };
}

const COMMAND_OPTIONS: readonly PermissionOption[] = [
  {
    optionId: CodexDecision.accept,
    name: OPTION_NAME_ALLOW,
    kind: OPTION_KIND_ALLOW_ONCE,
  },
  {
    optionId: CodexDecision.acceptForSession,
    name: OPTION_NAME_ALLOW_SESSION,
    kind: OPTION_KIND_ALLOW_ALWAYS,
  },
  {
    optionId: CodexDecision.decline,
    name: OPTION_NAME_DECLINE,
    kind: OPTION_KIND_REJECT_ONCE,
  },
];

const PERMISSIONS_OPTIONS: readonly PermissionOption[] = [
  {
    optionId: CodexPermissionChoice.grant,
    name: OPTION_NAME_GRANT,
    kind: OPTION_KIND_ALLOW_ONCE,
  },
  {
    optionId: CodexPermissionChoice.deny,
    name: OPTION_NAME_DENY,
    kind: OPTION_KIND_REJECT_ONCE,
  },
];

export function commandPermission(
  requestId: string,
  params: CommandApprovalParams,
): PermissionRequestEvent {
  const command = params.command ?? null;
  const cwd = params.cwd ?? null;
  return {
    type: "permission_request",
    requestId,
    toolCallId: params.itemId,
    title: command ?? TITLE_RUN_COMMAND,
    kind: TOOL_KIND_EXECUTE,
    ...(command === null
      ? {}
      : { rawInput: { command, ...(cwd === null ? {} : { cwd }) } }),
    locations: [],
    options: COMMAND_OPTIONS,
  };
}

export function fileChangePermission(
  requestId: string,
  itemId: string,
  locations: readonly string[],
): PermissionRequestEvent {
  return {
    type: "permission_request",
    requestId,
    toolCallId: itemId,
    title: TITLE_EDIT_FILES,
    kind: TOOL_KIND_EDIT,
    locations,
    options: COMMAND_OPTIONS,
  };
}

export function permissionsPermission(
  requestId: string,
  params: PermissionsApprovalParams,
): PermissionRequestEvent {
  return {
    type: "permission_request",
    requestId,
    toolCallId: params.itemId,
    title: TITLE_PERMISSIONS,
    kind: DEFAULT_TOOL_KIND,
    locations: [],
    options: PERMISSIONS_OPTIONS,
  };
}

function mergeWindow(
  previous: RateLimitWindow | null,
  update: RateLimitWindow | null | undefined,
): RateLimitWindow | null {
  return update ?? previous;
}

function reachedTypeOf(
  previous: RateLimitState,
  snapshot: RateLimitSnapshot,
): string | null {
  const carriesWindow =
    (snapshot.primary ?? null) !== null ||
    (snapshot.secondary ?? null) !== null;
  const reached = snapshot.rateLimitReachedType ?? null;
  return reached !== null || carriesWindow
    ? reached
    : previous.rateLimitReachedType;
}

function extraLimitsOf(
  mainLimitId: string | null | undefined,
  byLimitId: RateLimitsByLimitId | null | undefined,
): ExtraRateLimit[] {
  return Object.entries(byLimitId ?? {}).flatMap(([key, entry]) => {
    const primary = entry.primary ?? null;
    const secondary = entry.secondary ?? null;
    if (key === mainLimitId || (primary === null && secondary === null)) {
      return [];
    }
    return [
      {
        limitId: entry.limitId ?? key,
        limitName: entry.limitName ?? null,
        primary,
        secondary,
      },
    ];
  });
}

export function replaceRateLimits(
  snapshot: RateLimitSnapshot,
  ordinaryUsageAllowed?: boolean | null,
  byLimitId?: RateLimitsByLimitId | null,
): RateLimitState {
  return {
    primary: snapshot.primary ?? null,
    secondary: snapshot.secondary ?? null,
    rateLimitReachedType: snapshot.rateLimitReachedType ?? null,
    ordinaryUsageAllowed: ordinaryUsageAllowed ?? null,
    extra: extraLimitsOf(snapshot.limitId, byLimitId),
  };
}

export function mergeRateLimits(
  previous: RateLimitState,
  snapshot: RateLimitSnapshot,
  ordinaryUsageAllowed?: boolean | null,
): RateLimitState {
  return {
    primary: mergeWindow(previous.primary, snapshot.primary),
    secondary: mergeWindow(previous.secondary, snapshot.secondary),
    rateLimitReachedType: reachedTypeOf(previous, snapshot),
    ordinaryUsageAllowed: ordinaryUsageAllowed ?? previous.ordinaryUsageAllowed,
    extra: previous.extra,
  };
}

function isExhausted(state: RateLimitState): boolean {
  return (
    state.rateLimitReachedType !== null || state.ordinaryUsageAllowed === false
  );
}

function resetOf(window: RateLimitWindow): number {
  return window.resetsAt ?? Number.NEGATIVE_INFINITY;
}

function bindingWindow(
  state: RateLimitState,
  exhausted: boolean,
): RateLimitWindow | null {
  const windows = [state.primary, state.secondary].filter(
    (window) => window !== null,
  );
  const full = windows.filter((window) => window.usedPercent >= PERCENT_SCALE);
  const pool = exhausted && full.length > 0 ? full : windows;
  const key = exhausted && full.length > 0 ? resetOf : usedOf;
  return pool.reduce<RateLimitWindow | null>(
    (best, window) =>
      best === null || key(window) > key(best) ? window : best,
    null,
  );
}

function usedOf(window: RateLimitWindow): number {
  return window.usedPercent;
}

function rateLimitTypeOf(minutes: number | null | undefined): string | null {
  switch (minutes) {
    case undefined:
    case null:
      return null;
    case WINDOW_MINUTES_FIVE_HOUR:
      return RATE_LIMIT_TYPE_FIVE_HOUR;
    case WINDOW_MINUTES_SEVEN_DAY:
      return RATE_LIMIT_TYPE_SEVEN_DAY;
    default:
      return `window_${String(minutes)}m`;
  }
}

interface WindowGroup {
  readonly idPrefix: string | null;
  readonly scope: string | null;
  readonly primary: RateLimitWindow | null;
  readonly secondary: RateLimitWindow | null;
}

function limitWindowOf(
  source: RateLimitWindow,
  slot: string,
  group: WindowGroup,
): LimitWindow {
  const period = rateLimitTypeOf(source.windowDurationMins);
  const base = period ?? slot;
  return {
    id:
      group.idPrefix === null
        ? base
        : `${group.idPrefix}${LIMIT_ID_SEPARATOR}${base}`,
    scope: group.scope,
    period,
    utilization: source.usedPercent / PERCENT_SCALE,
    resetsAt: source.resetsAt ?? null,
    exhausted: source.usedPercent >= PERCENT_SCALE,
  };
}

function groupWindows(group: WindowGroup): LimitWindow[] {
  const slots: readonly (readonly [RateLimitWindow | null, string])[] = [
    [group.primary, SLOT_PRIMARY],
    [group.secondary, SLOT_SECONDARY],
  ];
  return slots.flatMap(([source, slot]) =>
    source === null ? [] : [limitWindowOf(source, slot, group)],
  );
}

function limitWindowsOf(state: RateLimitState): LimitWindow[] {
  return [
    ...groupWindows({
      idPrefix: null,
      scope: null,
      primary: state.primary,
      secondary: state.secondary,
    }),
    ...state.extra.flatMap((extra) =>
      groupWindows({
        idPrefix: extra.limitId,
        scope: extra.limitName ?? extra.limitId,
        primary: extra.primary,
        secondary: extra.secondary,
      }),
    ),
  ];
}

export function toRateLimitEvent(
  state: RateLimitState,
  forceRejected = false,
): RateLimitEvent | null {
  const rejected = forceRejected || isExhausted(state);
  const window = bindingWindow(state, rejected);
  if (window === null && !rejected) {
    return null;
  }
  return {
    type: "rate_limit",
    status: rejected ? RATE_LIMIT_STATUS_REJECTED : RATE_LIMIT_STATUS_ALLOWED,
    resetsAt: window?.resetsAt ?? null,
    rateLimitType: rateLimitTypeOf(window?.windowDurationMins),
    utilization: window === null ? null : window.usedPercent / PERCENT_SCALE,
    windows: limitWindowsOf(state),
  };
}

export function errorKindOf(
  info: CodexErrorInfo | null | undefined,
): string | null {
  if (info === null || info === undefined) {
    return null;
  }
  if (typeof info === "string") {
    switch (info) {
      case CodexErrorInfoName.usageLimitExceeded:
        return ERROR_KIND_RATE_LIMIT;
      case CodexErrorInfoName.unauthorized:
        return ERROR_KIND_AUTH_REQUIRED;
      default:
        return null;
    }
  }
  const http = HttpConnectionFailedInfoSchema.safeParse(info);
  return http.success &&
    http.data.httpConnectionFailed.httpStatusCode === HTTP_STATUS_UNAUTHORIZED
    ? ERROR_KIND_AUTH_REQUIRED
    : null;
}

export function mapTurnError(error: TurnError): TurnErrorEvent {
  return {
    type: "turn_error",
    errorKind: errorKindOf(error.codexErrorInfo),
    rpcCode: null,
    message: error.message,
  };
}
