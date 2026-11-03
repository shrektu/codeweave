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

export interface LaunchOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly windowsVerbatimArguments?: boolean;
}

export interface LaunchedProcess {
  readonly pid: number;
  hasExited(): boolean;
}

export type Launcher<T extends LaunchedProcess> = (
  command: string,
  args: readonly string[],
  options: LaunchOptions,
) => Promise<T>;

export interface ContainerOps {
  members(): Promise<readonly number[]>;
  killMembers(): Promise<void>;
}

export interface Launched<T extends LaunchedProcess> {
  readonly process: T;
  readonly ops: ContainerOps;
}

export interface ProcessContainer {
  readonly kind: ContainerKind;
  launch<T extends LaunchedProcess>(
    spec: SpawnSpec,
    launcher: Launcher<T>,
  ): Promise<Launched<T>>;
  spawn(spec: SpawnSpec): Promise<Contained>;
  sweepOrphans(staleInstanceIds: readonly string[]): Promise<number>;
}

export class ContainerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerUnavailableError";
  }
}
