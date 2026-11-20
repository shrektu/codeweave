import { MS_PER_SECOND } from "../../domain/constants";
import {
  LimitPeriod,
  scopedWindowId,
  type LimitWindow,
} from "../../domain/limitWindows";
import { isNeedsLogin } from "../../domain/rateLimit";
import {
  PermissionProfile,
  type Account,
  type EpochMillis,
  type EpochSeconds,
} from "../../domain/types";
import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentHandle,
} from "../agentAdapter";
import { withTimeout } from "../codex/handshake";
import { watchAbort } from "../codex/probe";

export const USAGE_COMMAND = "/usage";

export type UsageParse =
  | { readonly kind: "limits"; readonly windows: LimitWindow[] }
  | { readonly kind: "no_limits" }
  | { readonly kind: "failed" };

export type ClaudeProbeResult =
  | { readonly kind: "limits"; readonly limits: readonly LimitWindow[] }
  | {
      readonly kind: "needs_login" | "no_limits" | "failed" | "unstopped";
    };

export interface ClaudeUsageProbeDeps {
  readonly adapter: AgentAdapter;
  readonly executable: () => Promise<string>;
  readonly timeoutMs: number;
  readonly stopGraceMs: number;
  readonly newRunId: () => string;
  readonly now: () => EpochMillis;
}

export type ClaudeUsageProbe = (
  account: Account,
  signal: AbortSignal,
) => Promise<ClaudeProbeResult>;

const USAGE_HEADING = "## Usage";
const LABEL_FIVE_HOUR = "5-hour limit";
const LABEL_WEEKLY_ALL = "Weekly · all models";
const LABEL_WEEKLY_PREFIX = "Weekly · ";
const OTHER_LIMIT_KEY = "limit";
const PERCENT_SCALE = 100;
const FULL_PERCENT = 100;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_HOUR = 60;
const NOON_HOUR = 12;
const PM = "PM";
const LIMIT_LINE =
  /^\*\*(.+?)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?$/u;
const RESET_TEXT =
  /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})\s*(AM|PM) (?:UTC|GMT)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/u;
