import {
  MS_PER_SECOND,
  OLD_PROCESS_STILL_RUNNING,
  PORT_CALL_FAILED,
  UNKNOWN_ERROR,
} from "./constants";
import type { TurnOutcome } from "./rateLimit";
import {
  SwitchReason,
  type Account,
  type EpochMillis,
  type EpochSeconds,
  type SwitchLogEntry,
} from "./types";

export type AccountRuntime =
  | { readonly status: "ready" }
  | { readonly status: "exhausted"; readonly resetsAt: EpochSeconds }
  | { readonly status: "needs_login" };

export type RotationDecision =
  | { readonly kind: "stay" }
  | {
      readonly kind: "switch";
      readonly to: string;
      readonly reason: SwitchReason;
    }
  | {
      readonly kind: "wait";
      readonly accountId: string;
      readonly until: EpochSeconds;
    }
  | { readonly kind: "halt"; readonly reason: "no_usable_accounts" };

export interface DecideInput {
  readonly accounts: readonly Account[];
  readonly runtime: ReadonlyMap<string, AccountRuntime>;
  readonly current: string;
  readonly outcome: TurnOutcome;
  readonly now: EpochMillis;
  readonly excluded?: ReadonlySet<string>;
}

function effectiveRuntime(
  input: DecideInput,
  account: Account,
): AccountRuntime {
  if (account.id === input.current) {
    if (input.outcome.kind === "exhausted") {
      return { status: "exhausted", resetsAt: input.outcome.resetsAt };
    }
    if (input.outcome.kind === "needs_login") {
      return { status: "needs_login" };
    }
  }
  return input.runtime.get(account.id) ?? { status: "ready" };
}

function isReady(runtime: AccountRuntime, now: EpochMillis): boolean {
  return (
    runtime.status === "ready" ||
    (runtime.status === "exhausted" && runtime.resetsAt * MS_PER_SECOND <= now)
  );
}

function byOrderThenId(left: Account, right: Account): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function pickWait(
  input: DecideInput,
): Extract<RotationDecision, { kind: "wait" }> | null {
  const exhausted = input.accounts
    .toSorted(byOrderThenId)
    .flatMap((account) => {
      const runtime = effectiveRuntime(input, account);
      return runtime.status === "exhausted" &&
        runtime.resetsAt * MS_PER_SECOND > input.now
        ? [{ accountId: account.id, until: runtime.resetsAt }]
        : [];
    })
    .toSorted((left, right) => left.until - right.until);
  const earliest = exhausted[0];
  return earliest ? { kind: "wait", ...earliest } : null;
}

export function decideNext(input: DecideInput): RotationDecision {
  const { outcome } = input;
  if (outcome.kind === "ok" || outcome.kind === "failed") {
    return { kind: "stay" };
  }
  const next = input.accounts
    .filter(
      (account) =>
        account.id !== input.current &&
        !input.excluded?.has(account.id) &&
        isReady(effectiveRuntime(input, account), input.now),
    )
    .toSorted(byOrderThenId)[0];
  if (next) {
    const reason =
      outcome.kind === "exhausted"
        ? SwitchReason.rateLimit
        : SwitchReason.needsLogin;
    return { kind: "switch", to: next.id, reason };
  }
  return pickWait(input) ?? { kind: "halt", reason: "no_usable_accounts" };
}

export type StartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "needs_login" | "error" };

export interface RotationPorts {
  readonly stopAgent: (accountId: string) => Promise<{ ok: boolean }>;
  readonly startAgent: (accountId: string) => Promise<StartResult>;
  readonly sendPrompt: (
    accountId: string,
    text: string,
  ) => Promise<TurnOutcome>;
  readonly buildContextPackage: () => Promise<string>;
  readonly appendSwitchLog: (entry: SwitchLogEntry) => Promise<void>;
  readonly schedule: (atMillis: EpochMillis, run: () => void) => () => void;
  readonly now: () => EpochMillis;
}

export type RotationPhase =
  | { readonly phase: "running"; readonly accountId: string }
  | {
      readonly phase: "switching";
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly phase: "waiting";
      readonly accountId: string;
      readonly until: EpochSeconds;
    }
  | {
      readonly phase: "failed";
      readonly reason: string;
      readonly runningAccountId: string | null;
    }
  | { readonly phase: "halted" }
  | { readonly phase: "stopped" };

export interface RotationController {
  readonly phase: () => RotationPhase;
  readonly runtime: () => ReadonlyMap<string, AccountRuntime>;
  readonly subscribe: (listener: (phase: RotationPhase) => void) => () => void;
  readonly onTurnSettled: (
    accountId: string,
    outcome: TurnOutcome,
  ) => Promise<void>;
  readonly dispose: () => void;
}

