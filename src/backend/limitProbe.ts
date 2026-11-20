import { ApiAuth } from "../domain/apiProviders";
import { RATE_LIMIT_STATUS_REJECTED } from "../domain/constants";
import type { AgentEvent } from "../domain/events";
import {
  createRateLimitDetector,
  type LimitSnapshot,
} from "../domain/rateLimit";
import type { AccountRuntime, RotationPorts } from "../domain/rotation";
import {
  LimitAvailability,
  ProviderId,
  type Account,
  type EpochMillis,
} from "../domain/types";
import type { LimitWindow } from "../domain/limitWindows";
import type { LimitView } from "../shared/views";

import { toAgyRateLimitEvent, type AgyProbeResult } from "./agy/usage";
import type { ClaudeProbeResult } from "./claude/usageProbe";
import { RATE_LIMIT_STATUS_ALLOWED } from "./codex/constants";
import { PROBE_INTERVAL_MS } from "./constants";
import { toRateLimitEvent } from "./codex/events";
import type { ProbeResult } from "./codex/probe";

type RateLimitEvent = Extract<AgentEvent, { type: "rate_limit" }>;

export interface LimitProbeDeps {
  readonly readAccounts: () => Promise<readonly Account[]>;
  readonly probe: (
    account: Account,
    signal: AbortSignal,
  ) => Promise<ProbeResult>;
  readonly agyProbe: (
    account: Account,
    signal: AbortSignal,
  ) => Promise<AgyProbeResult>;
  readonly consoleProbe: (
    account: Account,
    signal: AbortSignal,
  ) => Promise<ConsoleProbeResult>;
  readonly claudeProbe: (
    account: Account,
    signal: AbortSignal,
  ) => Promise<ClaudeProbeResult>;
  readonly isInUse: (accountId: string) => boolean;
  readonly now: () => EpochMillis;
  readonly schedule: RotationPorts["schedule"];
}

export type ConsoleProbeResult =
  | {
      readonly kind: "needs_login" | "failed" | "no_limits" | "unreadable";
    }
  | { readonly kind: "limits"; readonly limits: readonly LimitWindow[] };

export interface LimitProbeService {
  start(): void;
  trigger(): void;
  release(accountId: string): Promise<void>;
  isBlocked(accountId: string): boolean;
  limitOf(accountId: string): LimitView | null;
  runtimeOf(accountId: string): AccountRuntime | null;
  availabilityOf(account: Account): LimitAvailability;
  onChanged(listener: () => void): () => void;
  dispose(): Promise<void>;
}

export class ProbeStillRunningError extends Error {
  constructor() {
    super("The limit probe for this account is still running");
    this.name = "ProbeStillRunningError";
  }
}

interface ProbeEntry {
  readonly limit: LimitView | null;
  readonly runtime: AccountRuntime | null;
  readonly availability: LimitAvailability;
}

