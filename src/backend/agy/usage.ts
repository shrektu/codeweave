import { createInterface } from "node:readline";

import {
  MS_PER_SECOND,
  RATE_LIMIT_STATUS_REJECTED,
} from "../../domain/constants";
import type { AgentEvent } from "../../domain/events";
import {
  RATE_LIMIT_STATUS_ALLOWED,
  RATE_LIMIT_TYPE_FIVE_HOUR,
  RATE_LIMIT_TYPE_SEVEN_DAY,
} from "../codex/constants";
import { withTimeout } from "../codex/handshake";
import { watchAbort } from "../codex/probe";
import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
} from "../process/container";

import {
  AUTH_FAILED_RESULT_ERROR,
  AUTH_REQUIRED_STDERR_PREFIX,
  AgyResultStatus,
  GEMINI_USAGE_GROUP,
  USAGE_WINDOW_FIVE_HOUR,
  USAGE_WINDOW_WEEKLY,
} from "./constants";
import { buildAgyUsageLaunch } from "./launch";
import {
  UsageOutputSchema,
  parseJson,
  type UsageBucket,
  type UsageOutput,
} from "./protocol";

export interface AgyBucket {
  readonly id: string;
  readonly window: string | null;
  readonly remainingFraction: number;
  readonly resetsAt: number | null;
}

export interface AgyLimits {
  readonly buckets: readonly AgyBucket[];
}

export type AgyProbeResult =
  | { readonly kind: "limits"; readonly limits: AgyLimits }
  | { readonly kind: "needs_login" }
  | { readonly kind: "no_limits" }
  | { readonly kind: "failed" }
  | { readonly kind: "unstopped" };

export interface AgyProbeDeps {
  readonly container: ProcessContainer;
  readonly executable: string;
  readonly configDir: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly stopGraceMs: number;
  readonly signal?: AbortSignal;
}

type RateLimitEvent = Extract<AgentEvent, { type: "rate_limit" }>;

const NEVER_ABORTED = new AbortController();

const FAILED: AgyProbeResult = { kind: "failed" };
const NEEDS_LOGIN: AgyProbeResult = { kind: "needs_login" };
const NO_LIMITS: AgyProbeResult = { kind: "no_limits" };
const UNSTOPPED: AgyProbeResult = { kind: "unstopped" };

function resetEpoch(resetTime: string | undefined): number | null {
  const millis = Date.parse(resetTime ?? "");
  return Number.isNaN(millis) ? null : Math.floor(millis / MS_PER_SECOND);
}

function bucketOf(bucket: UsageBucket): AgyBucket {
  return {
    id: bucket.id,
    window: bucket.window ?? null,
    remainingFraction: bucket.remaining_fraction,
    resetsAt: resetEpoch(bucket.reset_time),
  };
}

export function probeResultOf(output: UsageOutput): AgyProbeResult {
  if (output.status === AgyResultStatus.error) {
    return (output.error ?? "").includes(AUTH_FAILED_RESULT_ERROR)
      ? NEEDS_LOGIN
      : FAILED;
  }
  const groups = output.command?.data?.groups;
  if (groups === undefined) {
    return FAILED;
  }
  const buckets =
    groups.find((group) => group.name === GEMINI_USAGE_GROUP)?.buckets ?? [];
  return buckets.length === 0
    ? NO_LIMITS
    : { kind: "limits", limits: { buckets: buckets.map(bucketOf) } };
}

function exhaustedBuckets(limits: AgyLimits): AgyBucket[] {
  return limits.buckets.filter((bucket) => bucket.remainingFraction <= 0);
}

export function isExhausted(limits: AgyLimits): boolean {
  return exhaustedBuckets(limits).length > 0;
}

function latestReset(buckets: readonly AgyBucket[]): AgyBucket | null {
  return buckets.reduce<AgyBucket | null>(
    (latest, bucket) =>
      bucket.resetsAt !== null &&
      (latest?.resetsAt === null ||
        latest === null ||
        bucket.resetsAt > latest.resetsAt)
        ? bucket
        : latest,
    null,
  );
}

function mostUsed(buckets: readonly AgyBucket[]): AgyBucket | null {
  return buckets.reduce<AgyBucket | null>(
    (best, bucket) =>
      best === null || bucket.remainingFraction < best.remainingFraction
        ? bucket
        : best,
    null,
  );
}

export function exhaustedResetsAt(limits: AgyLimits): number | null {
  return latestReset(exhaustedBuckets(limits))?.resetsAt ?? null;
}

