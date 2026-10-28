import { RATE_LIMIT_STATUS_REJECTED } from "../domain/constants";
import {
  createRateLimitDetector,
  type LimitSnapshot,
} from "../domain/rateLimit";
import type { AccountRuntime, RotationPorts } from "../domain/rotation";
import { ProviderId, type Account, type EpochMillis } from "../domain/types";
import type { LimitView } from "../shared/views";

import { PROBE_INTERVAL_MS } from "./constants";
import { toRateLimitEvent, type RateLimitState } from "./codex/events";
import type { ProbeResult } from "./codex/probe";

export interface LimitProbeDeps {
  readonly readAccounts: () => Promise<readonly Account[]>;
  readonly probe: (
    account: Account,
    signal: AbortSignal,
  ) => Promise<ProbeResult>;
  readonly isInUse: (accountId: string) => boolean;
  readonly now: () => EpochMillis;
  readonly schedule: RotationPorts["schedule"];
}

export interface LimitProbeService {
  start(): void;
  trigger(): void;
  release(accountId: string): Promise<void>;
  isBlocked(accountId: string): boolean;
  limitOf(accountId: string): LimitView | null;
  runtimeOf(accountId: string): AccountRuntime | null;
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
}

interface InFlightProbe {
  readonly accountId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

const EMPTY_ENTRY: ProbeEntry = { limit: null, runtime: null };
const NEEDS_LOGIN_ENTRY: ProbeEntry = {
  limit: null,
  runtime: { status: "needs_login" },
};
const FAILED_RESULT: ProbeResult = { kind: "failed" };

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
  limits: RateLimitState,
  accountId: string,
  now: () => EpochMillis,
): ProbeEntry {
  const event = toRateLimitEvent(limits);
  if (event === null) {
    return EMPTY_ENTRY;
  }
  const detector = createRateLimitDetector(now);
  detector.observe(event);
  const snapshot = detector.snapshot();
  if (snapshot === null) {
    return EMPTY_ENTRY;
  }
  return {
    limit: { accountId, ...snapshot, observedAt: now() },
    runtime: exhaustedRuntime(snapshot),
  };
}

function entryFor(
  result: ProbeResult,
  accountId: string,
  now: () => EpochMillis,
): ProbeEntry | null {
  switch (result.kind) {
    case "limits":
      return limitsEntry(result.limits, accountId, now);
    case "needs_login":
      return NEEDS_LOGIN_ENTRY;
    case "no_limits":
      return EMPTY_ENTRY;
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
      .filter((account) => account.provider === ProviderId.codex)
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
        changed ||= !sameEntry(entry, EMPTY_ENTRY);
      }
    }
    return changed;
  }

  private async runProbe(
    account: Account,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    try {
      const result = await this.deps.probe(account, signal);
      if (result.kind === "unstopped") {
        this.unstopped.add(account.id);
      }
      return result;
    } catch (error) {
      console.warn(`limit probe failed: ${account.id}`, error);
      return FAILED_RESULT;
    }
  }

  private async probeOne(account: Account): Promise<boolean> {
    const controller = new AbortController();
    const running = this.runProbe(account, controller.signal);
    this.inFlight = {
      accountId: account.id,
      controller,
      settled: running.then(() => undefined),
    };
    const result = await running;
    this.inFlight = null;
    const next = entryFor(result, account.id, this.deps.now);
    if (next === null) {
      return false;
    }
    const previous = this.entries.get(account.id) ?? EMPTY_ENTRY;
    this.entries.set(account.id, next);
    return !sameEntry(previous, next);
  }
}

export function createLimitProbeService(
  deps: LimitProbeDeps,
): LimitProbeService {
  return new LimitProbeEngine(deps);
}