interface InFlightProbe {
  readonly accountId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

const PROBED_PROVIDERS: readonly ProviderId[] = [
  ProviderId.codex,
  ProviderId.gemini,
];
const PENDING_ENTRY: ProbeEntry = {
  limit: null,
  runtime: null,
  availability: LimitAvailability.pending,
};
const UNSUPPORTED_ENTRY: ProbeEntry = {
  limit: null,
  runtime: null,
  availability: LimitAvailability.unsupported,
};
const FAILED_ENTRY: ProbeEntry = {
  limit: null,
  runtime: null,
  availability: LimitAvailability.failed,
};
const NEEDS_LOGIN_ENTRY: ProbeEntry = {
  limit: null,
  runtime: { status: "needs_login" },
  availability: LimitAvailability.pending,
};

type ProbeOutcome<Limits> =
  | { readonly kind: "limits"; readonly limits: Limits }
  | {
      readonly kind:
        "needs_login" | "no_limits" | "unreadable" | "failed" | "unstopped";
    };

function isProbed(account: Account): boolean {
  switch (account.provider) {
    case ProviderId.opencode:
      return account.api?.auth === ApiAuth.consoleLogin;
    case ProviderId.claude:
      return account.api === undefined;
    default:
      return PROBED_PROVIDERS.includes(account.provider);
  }
}

function utilizationRank(window: LimitWindow): number {
  return window.utilization ?? Number.NEGATIVE_INFINITY;
}

function resetRank(window: LimitWindow): number {
  return window.resetsAt ?? Number.NEGATIVE_INFINITY;
}

function strongest(
  windows: readonly LimitWindow[],
  rank: (window: LimitWindow) => number,
): LimitWindow | null {
  return windows.reduce<LimitWindow | null>(
    (best, window) =>
      best === null || rank(window) > rank(best) ? window : best,
    null,
  );
}

function windowsEvent(
  status: string,
  binding: LimitWindow | null,
  windows: readonly LimitWindow[],
): RateLimitEvent {
  return {
    type: "rate_limit",
    status,
    resetsAt: binding?.resetsAt ?? null,
    rateLimitType: binding?.period ?? null,
    utilization: binding?.utilization ?? null,
    windows,
  };
}

function consoleRateLimitEvent(
  windows: readonly LimitWindow[],
): RateLimitEvent {
  return windowsEvent(
    RATE_LIMIT_STATUS_ALLOWED,
    strongest(windows, utilizationRank),
    windows,
  );
}

function claudeRateLimitEvent(windows: readonly LimitWindow[]): RateLimitEvent {
  const exhausted = windows.filter(
    (window) => window.scope === null && window.exhausted,
  );
  return exhausted.length > 0
    ? windowsEvent(
        RATE_LIMIT_STATUS_REJECTED,
        strongest(exhausted, resetRank),
        windows,
      )
    : windowsEvent(
        RATE_LIMIT_STATUS_ALLOWED,
        strongest(windows, utilizationRank),
        windows,
      );
}

function byOrderThenId(left: Account, right: Account): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function exhaustedRuntime(snapshot: LimitSnapshot): AccountRuntime | null {
  return snapshot.status === RATE_LIMIT_STATUS_REJECTED &&
    snapshot.resetsAt !== null
    ? { status: "exhausted", resetsAt: snapshot.resetsAt }
    : null;
}

function limitsEntry(
  event: RateLimitEvent | null,
  accountId: string,
  now: () => EpochMillis,
): ProbeEntry {
  if (event === null) {
    return UNSUPPORTED_ENTRY;
  }
  const detector = createRateLimitDetector(now);
  detector.observe(event);
  const snapshot = detector.snapshot();
  if (snapshot === null) {
    return UNSUPPORTED_ENTRY;
  }
  return {
    limit: {
      accountId,
      ...snapshot,
      windows: [...snapshot.windows],
      observedAt: now(),
    },
    runtime: exhaustedRuntime(snapshot),
    availability: LimitAvailability.reported,
  };
}

function entryFor<Limits>(
  result: ProbeOutcome<Limits>,
  accountId: string,
  now: () => EpochMillis,
  eventOf: (limits: Limits) => RateLimitEvent | null,
): ProbeEntry | null {
  switch (result.kind) {
    case "limits":
      return limitsEntry(eventOf(result.limits), accountId, now);
    case "needs_login":
      return NEEDS_LOGIN_ENTRY;
    case "no_limits":
      return UNSUPPORTED_ENTRY;
    case "unreadable":
      return FAILED_ENTRY;
    case "failed":
    case "unstopped":
      return null;
  }
}

function sameEntry(left: ProbeEntry, right: ProbeEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class LimitProbeEngine implements LimitProbeService {
  private readonly deps: LimitProbeDeps;
  private readonly entries = new Map<string, ProbeEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly unstopped = new Set<string>();
  private inFlight: InFlightProbe | null = null;
  private cancelNext: (() => void) | null = null;
  private running = false;
  private again = false;
  private disposed = false;

  constructor(deps: LimitProbeDeps) {
    this.deps = deps;
  }

  start(): void {
    void this.cycle();
  }

  trigger(): void {
    void this.cycle();
  }

  async release(accountId: string): Promise<void> {
    const current = this.inFlight;
    if (current?.accountId === accountId) {
      current.controller.abort();
      await current.settled;
    }
    if (this.unstopped.has(accountId)) {
      throw new ProbeStillRunningError();
    }
  }

  isBlocked(accountId: string): boolean {
    return this.unstopped.has(accountId);
  }

  limitOf(accountId: string): LimitView | null {
    return this.entries.get(accountId)?.limit ?? null;
  }

  runtimeOf(accountId: string): AccountRuntime | null {
    return this.entries.get(accountId)?.runtime ?? null;
  }

  availabilityOf(account: Account): LimitAvailability {
    if (!isProbed(account)) {
      return LimitAvailability.unsupported;
    }
    return (
      this.entries.get(account.id)?.availability ?? LimitAvailability.pending
    );
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelNext?.();
    this.cancelNext = null;
    const current = this.inFlight;
    current?.controller.abort();
    await current?.settled;
  }

  private async cycle(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.cancelNext?.();
    this.cancelNext = null;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.rerunWanted());
    } catch (error) {
      console.warn("limit probe pass failed", error);
    } finally {
      this.running = false;
    }
    if (!this.isDisposed()) {
      this.cancelNext = this.deps.schedule(
        this.deps.now() + PROBE_INTERVAL_MS,
        () => {
          void this.cycle();
        },
      );
    }
  }

