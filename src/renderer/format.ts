import { ApiAuth, ApiProviderId } from "../domain/apiProviders";
import { PROVIDER_IMAGE_INPUT } from "../domain/attachments";
import { isRunOpen } from "../domain/flowState";
import { LimitPeriod } from "../domain/limitWindows";
import {
  DefinitionSource,
  LimitAvailability,
  ProviderId,
} from "../domain/types";
import type {
  AccountView,
  ContextUsageView,
  FlowRunView,
  LimitView,
  LimitWindowView,
  RotationPhaseView,
  SessionHistoryEntry,
  SessionView,
  Snapshot,
  StoredSession,
} from "../shared/views";

const ENDED_PHASES: readonly RotationPhaseView["phase"][] = [
  "stopped",
  "failed",
  "halted",
];

export function isSessionLive(session: SessionView | null): boolean {
  return session !== null && !ENDED_PHASES.includes(session.phase.phase);
}

export function anySessionLive(snapshot: Snapshot | null): boolean {
  return snapshot?.sessions.some((session) => isSessionLive(session)) ?? false;
}

export interface ShownSession {
  readonly session: SessionView | null;
  readonly runId: string | null;
}

const NO_SHOWN_SESSION: ShownSession = { session: null, runId: null };

export function isLiveOrchestrator(session: SessionView | null): boolean {
  return session?.orchestrate === true && isSessionLive(session);
}

export function activeSessionOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
): SessionView | null {
  if (snapshot === null || activeSessionId === null) {
    return null;
  }
  return (
    snapshot.sessions.find((session) => session.id === activeSessionId) ?? null
  );
}

export function historyOnlyIdOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
  history: readonly SessionHistoryEntry[],
): string | null {
  if (snapshot === null || activeSessionId === null) {
    return null;
  }
  const live = snapshot.sessions.some(
    (session) => session.id === activeSessionId,
  );
  return !live && history.some((entry) => entry.id === activeSessionId)
    ? activeSessionId
    : null;
}

export interface ResumeFailure {
  readonly sessionId: string;
  readonly message: string;
  readonly promptCount: number;
}

export function resumeFailureVisible(
  failure: ResumeFailure | null,
  session: SessionView | null,
  activeSessionId: string | null,
): boolean {
  return (
    failure !== null &&
    session !== null &&
    failure.sessionId === session.id &&
    failure.sessionId === activeSessionId &&
    session.prompts.length <= failure.promptCount
  );
}

export function storedSessionView(stored: StoredSession): SessionView {
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    cwd: stored.cwd,
    explicitFolder: stored.explicitFolder,
    provider: stored.provider,
    profile: stored.profile,
    phase: { phase: "stopped" },
    activeAccountId: null,
    activeProvider: stored.provider,
    messages: [...stored.messages],
    toolCalls: [...stored.toolCalls],
    permissions: [],
    limits: [],
    lastTurn: stored.lastTurn,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    contextUsage: null,
    turns: [...stored.turns],
    orchestrate: stored.orchestrate,
    imageInput: PROVIDER_IMAGE_INPUT[stored.provider],
    canCompact: false,
    prompts: [...stored.prompts],
  };
}

export function shownSessionOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
  focusedRunId: string | null = null,
): ShownSession {
  if (snapshot === null) {
    return NO_SHOWN_SESSION;
  }
  const active = activeSessionOf(snapshot, activeSessionId);
  const focusedId =
    isLiveOrchestrator(active) &&
    snapshot.flowRuns.some(
      (run) => run.runId === focusedRunId && run.ownerSessionId === active?.id,
    )
      ? focusedRunId
      : null;
  const focused = snapshot.flowSessions.find(
    (entry) => entry.runId === focusedId,
  );
  if (focused !== undefined) {
    return { session: focused.view, runId: focused.runId };
  }
  const main: ShownSession = { session: active, runId: null };
  if (isSessionLive(active)) {
    return main;
  }
  const openRuns = snapshot.flowRuns
    .toReversed()
    .filter(
      (run) =>
        isRunOpen(run.status) &&
        (run.ownerSessionId === null ||
          (active !== null && run.ownerSessionId === active.id)),
    );
  const found = openRuns.flatMap((run) =>
    snapshot.flowSessions.filter((entry) => entry.runId === run.runId),
  )[0];
  return found === undefined
    ? main
    : { session: found.view, runId: found.runId };
}

export function orchestratedRunsOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
): FlowRunView[] {
  const session = activeSessionOf(snapshot, activeSessionId);
  if (snapshot === null || session?.orchestrate !== true) {
    return [];
  }
  return snapshot.flowRuns
    .filter((run) => run.ownerSessionId === session.id)
    .toReversed();
}

