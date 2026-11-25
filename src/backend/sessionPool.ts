import { mergeRuntime, type AccountRuntime } from "../domain/rotation";
import type { Account, EpochMillis } from "../domain/types";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type { SessionView } from "../shared/views";

import { createAccountReservations } from "./accountReservations";
import {
  createSessionService,
  type SessionService,
  type SessionServiceDeps,
} from "./session";

const SESSION_NOT_FOUND_MESSAGE = "Session not found";
const LIVE_SESSION_CLOSE_MESSAGE = "Cannot close a live session";
const SETTLEABLE_PHASES: readonly SessionView["phase"]["phase"][] = ["halted"];

function hasLingeringAgent(service: SessionService): boolean {
  const phase = service.view()?.phase.phase;
  return phase !== undefined && SETTLEABLE_PHASES.includes(phase);
}

export type SessionPoolDeps = Omit<
  SessionServiceDeps,
  "publishView" | "reserved"
> & {
  readonly onMainView?: (view: SessionView | null) => void;
  readonly onMainClosed?: (sessionId: string) => void;
  readonly onRunView?: (runId: string, view: SessionView | null) => void;
};

export interface RunSessionView {
  readonly runId: string;
  readonly view: SessionView;
}

export interface SessionPool {
  createMain(): SessionService;
  discardMain(service: SessionService): Promise<void>;
  main(sessionId: string): SessionService | null;
  mainViews(): readonly SessionView[];
  anyMainLive(): boolean;
  settleEnded(): Promise<void> | null;
  closeMain(sessionId: string): Promise<void>;
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
  private readonly deps: SessionPoolDeps;
  private readonly reserved = createAccountReservations();
  private readonly mains = new Set<SessionService>();
  private readonly runs = new Map<string, SessionService>();
  private readonly listeners = new Set<() => void>();
  private settling = 0;

  constructor(deps: SessionPoolDeps) {
    this.deps = deps;
  }

  createMain(): SessionService {
    const service: SessionService = this.build((view) => {
      if (this.mains.has(service)) {
        this.deps.broadcast("session/changed", view);
        this.deps.onMainView?.(view);
      }
    });
    this.mains.add(service);
    return service;
  }

  async discardMain(service: SessionService): Promise<void> {
    this.mains.delete(service);
    try {
      await service.shutdown();
    } finally {
      this.notify();
    }
  }

  main(sessionId: string): SessionService | null {
    for (const service of this.mains) {
      if (service.view()?.id === sessionId) {
        return service;
      }
    }
    return null;
  }

  mainViews(): readonly SessionView[] {
    return [...this.mains].flatMap((service) => {
      const view = service.view();
      return view === null ? [] : [view];
    });
  }

  anyMainLive(): boolean {
    return (
      this.settling > 0 || [...this.mains].some((service) => service.isLive())
    );
  }

  settleEnded(): Promise<void> | null {
    const lingering = [...this.mains].filter(hasLingeringAgent);
    if (lingering.length === 0) {
      return null;
    }
    this.settling += 1;
    return this.settleAll(lingering);
  }

  private async settleAll(lingering: readonly SessionService[]): Promise<void> {
    try {
      await Promise.all(lingering.map((service) => service.stop()));
    } finally {
      this.settling -= 1;
    }
  }

  async closeMain(sessionId: string): Promise<void> {
    const service = this.main(sessionId);
    if (service === null) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, SESSION_NOT_FOUND_MESSAGE);
    }
    if (service.isLive()) {
      throw new IpcError(IpcErrorCode.CONFLICT, LIVE_SESSION_CLOSE_MESSAGE);
    }
    this.mains.delete(service);
    try {
      await service.shutdown();
    } finally {
      this.deps.broadcast("session/removed", { sessionId });
      this.deps.onMainClosed?.(sessionId);
      this.notify();
    }
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
    return [...this.mains, ...this.runs.values()];
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
