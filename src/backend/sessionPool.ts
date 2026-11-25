import { mergeRuntime, type AccountRuntime } from "../domain/rotation";
import type { Account, EpochMillis } from "../domain/types";
import type { SessionView } from "../shared/views";

import { createAccountReservations } from "./accountReservations";
import {
  createSessionService,
  type SessionService,
  type SessionServiceDeps,
} from "./session";

export type SessionPoolDeps = Omit<
  SessionServiceDeps,
  "publishView" | "reserved"
> & {
  readonly onMainView?: (view: SessionView | null) => void;
  readonly onRunView?: (runId: string, view: SessionView | null) => void;
};

export interface RunSessionView {
  readonly runId: string;
  readonly view: SessionView;
}

export interface SessionPool {
  readonly main: SessionService;
  forRun(runId: string): SessionService;
  release(runId: string): Promise<void>;
  isInUse(accountId: string): boolean;
  runtimeOf(accountId: string): AccountRuntime;
  runViews(): readonly RunSessionView[];
  onRuntimeChanged(listener: () => void): () => void;
  setAccounts(accounts: readonly Account[]): void;
  shutdown(): Promise<void>;
}

export function combineRuntimes(
  own: readonly AccountRuntime[],
  external: AccountRuntime | null,
  now: EpochMillis,
): AccountRuntime {
  const needsLogin = own.find((runtime) => runtime.status === "needs_login");
  const merged =
    needsLogin ??
    own.reduce<AccountRuntime | null>(
      (combined, runtime) => mergeRuntime(combined, runtime, now),
      null,
    );
  return mergeRuntime(merged, external, now);
}

class SessionPoolImpl implements SessionPool {
  readonly main: SessionService;
  private readonly deps: SessionPoolDeps;
  private readonly reserved = createAccountReservations();
  private readonly runs = new Map<string, SessionService>();
  private readonly listeners = new Set<() => void>();

  constructor(deps: SessionPoolDeps) {
    this.deps = deps;
    this.main = this.build((view) => {
      deps.broadcast("session/changed", view);
      deps.onMainView?.(view);
    });
  }

  forRun(runId: string): SessionService {
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const created: SessionService = this.build((view) => {
      if (this.runs.get(runId) === created) {
        this.deps.broadcast("flowSession/changed", { runId, view });
        this.deps.onRunView?.(runId, view);
      }
    });
    this.runs.set(runId, created);
    return created;
  }

  async release(runId: string): Promise<void> {
    const instance = this.runs.get(runId);
    if (instance === undefined) {
      return;
    }
    try {
      await instance.shutdown();
    } finally {
      this.runs.delete(runId);
      this.deps.broadcast("flowSession/changed", { runId, view: null });
      this.notify();
    }
  }

  isInUse(accountId: string): boolean {
    return this.instances().some((instance) => instance.isInUse(accountId));
  }

  runtimeOf(accountId: string): AccountRuntime {
    const own = this.instances().flatMap((instance) => {
      const runtime = instance.ownRuntimeOf(accountId);
      return runtime === null ? [] : [runtime];
    });
    return combineRuntimes(
      own,
      this.deps.externalRuntime(accountId),
      this.deps.now(),
    );
  }

  runViews(): readonly RunSessionView[] {
    return [...this.runs].flatMap(([runId, instance]) => {
      const view = instance.view();
      return view === null ? [] : [{ runId, view }];
    });
  }

  onRuntimeChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setAccounts(accounts: readonly Account[]): void {
    this.instances().forEach((instance) => {
      instance.setAccounts(accounts);
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.instances().map((instance) => instance.shutdown()));
    this.runs.clear();
  }

  private instances(): SessionService[] {
    return [this.main, ...this.runs.values()];
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      listener();
    });
  }

  private build(
    publishView: (view: SessionView | null) => void,
  ): SessionService {
    const service = createSessionService({
      ...this.deps,
      reserved: this.reserved,
      publishView,
    });
    service.onRuntimeChanged(() => {
      this.notify();
    });
    return service;
  }
}

export function createSessionPool(deps: SessionPoolDeps): SessionPool {
  return new SessionPoolImpl(deps);
}
