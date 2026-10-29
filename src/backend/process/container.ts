import type { Readable, Writable } from "node:stream";

export const ContainerKind = {
  systemdScope: "systemd-scope",
  envMarker: "env-marker",
} as const;
export type ContainerKind = (typeof ContainerKind)[keyof typeof ContainerKind];

export const StopFailureReason = {
  notEmptyAfterTimeout: "not_empty_after_timeout",
} as const;

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly runId: string;
  readonly windowsVerbatimArguments?: boolean;
}

export type StopResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: typeof StopFailureReason.notEmptyAfterTimeout;
      readonly survivors: readonly number[];
    };

export type ExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

export interface Contained {
  readonly pid: number;
  readonly runId: string;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  stop(graceMs: number): Promise<StopResult>;
  isEmpty(): Promise<boolean>;
  onExit(listener: ExitListener): void;
}

export interface ProcessContainer {
  readonly kind: ContainerKind;
  spawn(spec: SpawnSpec): Promise<Contained>;
  sweepOrphans(staleInstanceIds: readonly string[]): Promise<number>;
}

export class ContainerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerUnavailableError";
  }
}
