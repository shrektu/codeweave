import { ApiAuth, ApiProviderId } from "../domain/apiProviders";
import { LimitPeriod } from "../domain/limitWindows";
import { LimitAvailability, ProviderId } from "../domain/types";
import type {
  AccountView,
  LimitView,
  LimitWindowView,
  RotationPhaseView,
  SessionView,
} from "../shared/views";

const ENDED_PHASES: readonly RotationPhaseView["phase"][] = [
  "stopped",
  "failed",
  "halted",
];

export function isSessionLive(session: SessionView | null): boolean {
  return session !== null && !ENDED_PHASES.includes(session.phase.phase);
}

export type SelectableProvider =
  | typeof ProviderId.claude
  | typeof ProviderId.codex
  | typeof ProviderId.gemini
  | typeof ProviderId.opencode;

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