const MARKDOWN_ESCAPE = /\\([\\`*_[\]<>|])/gu;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const FAILED = { kind: "failed" } as const;
const NEEDS_LOGIN: ClaudeProbeResult = { kind: "needs_login" };
const NO_LIMITS = { kind: "no_limits" } as const;
const UNSTOPPED: ClaudeProbeResult = { kind: "unstopped" };

function unescapeLabel(label: string): string {
  return label.replace(MARKDOWN_ESCAPE, "$1");
}

function offsetMinutesOf(match: RegExpMatchArray): number {
  const [, , , , , , sign, hours, minutes] = match;
  if (hours === undefined) {
    return 0;
  }
  const total = Number(hours) * MINUTES_PER_HOUR + Number(minutes ?? "0");
  return sign === "-" ? -total : total;
}

function instantIn(
  year: number,
  match: RegExpMatchArray,
  monthIndex: number,
): EpochMillis {
  const [, , day, hour, minute, meridiem] = match;
  const hour24 = (Number(hour) % NOON_HOUR) + (meridiem === PM ? NOON_HOUR : 0);
  return (
    Date.UTC(year, monthIndex, Number(day), hour24, Number(minute)) -
    offsetMinutesOf(match) * MS_PER_MINUTE
  );
}

function parseReset(
  text: string | undefined,
  nowMs: EpochMillis,
): EpochSeconds | null {
  const match = text === undefined ? null : RESET_TEXT.exec(text);
  const monthIndex = MONTHS.findIndex((month) => month === match?.[1]);
  if (match === null || monthIndex < 0) {
    return null;
  }
  const currentYear = new Date(nowMs).getUTCFullYear();
  const earliest = nowMs - MS_PER_DAY;
  const upcoming = [currentYear - 1, currentYear, currentYear + 1]
    .map((year) => instantIn(year, match, monthIndex))
    .filter((instant) => instant >= earliest);
  return upcoming.length === 0
    ? null
    : Math.floor(Math.min(...upcoming) / MS_PER_SECOND);
}

function windowOf(
  label: string,
  percent: number,
  resetsAt: EpochSeconds | null,
): LimitWindow {
  let period: string | null = null;
  let scope: string | null = label;
  let id = scopedWindowId(OTHER_LIMIT_KEY, label);
  if (label === LABEL_FIVE_HOUR) {
    period = LimitPeriod.fiveHour;
    scope = null;
    id = period;
  } else if (label === LABEL_WEEKLY_ALL) {
    period = LimitPeriod.sevenDay;
    scope = null;
    id = period;
  } else if (label.startsWith(LABEL_WEEKLY_PREFIX)) {
    period = LimitPeriod.sevenDay;
    scope = label.slice(LABEL_WEEKLY_PREFIX.length);
    id = scopedWindowId(period, scope);
  }
  return {
    id,
    scope,
    period,
    utilization: percent / PERCENT_SCALE,
    resetsAt,
    exhausted: percent >= FULL_PERCENT,
  };
}

export function parseUsageMarkdown(
  text: string,
  nowMs: EpochMillis,
): UsageParse {
  const windows = text.split("\n").flatMap((line) => {
    const match = LIMIT_LINE.exec(line.trim());
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [
          windowOf(
            unescapeLabel(match[1]),
            Number(match[2]),
            parseReset(match[3], nowMs),
          ),
        ];
  });
  if (windows.length > 0) {
    return { kind: "limits", windows };
  }
  return text.includes(USAGE_HEADING) ? NO_LIMITS : FAILED;
}

function resultOf(parsed: UsageParse): ClaudeProbeResult {
  return parsed.kind === "limits"
    ? { kind: "limits", limits: parsed.windows }
    : parsed;
}

async function readUsage(
  deps: ClaudeUsageProbeDeps,
  handle: AgentHandle,
  signal: AbortSignal,
): Promise<ClaudeProbeResult> {
  const texts: string[] = [];
  const errors: { authRequired: boolean } = { authRequired: false };
  const unsubscribe = handle.subscribe((event) => {
    if (event.type === "text") {
      texts.push(event.text);
    } else if (event.type === "turn_error" && isNeedsLogin(event)) {
      errors.authRequired = true;
    }
  });
  const aborted = watchAbort(signal);
  try {
    await withTimeout(
      Promise.race([
        handle.prompt(USAGE_COMMAND, { model: null }),
        aborted.promise,
      ]),
      deps.timeoutMs,
    );
  } catch (error) {
    console.warn("the Claude usage probe did not finish", error);
    await handle.cancel().catch((cancelError: unknown) => {
      console.warn("cancelling the Claude usage probe failed", cancelError);
    });
    return FAILED;
  } finally {
    aborted.release();
    unsubscribe();
  }
  return errors.authRequired
    ? NEEDS_LOGIN
    : resultOf(parseUsageMarkdown(texts.join(""), deps.now()));
}

async function stopped(handle: AgentHandle, graceMs: number): Promise<boolean> {
  try {
    return (await handle.stop(graceMs)).ok;
  } catch (error) {
    console.warn("stopping the Claude usage probe failed", error);
    return false;
  }
}

export function createClaudeUsageProbe(
  deps: ClaudeUsageProbeDeps,
): ClaudeUsageProbe {
  return async (account, signal) => {
    if (signal.aborted) {
      return FAILED;
    }
    const started = await deps.adapter.start({
      account,
      cwd: account.configDir,
      profile: PermissionProfile.plan,
      runId: deps.newRunId(),
      executable: await deps.executable(),
    });
    if (!started.ok) {
      return started.reason === AgentStartFailure.needsLogin
        ? NEEDS_LOGIN
        : FAILED;
    }
    const outcome = await readUsage(deps, started.handle, signal);
    return (await stopped(started.handle, deps.stopGraceMs))
      ? outcome
      : UNSTOPPED;
  };
}
