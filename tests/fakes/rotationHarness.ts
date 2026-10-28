import type { AgentEvent } from "../../src/domain/events";
import type {
  RateLimitDetector,
  TurnOutcome,
} from "../../src/domain/rateLimit";
import type {
  RotationController,
  RotationPorts,
  StartResult,
} from "../../src/domain/rotation";
import type {
  Account,
  EpochMillis,
  SwitchLogEntry,
} from "../../src/domain/types";

export interface PromptRecord {
  readonly accountId: string;
  readonly text: string;
}

export interface ScheduledTask {
  readonly at: EpochMillis;
  readonly run: () => void;
  cancelled: boolean;
}

export interface HarnessOptions {
  readonly now: EpochMillis;
  readonly stopOk?: boolean;
  readonly stopOkByAccount?: Readonly<Record<string, boolean>>;
  readonly startResults?: Readonly<Record<string, StartResult>>;
  readonly promptOutcomes?: Readonly<Record<string, readonly TurnOutcome[]>>;
  readonly contextPackage?: () => string;
  readonly holdPrompts?: boolean;
}

export type RejectablePort =
  | "stopAgent"
  | "startAgent"
  | "buildContextPackage"
  | "sendPrompt"
  | "appendSwitchLog";

export interface Harness {
  readonly ports: RotationPorts;
  readonly calls: string[];
  readonly prompts: PromptRecord[];
  readonly switchLog: SwitchLogEntry[];
  readonly scheduled: ScheduledTask[];
  advanceTo: (at: EpochMillis) => void;
  failNext: (port: RejectablePort, error: Error, skip?: number) => void;
  setStartResult: (accountId: string, result: StartResult) => void;
  releasePrompt: (outcome?: TurnOutcome) => void;
}

export interface UnhandledRejections {
  readonly reasons: unknown[];
  readonly stop: () => void;
}

export function trackUnhandledRejections(): UnhandledRejections {
  const reasons: unknown[] = [];
  const listener = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    reasons,
    stop: () => {
      process.off("unhandledRejection", listener);
    },
  };
}

export function flushUnhandled(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export const ACCOUNTS: readonly Account[] = [
  { id: "A", provider: "claude", label: "A", configDir: "/cfg/a", order: 1 },
  { id: "B", provider: "claude", label: "B", configDir: "/cfg/b", order: 2 },
  { id: "C", provider: "claude", label: "C", configDir: "/cfg/c", order: 3 },
];

export const DEFAULT_PACKAGE = "CONTEXT PACKAGE";
export const INITIAL_ACCOUNT = "A";

export function createHarness(options: HarnessOptions): Harness {
  let now = options.now;
  const calls: string[] = [];
  const prompts: PromptRecord[] = [];
  const switchLog: SwitchLogEntry[] = [];
  const scheduled: ScheduledTask[] = [];
  const remaining = copyOutcomes(options);
  const failures = new Map<RejectablePort, { error: Error; skip: number }>();
  const startResults = new Map(Object.entries(options.startResults ?? {}));
  const heldPrompts: ((outcome: TurnOutcome) => void)[] = [];

  function respond<T>(port: RejectablePort, value: () => T): Promise<T> {
    const failure = failures.get(port);
    if (failure && failure.skip > 0) {
      failure.skip -= 1;
    } else if (failure) {
      failures.delete(port);
      return Promise.reject(failure.error);
    }
    return Promise.resolve(value());
  }

  const ports: RotationPorts = {
    stopAgent: (accountId) => {
      calls.push(`stop:${accountId}`);
      return respond("stopAgent", () => ({
        ok: options.stopOkByAccount?.[accountId] ?? options.stopOk ?? true,
      }));
    },
    startAgent: (accountId) => {
      calls.push(`start:${accountId}`);
      return respond(
        "startAgent",
        (): StartResult => startResults.get(accountId) ?? { ok: true },
      );
    },
    sendPrompt: (accountId, text) => {
      calls.push(`prompt:${accountId}`);
      prompts.push({ accountId, text });
      if (options.holdPrompts && !failures.has("sendPrompt")) {
        return new Promise<TurnOutcome>((resolve) => {
          heldPrompts.push(resolve);
        });
      }
      return respond(
        "sendPrompt",
        (): TurnOutcome => remaining.get(accountId)?.shift() ?? { kind: "ok" },
      );
    },
    buildContextPackage: () => {
      calls.push("package");
      return respond(
        "buildContextPackage",
        () => options.contextPackage?.() ?? DEFAULT_PACKAGE,
      );
    },
    appendSwitchLog: (entry) => {
      calls.push("log");
      switchLog.push(entry);
      return respond("appendSwitchLog", () => undefined);
    },
    schedule: (at, run) => {
      const task: ScheduledTask = { at, run, cancelled: false };
      scheduled.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    now: () => now,
  };

  return {
    ports,
    calls,
    prompts,
    switchLog,
    scheduled,
    advanceTo: (at) => {
      now = at;
      runDue(scheduled, at);
    },
    failNext: (port, error, skip = 0) => {
      failures.set(port, { error, skip });
    },
    setStartResult: (accountId, result) => {
      startResults.set(accountId, result);
    },
    releasePrompt: (outcome = { kind: "ok" }) => {
      heldPrompts.shift()?.(outcome);
    },
  };
}

function runDue(tasks: readonly ScheduledTask[], at: EpochMillis): void {
  for (const task of tasks) {
    if (!task.cancelled && task.at <= at) {
      task.cancelled = true;
      task.run();
    }
  }
}

function copyOutcomes(options: HarnessOptions): Map<string, TurnOutcome[]> {
  return new Map(
    Object.entries(options.promptOutcomes ?? {}).map(([id, outcomes]) => [
      id,
      [...outcomes],
    ]),
  );
}

export function rateLimitEvent(status: string, resetsAt: unknown): AgentEvent {
  return {
    type: "rate_limit",
    status,
    resetsAt,
    rateLimitType: "five_hour",
    utilization: 1,
  };
}

export const RATE_LIMIT_ERROR: AgentEvent = {
  type: "turn_error",
  errorKind: "rate_limit",
  rpcCode: null,
  message: "usage limit reached",
};

export const TURN_END: AgentEvent = {
  type: "turn_end",
  stopReason: "end_turn",
};

export async function driveTurn(
  detector: RateLimitDetector,
  controller: RotationController,
  events: readonly AgentEvent[],
  accountId = INITIAL_ACCOUNT,
): Promise<void> {
  for (const event of events) {
    detector.observe(event);
  }
  await controller.onTurnSettled(accountId, detector.settle());
}