export function focusedRunOf(
  snapshot: Snapshot | null,
  activeSessionId: string | null,
  focusedRunId: string | null,
): FlowRunView | null {
  const active = activeSessionOf(snapshot, activeSessionId);
  if (snapshot === null || !isLiveOrchestrator(active) || active === null) {
    return null;
  }
  return (
    snapshot.flowRuns.find(
      (run) => run.runId === focusedRunId && run.ownerSessionId === active.id,
    ) ?? null
  );
}

export function nodeModelOf(
  run: FlowRunView,
  nodeId: string,
  flowSessions: Snapshot["flowSessions"],
): string | null {
  const live = flowSessions.find(
    (entry) =>
      entry.runId === run.runId &&
      entry.view.flowRef?.flowId === run.flowId &&
      entry.view.flowRef.nodeId === nodeId,
  );
  return (
    live?.view.currentModel ??
    run.nodes.find((node) => node.id === nodeId)?.model ??
    null
  );
}

const COMPACT_TOKENS = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const PERCENT_FULL = 100;

export function contextUsageText(usage: ContextUsageView | null): string {
  if (usage === null) {
    return "Context not reported";
  }
  const used = COMPACT_TOKENS.format(usage.usedTokens);
  if (usage.limitTokens === null) {
    return `${used} tokens in context`;
  }
  const limit = COMPACT_TOKENS.format(usage.limitTokens);
  const pct = Math.min(
    PERCENT_FULL,
    Math.round((usage.usedTokens / usage.limitTokens) * PERCENT_FULL),
  );
  return `${used} / ${limit} · ${String(pct)}%`;
}

export function nodeContextUsageOf(
  run: FlowRunView,
  nodeId: string,
  flowSessions: Snapshot["flowSessions"],
): ContextUsageView | null {
  const live = flowSessions.find(
    (entry) =>
      entry.runId === run.runId &&
      entry.view.flowRef?.flowId === run.flowId &&
      entry.view.flowRef.nodeId === nodeId,
  );
  return live?.view.contextUsage ?? null;
}

export function latestRunOf(
  runs: readonly FlowRunView[],
  cwd: string,
): FlowRunView | null {
  return runs.findLast((run) => run.cwd === cwd) ?? null;
}

export function latestOpenRunOf(
  runs: readonly FlowRunView[],
): FlowRunView | null {
  return runs.findLast((run) => isRunOpen(run.status)) ?? null;
}

export type SelectableProvider =
  | typeof ProviderId.claude
  | typeof ProviderId.codex
  | typeof ProviderId.gemini
  | typeof ProviderId.opencode;

export const DEFINITION_SOURCE_LABELS: Readonly<
  Record<DefinitionSource, string>
> = {
  [DefinitionSource.project]: "Project",
  [DefinitionSource.library]: "Library",
};

export const DEFINITION_SOURCES: readonly DefinitionSource[] =
  Object.values(DefinitionSource);

export function parseDefinitionSource(value: string): DefinitionSource | null {
  return DEFINITION_SOURCES.find((source) => source === value) ?? null;
}

export const PROVIDER_LABELS: Readonly<Record<SelectableProvider, string>> = {
  [ProviderId.claude]: "Claude",
  [ProviderId.codex]: "Codex",
  [ProviderId.gemini]: "Gemini",
  [ProviderId.opencode]: "OpenCode (API key)",
};
export const PROVIDER_IDS: readonly SelectableProvider[] = [
  ProviderId.claude,
  ProviderId.codex,
  ProviderId.gemini,
  ProviderId.opencode,
];

export const API_PROVIDER_IDS: readonly ApiProviderId[] =
  Object.values(ApiProviderId);

export function parseApiProvider(value: string): ApiProviderId | null {
  return API_PROVIDER_IDS.find((id) => id === value) ?? null;
}

export const API_AUTH_IDS: readonly ApiAuth[] = Object.values(ApiAuth);

export function parseApiAuth(value: string): ApiAuth | null {
  return API_AUTH_IDS.find((id) => id === value) ?? null;
}

export function isSelectable(
  provider: ProviderId,
): provider is SelectableProvider {
  return PROVIDER_IDS.some((id) => id === provider);
}

export function providerOf(value: string): SelectableProvider {
  return PROVIDER_IDS.find((id) => id === value) ?? ProviderId.claude;
}

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const STALE_AFTER_MINUTES = 15;
export const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export const STALE_AFTER_MS = STALE_AFTER_MINUTES * MS_PER_MINUTE;
export const COUNTDOWN_NOW = "now";

export interface TimeFormatOptions {
  locale?: string;
  timeZone?: string;
}

