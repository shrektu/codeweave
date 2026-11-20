import { formatUsageResponse } from "@agentclientprotocol/claude-agent-acp/dist/usage-markdown.js";

export interface FakeUsageWindow {
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

export interface FakeUsageLimits {
  readonly five_hour?: FakeUsageWindow | null;
  readonly seven_day?: FakeUsageWindow | null;
  readonly seven_day_opus?: FakeUsageWindow | null;
  readonly seven_day_sonnet?: FakeUsageWindow | null;
  readonly model_scoped?: {
    display_name: string;
    utilization: number | null;
    resets_at: string | null;
  }[];
}

export interface FakeUsageResponse {
  readonly session: {
    readonly total_cost_usd: number;
    readonly total_api_duration_ms: number;
    readonly total_duration_ms: number;
    readonly total_lines_added: number;
    readonly total_lines_removed: number;
    readonly model_usage: Readonly<Record<string, never>>;
  };
  readonly subscription_type: string | null;
  readonly rate_limits_available: boolean;
  readonly rate_limits: FakeUsageLimits | null;
  readonly behaviors: null;
}

const RENDER_TIME_ZONE = "UTC";

export function usageResponse(
  limits: FakeUsageLimits | null,
): FakeUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: limits !== null,
    rate_limits: limits,
    behaviors: null,
  };
}

export function renderUsageMarkdown(usage: FakeUsageResponse): string {
  const previous = process.env.TZ;
  process.env.TZ = RENDER_TIME_ZONE;
  try {
    return formatUsageResponse(usage);
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

export const FIVE_HOUR_RESET = "2023-11-14T23:00:00Z";
export const WEEK_RESET = "2023-11-21T20:00:00Z";
export const OPUS_RESET = "2023-11-21T21:00:00Z";
export const FIVE_HOUR_RESET_SECONDS = 1_700_002_800;
export const WEEK_RESET_SECONDS = 1_700_596_800;
export const OPUS_RESET_SECONDS = 1_700_600_400;

export const DEFAULT_USAGE_MARKDOWN = renderUsageMarkdown(
  usageResponse({
    five_hour: { utilization: 30, resets_at: FIVE_HOUR_RESET },
    seven_day: { utilization: 60, resets_at: WEEK_RESET },
    seven_day_opus: { utilization: 20, resets_at: OPUS_RESET },
  }),
);

export const NO_LIMITS_USAGE_MARKDOWN = renderUsageMarkdown(
  usageResponse(null),
);
