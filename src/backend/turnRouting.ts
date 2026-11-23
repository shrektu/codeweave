import type { ModelChoice } from "../domain/modelChoice";
import { resolveTaskClass, routeTurn } from "../domain/routing";
import {
  recordTurnRoute,
  reservePromptSeq,
  type SessionState,
  type TurnRouteEntry,
} from "../domain/sessionReducer";
import type { TaskClass } from "../domain/taskClass";
import type { Account } from "../domain/types";
import type { ParamsMap } from "../shared/protocol";

export type PromptOverrides = Pick<
  ParamsMap["session/prompt"],
  "taskClass" | "model"
>;

export interface TurnRoutingSpec {
  readonly taskClass: TaskClass | null;
  readonly model: ModelChoice | null;
  readonly defaultTaskClass: TaskClass;
}

export interface TurnRouteInput {
  readonly account: Account;
  readonly spec: TurnRoutingSpec;
  readonly overrides: PromptOverrides;
  readonly promptSeq: number;
}

export interface SessionTurnRoute {
  readonly model: string | null;
  readonly entry: TurnRouteEntry;
}

export interface CurrentPrompt {
  readonly seq: number;
  readonly overrides: PromptOverrides;
}

export interface BegunPrompt {
  readonly state: SessionState;
  readonly prompt: CurrentPrompt;
}

export interface RecordedTurn {
  readonly state: SessionState;
  readonly model: string | null;
}

export interface RecordTurnInput {
  readonly state: SessionState;
  readonly accounts: readonly Account[];
  readonly accountId: string;
  readonly spec: TurnRoutingSpec;
  readonly prompt: CurrentPrompt;
}

export const NO_PROMPT: CurrentPrompt = { seq: 0, overrides: {} };

export function beginPrompt(
  state: SessionState,
  overrides: PromptOverrides,
): BegunPrompt {
  const reserved = reservePromptSeq(state);
  return {
    state: reserved.state,
    prompt: { seq: reserved.seq, overrides },
  };
}

export function routeSessionTurn(input: TurnRouteInput): SessionTurnRoute {
  const { account, spec, overrides, promptSeq } = input;
  const taskClass = resolveTaskClass(
    [overrides.taskClass, spec.taskClass],
    spec.defaultTaskClass,
  );
  const route = routeTurn({
    account,
    taskClass,
    override: overrides.model ?? null,
    agentModel: spec.model,
  });
  return {
    model: route.model,
    entry: {
      promptSeq,
      accountId: account.id,
      model: route.model,
      effectiveModel: null,
      apiProvider: account.api?.provider ?? null,
      requestedClass: route.requestedClass,
      servedClass: route.servedClass,
      source: route.source,
    },
  };
}

export function recordTurn(input: RecordTurnInput): RecordedTurn {
  const { state, accountId, prompt } = input;
  const account = input.accounts.find((item) => item.id === accountId);
  if (account === undefined) {
    return { state, model: null };
  }
  const route = routeSessionTurn({
    account,
    spec: input.spec,
    overrides: prompt.overrides,
    promptSeq: prompt.seq,
  });
  const entry =
    route.model === null
      ? { ...route.entry, effectiveModel: state.currentModel }
      : route.entry;
  return {
    state: recordTurnRoute(state, entry),
    model: route.model,
  };
}
