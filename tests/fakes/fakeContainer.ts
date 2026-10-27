import { PassThrough } from "node:stream";

import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
  StopResult,
} from "../../src/backend/process/container";

type ExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

export class FakeContained implements Contained {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stopCalls: number[] = [];
  private readonly listeners: ExitListener[] = [];
  private readonly pendingResults: StopResult[];
  private readonly heldStops: (() => void)[] = [];
  private manualStops = false;

  readonly runId: string;

  constructor(runId: string, stopResults: readonly StopResult[]) {
    this.runId = runId;
    this.pendingResults = [...stopResults];
  }

  stop(graceMs: number): Promise<StopResult> {
    this.stopCalls.push(graceMs);
    const result = this.pendingResults.shift() ?? { ok: true };
    if (!this.manualStops) {
      return Promise.resolve(result);
    }
    return new Promise((resolve) => {
      this.heldStops.push(() => {
        resolve(result);
      });
    });
  }

  holdStops(): void {
    this.manualStops = true;
  }

  resolveOldestHeldStop(): void {
    this.heldStops.shift()?.();
  }

  resolveHeldStops(): void {
    for (const resolve of this.heldStops.splice(0)) {
      resolve();
    }
  }

  isEmpty(): Promise<boolean> {
    return Promise.resolve(this.pendingResults.length === 0);
  }

  onExit(listener: ExitListener): void {
    this.listeners.push(listener);
  }

  emitExit(code: number | null): void {
    for (const listener of this.listeners) {
      listener(code, null);
    }
  }
}

export class FakeContainer implements ProcessContainer {
  readonly kind = "env-marker";
  readonly spawned: FakeContained[] = [];

  private readonly stopResults: readonly StopResult[];
  private manualStops = false;

  constructor(stopResults: readonly StopResult[]) {
    this.stopResults = stopResults;
  }

  holdStops(): void {
    this.manualStops = true;
  }

  spawn(spec: SpawnSpec): Promise<Contained> {
    const contained = new FakeContained(spec.runId, this.stopResults);
    if (this.manualStops) {
      contained.holdStops();
    }
    this.spawned.push(contained);
    return Promise.resolve(contained);
  }

  sweepOrphans(): Promise<number> {
    return Promise.resolve(0);
  }
}