  private rerunWanted(): boolean {
    return this.again && !this.disposed;
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private async pass(): Promise<void> {
    const accounts = (await this.deps.readAccounts())
      .filter(isProbed)
      .toSorted(byOrderThenId);
    let changed = this.dropRemoved(accounts);
    for (const account of accounts) {
      if (this.isDisposed()) {
        return;
      }
      if (!this.unstopped.has(account.id) && !this.deps.isInUse(account.id)) {
        changed = (await this.probeOne(account)) || changed;
      }
    }
    if (changed) {
      this.listeners.forEach((listener) => {
        listener();
      });
    }
  }

  private dropRemoved(accounts: readonly Account[]): boolean {
    const kept = new Set(accounts.map((account) => account.id));
    let changed = false;
    for (const [accountId, entry] of this.entries) {
      if (!kept.has(accountId)) {
        this.entries.delete(accountId);
        changed ||= !sameEntry(entry, PENDING_ENTRY);
      }
    }
    return changed;
  }

  private async runProbe(
    account: Account,
    signal: AbortSignal,
  ): Promise<ProbeEntry | null> {
    try {
      switch (account.provider) {
        case ProviderId.gemini:
          return this.entryOf(
            account,
            await this.deps.agyProbe(account, signal),
            toAgyRateLimitEvent,
          );
        case ProviderId.opencode:
          return this.entryOf(
            account,
            await this.deps.consoleProbe(account, signal),
            consoleRateLimitEvent,
          );
        case ProviderId.claude:
          return this.entryOf(
            account,
            await this.deps.claudeProbe(account, signal),
            claudeRateLimitEvent,
          );
        default:
          return this.entryOf(
            account,
            await this.deps.probe(account, signal),
            toRateLimitEvent,
          );
      }
    } catch (error) {
      console.warn(`limit probe failed: ${account.id}`, error);
      return null;
    }
  }

  private entryOf<Limits>(
    account: Account,
    result: ProbeOutcome<Limits>,
    eventOf: (limits: Limits) => RateLimitEvent | null,
  ): ProbeEntry | null {
    if (result.kind === "unstopped") {
      this.unstopped.add(account.id);
    }
    return entryFor(result, account.id, this.deps.now, eventOf);
  }

  private async probeOne(account: Account): Promise<boolean> {
    const controller = new AbortController();
    const running = this.runProbe(account, controller.signal);
    this.inFlight = {
      accountId: account.id,
      controller,
      settled: running.then(() => undefined),
    };
    const next = await running;
    this.inFlight = null;
    const known = this.entries.get(account.id);
    if (next === null && known !== undefined) {
      return false;
    }
    const stored = next ?? FAILED_ENTRY;
    this.entries.set(account.id, stored);
    return !sameEntry(known ?? PENDING_ENTRY, stored);
  }
}

export function createLimitProbeService(
  deps: LimitProbeDeps,
): LimitProbeService {
  return new LimitProbeEngine(deps);
}
