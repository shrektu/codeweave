import type { AgentEvent } from "../domain/events";
import type { Account, PermissionProfile } from "../domain/types";

import type { StopResult } from "./process/container";

export interface AgentStartSpec {
  readonly account: Account;
  readonly cwd: string;
  readonly profile: PermissionProfile;
  readonly runId: string;
  readonly executable: string;
}

export const AgentStartFailure = {
  needsLogin: "needs_login",
  error: "error",
  unavailable: "unavailable",
} as const;
export type AgentStartFailure =
  (typeof AgentStartFailure)[keyof typeof AgentStartFailure];

export interface TurnOptions {
  readonly model: string | null;
}

export interface AgentHandle {
  readonly accountId: string;
  readonly runId: string;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string, options: TurnOptions): Promise<void>;
  answerPermission(requestId: string, optionId: string): void;
  setProfile(profile: PermissionProfile): Promise<void>;
  cancel(): Promise<void>;
  stop(graceMs: number): Promise<StopResult>;
}

export type AgentStartResult =
  | { readonly ok: true; readonly handle: AgentHandle }
  | {
      readonly ok: false;
      readonly reason: AgentStartFailure;
      readonly message: string;
    };

export interface AgentAdapter {
  start(spec: AgentStartSpec): Promise<AgentStartResult>;
}

export class UnknownPermissionError extends Error {
  constructor(requestId: string) {
    super(`No pending permission request: ${requestId}`);
    this.name = "UnknownPermissionError";
  }
}

export class TurnInProgressError extends Error {
  constructor(runId: string) {
    super(`A turn is already running: ${runId}`);
    this.name = "TurnInProgressError";
  }
}

export class InvalidOptionError extends Error {
  constructor(requestId: string, optionId: string) {
    super(`Option ${optionId} is not offered by request ${requestId}`);
    this.name = "InvalidOptionError";
  }
}