type SwitchDecision = Extract<RotationDecision, { kind: "switch" }>;

interface ForcedSwitch {
  readonly decision: SwitchDecision;
  readonly resetsAt: EpochSeconds;
}

interface Chain {
  from: string;
  outcome: TurnOutcome;
  stopped: boolean;
  marked: boolean;
  readonly tried: Set<string>;
  forced?: ForcedSwitch;
}

type Activation =
  | { readonly kind: "settled"; readonly outcome: TurnOutcome }
  | { readonly kind: "retry" }
  | { readonly kind: "abort" };

function needsRotation(outcome: TurnOutcome): boolean {
  return outcome.kind === "exhausted" || outcome.kind === "needs_login";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : UNKNOWN_ERROR;
}

class RotationEngine implements RotationController {
  private readonly runtimeByAccount = new Map<string, AccountRuntime>();
  private readonly listeners = new Set<(phase: RotationPhase) => void>();
  private readonly ports: RotationPorts;
  private readonly accounts: readonly Account[];
  private readonly sessionId: string;
  private current: string;
  private state: RotationPhase;
  private busy = false;
  private disposed = false;
  private running: string | null;
  private cancelWait: (() => void) | null = null;

  constructor(
    ports: RotationPorts,
    accounts: readonly Account[],
    initial: string,
    sessionId: string,
  ) {
    this.ports = ports;
    this.accounts = accounts;
    this.sessionId = sessionId;
    this.current = initial;
    this.running = initial;
    this.state = { phase: "running", accountId: initial };
  }

  phase(): RotationPhase {
    return this.state;
  }

  runtime(): ReadonlyMap<string, AccountRuntime> {
    return this.runtimeByAccount;
  }