export function formatLocalTime(
  epochSeconds: number,
  options: TimeFormatOptions = {},
): string {
  return new Date(epochSeconds * MS_PER_SECOND).toLocaleTimeString(
    options.locale,
    {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: options.timeZone,
    },
  );
}

export function formatCountdown(
  epochSeconds: number,
  nowMillis: number,
): string {
  const remainingSeconds = epochSeconds - nowMillis / MS_PER_SECOND;
  if (remainingSeconds <= 0) {
    return COUNTDOWN_NOW;
  }
  const totalMinutes = Math.ceil(remainingSeconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (hours === 0) {
    return `in ${minutes.toString()} min`;
  }
  if (minutes === 0) {
    return `in ${hours.toString()} h`;
  }
  return `in ${hours.toString()} h ${minutes.toString()} min`;
}

export function isStale(
  limit: Pick<LimitView, "accountId" | "observedAt">,
  nowMillis: number,
  activeAccountId: string | null,
): boolean {
  return (
    limit.accountId !== activeAccountId ||
    nowMillis - limit.observedAt > STALE_AFTER_MS
  );
}

export const PERCENT_SCALE = 100;
const DEFAULT_LIMIT_LABEL = "Limit";
const SCOPE_JOINER = " · ";
const PERIOD_LABELS: Readonly<Record<string, string>> = {
  [LimitPeriod.fiveHour]: "5-hour",
  [LimitPeriod.sevenDay]: "Weekly",
  [LimitPeriod.monthly]: "Monthly",
};

export function limitWindowLabel(
  window: Pick<LimitWindowView, "period" | "scope">,
): string {
  const base =
    window.period === null
      ? DEFAULT_LIMIT_LABEL
      : (PERIOD_LABELS[window.period] ?? window.period);
  return window.scope === null ? base : `${base}${SCOPE_JOINER}${window.scope}`;
}

export function limitPercent(
  utilization: number | null,
  exhausted: boolean,
): number {
  if (exhausted) {
    return PERCENT_SCALE;
  }
  const percent = Math.round((utilization ?? 0) * PERCENT_SCALE);
  return Math.min(PERCENT_SCALE, Math.max(0, percent));
}

const SIGN_IN_TEXT = "Sign in to see limits";
const NO_DATA_PREFIX = "No limit data: ";
const FAILED_TEXT = "Could not read limits";
const PENDING_TEXT = "Checking limits…";
const UNSUPPORTED_REASONS: Readonly<Record<ProviderId, string>> = {
  [ProviderId.claude]:
    "Claude Code reports limits only for a claude.ai subscription",
  [ProviderId.codex]: "Codex reports limits only for a ChatGPT sign-in",
  [ProviderId.gemini]: "agy reported no usage buckets",
  [ProviderId.opencode]:
    "opencode reports usage only for Console login accounts",
};
const CONSOLE_EMPTY_REASON = "the Console reported no Go allowance or budget";
const OTHER_API_REASON = "this provider does not report usage limits";

function unsupportedReason(account: AccountView): string {
  if (account.provider !== ProviderId.opencode) {
    return account.api === null
      ? UNSUPPORTED_REASONS[account.provider]
      : OTHER_API_REASON;
  }
  switch (account.api?.auth) {
    case ApiAuth.consoleLogin:
      return CONSOLE_EMPTY_REASON;
    case ApiAuth.apiKey:
    case undefined:
      return UNSUPPORTED_REASONS[ProviderId.opencode];
  }
}

export function missingLimitText(account: AccountView): string {
  if (account.runtime.status === "needs_login") {
    return SIGN_IN_TEXT;
  }
  switch (account.limitAvailability) {
    case LimitAvailability.unsupported:
      return `${NO_DATA_PREFIX}${unsupportedReason(account)}`;
    case LimitAvailability.failed:
      return FAILED_TEXT;
    case LimitAvailability.pending:
    case LimitAvailability.reported:
      return PENDING_TEXT;
  }
}

const PATH_SEPARATOR = /[\\/]/;
const KEPT_PATH_SEGMENTS = 2;

export function folderLabel(cwd: string): string {
  return cwd.split(PATH_SEPARATOR).filter(Boolean).at(-1) ?? cwd;
}

export function compactPath(path: string): string {
  const segments = path.split(PATH_SEPARATOR).filter(Boolean);
  if (segments.length <= KEPT_PATH_SEGMENTS) {
    return path;
  }
  const separator = path.includes("/") ? "/" : "\\";
  return `…${separator}${segments.slice(-KEPT_PATH_SEGMENTS).join(separator)}`;
}

export function accountLabel(
  accounts: readonly AccountView[],
  accountId: string,
): string {
  return (
    accounts.find((account) => account.id === accountId)?.label ?? accountId
  );
}