function rateLimitTypeOf(window: string | null): string | null {
  switch (window) {
    case null:
      return null;
    case USAGE_WINDOW_FIVE_HOUR:
      return RATE_LIMIT_TYPE_FIVE_HOUR;
    case USAGE_WINDOW_WEEKLY:
      return RATE_LIMIT_TYPE_SEVEN_DAY;
    default:
      return window;
  }
}

function rejectedEvent(limits: AgyLimits | null): RateLimitEvent {
  const exhausted = limits === null ? [] : exhaustedBuckets(limits);
  const binding = latestReset(exhausted) ?? exhausted[0] ?? null;
  return {
    type: "rate_limit",
    status: RATE_LIMIT_STATUS_REJECTED,
    resetsAt: binding?.resetsAt ?? null,
    rateLimitType: rateLimitTypeOf(binding?.window ?? null),
    utilization: binding === null ? null : 1 - binding.remainingFraction,
  };
}

export function toAgyRateLimitEvent(
  limits: AgyLimits | null,
  forceRejected = false,
): RateLimitEvent | null {
  if (forceRejected || (limits !== null && isExhausted(limits))) {
    return rejectedEvent(limits);
  }
  const binding = limits === null ? null : mostUsed(limits.buckets);
  if (binding === null) {
    return null;
  }
  return {
    type: "rate_limit",
    status: RATE_LIMIT_STATUS_ALLOWED,
    resetsAt: binding.resetsAt,
    rateLimitType: rateLimitTypeOf(binding.window),
    utilization: 1 - binding.remainingFraction,
  };
}

function spawnSpecOf(deps: AgyProbeDeps): SpawnSpec {
  const launch = buildAgyUsageLaunch({
    executable: deps.executable,
    env: deps.env,
    configDir: deps.configDir,
  });
  return {
    command: launch.command,
    args: launch.args,
    env: launch.env,
    cwd: deps.cwd,
    runId: deps.runId,
  };
}

function readUsage(contained: Contained): {
  readonly result: Promise<AgyProbeResult>;
  readonly close: () => void;
} {
  const settled = Promise.withResolvers<AgyProbeResult>();
  const stdout = createInterface({ input: contained.stdout });
  const stderr = createInterface({ input: contained.stderr });
  stdout.on("line", (line) => {
    const parsed = UsageOutputSchema.safeParse(parseJson(line));
    if (parsed.success) {
      settled.resolve(probeResultOf(parsed.data));
    }
  });
  stdout.on("close", () => {
    settled.resolve(FAILED);
  });
  stderr.on("line", (line) => {
    if (line.startsWith(AUTH_REQUIRED_STDERR_PREFIX)) {
      settled.resolve(NEEDS_LOGIN);
    }
  });
  return {
    result: settled.promise,
    close: () => {
      stdout.close();
      stderr.close();
    },
  };
}

async function stopProbe(
  contained: Contained,
  graceMs: number,
  runId: string,
): Promise<boolean> {
  try {
    const result = await contained.stop(graceMs);
    if (!result.ok) {
      console.warn(`agy usage probe left processes behind: ${runId}`);
    }
    return result.ok;
  } catch (error) {
    console.error(`stopping the agy usage probe failed: ${runId}`, error);
    return false;
  }
}

async function awaitUsage(
  deps: AgyProbeDeps,
  contained: Contained,
): Promise<AgyProbeResult> {
  const reader = readUsage(contained);
  const abort = watchAbort(deps.signal ?? NEVER_ABORTED.signal);
  try {
    return await withTimeout(
      Promise.race([reader.result, abort.promise]),
      deps.timeoutMs,
    );
  } catch (error) {
    if (deps.signal?.aborted !== true) {
      console.warn(`agy usage probe failed: ${deps.runId}`, error);
    }
    return FAILED;
  } finally {
    abort.release();
    reader.close();
  }
}

export async function probeAgyUsage(
  deps: AgyProbeDeps,
): Promise<AgyProbeResult> {
  if (deps.signal?.aborted === true) {
    return FAILED;
  }
  let contained: Contained;
  try {
    contained = await deps.container.spawn(spawnSpecOf(deps));
  } catch (error) {
    console.warn(`agy usage probe failed: ${deps.runId}`, error);
    return FAILED;
  }
  const result = await awaitUsage(deps, contained);
  const stopped = await stopProbe(contained, deps.stopGraceMs, deps.runId);
  return stopped ? result : UNSTOPPED;
}