  subscribe(listener: (phase: RotationPhase) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async onTurnSettled(accountId: string, outcome: TurnOutcome): Promise<void> {
    if (
      this.busy ||
      this.state.phase !== "running" ||
      accountId !== this.current
    ) {
      return;
    }
    await this.exclusively(() =>
      this.drive({
        from: this.current,
        outcome,
        stopped: false,
        marked: false,
        tried: new Set(),
      }),
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelWait?.();
    this.cancelWait = null;
    this.setPhase({ phase: "stopped" });
  }

  private async exclusively(work: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await work();
    } catch (error: unknown) {
      this.fail(`${PORT_CALL_FAILED}: ${errorMessage(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private fail(reason: string): void {
    this.setPhase({ phase: "failed", reason, runningAccountId: this.running });
  }

  private setPhase(next: RotationPhase): void {
    if (this.disposed && next.phase !== "stopped") {
      return;
    }
    this.state = next;
    this.listeners.forEach((listener) => {
      listener(next);
    });
  }

  private mark(accountId: string, outcome: TurnOutcome): void {
    if (outcome.kind === "exhausted") {
      this.runtimeByAccount.set(accountId, {
        status: "exhausted",
        resetsAt: outcome.resetsAt,
      });
    } else if (outcome.kind === "needs_login") {
      this.runtimeByAccount.set(accountId, { status: "needs_login" });
    }
  }

  private async drive(start: Chain): Promise<void> {
    let chain: Chain | null = start;
    while (
      chain !== null &&
      !this.isDisposed() &&
      needsRotation(chain.outcome)
    ) {
      chain = await this.step(chain);
    }
  }

  private async step(chain: Chain): Promise<Chain | null> {
    if (!chain.marked) {
      this.mark(chain.from, chain.outcome);
      chain.marked = true;
    }
    chain.tried.add(chain.from);
    const decision =
      chain.forced?.decision ??
      decideNext({
        accounts: this.accounts,
        runtime: this.runtimeByAccount,
        current: chain.from,
        outcome: chain.outcome,
        now: this.ports.now(),
        excluded: chain.tried,
      });
    if (decision.kind === "stay") {
      return null;
    }
    if (decision.kind === "halt") {
      await this.logWithoutTarget(chain);
      this.setPhase({ phase: "halted" });
      return null;
    }
    if (!(await this.ensureStopped(chain)) || this.isDisposed()) {
      return null;
    }
    if (decision.kind === "wait") {
      await this.logWithoutTarget(chain);
      if (!this.isDisposed()) {
        this.beginWait(chain, decision.accountId, decision.until);
      }
      return null;
    }
    return this.switchTo(chain, decision);
  }

  private async logWithoutTarget(chain: Chain): Promise<void> {
    const { outcome } = chain;
    await this.ports.appendSwitchLog({
      at: this.ports.now(),
      sessionId: this.sessionId,
      from: chain.from,
      to: null,
      reason:
        outcome.kind === "exhausted"
          ? SwitchReason.rateLimit
          : SwitchReason.needsLogin,
      resetsAt: outcome.kind === "exhausted" ? outcome.resetsAt : null,
      contextPackageChars: 0,
    });
  }

  private async ensureStopped(chain: Chain): Promise<boolean> {
    if (chain.stopped) {
      return true;
    }
    const result = await this.ports.stopAgent(chain.from);
    if (!result.ok) {
      this.fail(OLD_PROCESS_STILL_RUNNING);
      return false;
    }
    chain.stopped = true;
    this.running = null;
    return true;
  }

  private async switchTo(
    chain: Chain,
    decision: SwitchDecision,
  ): Promise<Chain | null> {
    const resetsAt =
      chain.forced?.resetsAt ??
      (chain.outcome.kind === "exhausted" ? chain.outcome.resetsAt : null);
    const result = await this.activate(chain, decision, resetsAt);
    if (result.kind === "abort") {
      return null;
    }
    if (result.kind === "retry") {
      delete chain.forced;
      return chain;
    }
    return {
      from: decision.to,
      outcome: result.outcome,
      stopped: false,
      marked: false,
      tried: chain.tried,
    };
  }

  private async activate(
    chain: Chain,
    decision: SwitchDecision,
    resetsAt: EpochSeconds | null,
  ): Promise<Activation> {
    this.setPhase({ phase: "switching", from: chain.from, to: decision.to });
    const started = await this.ports.startAgent(decision.to);
    if (started.ok) {
      this.current = decision.to;
      this.running = decision.to;
    }
    if (this.isDisposed()) {
      return this.abortStarted(started.ok ? decision.to : null);
    }
    if (!started.ok) {
      if (started.reason === "needs_login") {
        this.runtimeByAccount.set(decision.to, { status: "needs_login" });
        chain.tried.add(decision.to);
        return { kind: "retry" };
      }
      this.fail(`failed to start ${decision.to}`);
      return { kind: "abort" };
    }
    try {
      const result = await this.handOff(chain, decision, resetsAt);
      return result.kind === "abort"
        ? await this.abortStarted(decision.to)
        : result;
    } catch (error: unknown) {
      await this.abortStarted(decision.to);
      this.fail(`${PORT_CALL_FAILED}: ${errorMessage(error)}`);
      return { kind: "abort" };
    }
  }

  private async handOff(
    chain: Chain,
    decision: SwitchDecision,
    resetsAt: EpochSeconds | null,
  ): Promise<Activation> {
    const text = await this.ports.buildContextPackage();
    if (this.isDisposed()) {
      return { kind: "abort" };
    }
    await this.ports.appendSwitchLog({
      at: this.ports.now(),
      sessionId: this.sessionId,
      from: chain.from,
      to: decision.to,
      reason: decision.reason,
      resetsAt,
      contextPackageChars: text.length,
    });
    if (this.isDisposed()) {
      return { kind: "abort" };
    }
    this.setPhase({ phase: "running", accountId: decision.to });
    const outcome = await this.ports.sendPrompt(decision.to, text);
    return this.isDisposed() ? { kind: "abort" } : { kind: "settled", outcome };
  }

  private async abortStarted(accountId: string | null): Promise<Activation> {
    if (accountId !== null && (await this.tryStop(accountId))) {
      this.running = null;
    }
    return { kind: "abort" };
  }

  private async tryStop(accountId: string): Promise<boolean> {
    try {
      return (await this.ports.stopAgent(accountId)).ok;
    } catch (error: unknown) {
      console.error(`failed to stop ${accountId}`, error);
      return false;
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private beginWait(
    chain: Chain,
    accountId: string,
    until: EpochSeconds,
  ): void {
    this.setPhase({ phase: "waiting", accountId, until });
    this.cancelWait = this.ports.schedule(until * MS_PER_SECOND, () => {
      void this.resume(chain, accountId, until);
    });
  }

  private async resume(
    chain: Chain,
    accountId: string,
    until: EpochSeconds,
  ): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    this.cancelWait = null;
    await this.exclusively(async () => {
      this.runtimeByAccount.set(accountId, { status: "ready" });
      await this.drive({
        from: chain.from,
        outcome: chain.outcome,
        stopped: true,
        marked: true,
        tried: new Set(),
        forced: {
          decision: {
            kind: "switch",
            to: accountId,
            reason: SwitchReason.resetReached,
          },
          resetsAt: until,
        },
      });
    });
  }
}

export function createRotationController(
  ports: RotationPorts,
  accounts: readonly Account[],
  initial: string,
  sessionId: string,
): RotationController {
  return new RotationEngine(ports, accounts, initial, sessionId);
}
