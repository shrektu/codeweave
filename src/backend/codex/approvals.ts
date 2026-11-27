import type { AgentEvent } from "../../domain/events";
import { PROCESS_EXITED_MESSAGE } from "../constants";

import {
  CodexDecision,
  CodexPermissionChoice,
  CodexPermissionScope,
  NEEDS_LOGIN_MESSAGE,
  RPC_CODE_PEER_CLOSED,
} from "./constants";
import type { TurnCompletedParams } from "./protocol";
import { CodexRpcError, type RpcId } from "./rpc";

export type PermissionRequestEvent = Extract<
  AgentEvent,
  { type: "permission_request" }
>;

export interface ApprovalAnswers {
  readonly resultFor: (optionId: string) => unknown;
  readonly declined: unknown;
}

export interface PendingApproval extends ApprovalAnswers {
  readonly rpcId: RpcId;
  readonly optionIds: ReadonlySet<string>;
}

export interface ActiveTurn {
  turnId: string | null;
  readonly idReady: PromiseWithResolvers<string | null>;
  readonly completed: PromiseWithResolvers<TurnCompletedParams>;
}

export class ProcessExitedError extends Error {
  constructor() {
    super(PROCESS_EXITED_MESSAGE);
    this.name = "ProcessExitedError";
  }
}

export class CodexNeedsLoginError extends Error {
  constructor() {
    super(NEEDS_LOGIN_MESSAGE);
    this.name = "CodexNeedsLoginError";
  }
}

export const DECISION_ANSWERS: ApprovalAnswers = {
  resultFor: (optionId) => ({ decision: optionId }),
  declined: { decision: CodexDecision.decline },
};

export const DENIED_PERMISSIONS = {
  permissions: {},
  scope: CodexPermissionScope.turn,
};

export function permissionAnswers(
  requested: Readonly<Record<string, unknown>>,
): ApprovalAnswers {
  return {
    resultFor: (optionId) =>
      optionId === CodexPermissionChoice.grant
        ? { permissions: requested, scope: CodexPermissionScope.turn }
        : DENIED_PERMISSIONS,
    declined: DENIED_PERMISSIONS,
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPeerClosed(error: unknown): boolean {
  return error instanceof CodexRpcError && error.code === RPC_CODE_PEER_CLOSED;
}

export function exitedEvent(): AgentEvent {
  return {
    type: "turn_error",
    errorKind: null,
    rpcCode: null,
    message: PROCESS_EXITED_MESSAGE,
  };
}

export function newActiveTurn(): ActiveTurn {
  return {
    turnId: null,
    idReady: Promise.withResolvers<string | null>(),
    completed: Promise.withResolvers<TurnCompletedParams>(),
  };
}
