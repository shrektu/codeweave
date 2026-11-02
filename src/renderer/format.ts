import { ApiProviderId } from "../domain/apiProviders";
import { ProviderId } from "../domain/types";
import type { AccountView, LimitView } from "../shared/views";

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
