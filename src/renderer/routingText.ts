import { ApiProviderId } from "../domain/apiProviders";
import { isAutoModel } from "../domain/modelChoice";
import { MODEL_TIERS } from "../domain/modelTiers";
import { isModelAllowed, RouteSource } from "../domain/routing";
import { TaskClass } from "../domain/taskClass";
import type { AccountView, SessionView, TurnRouteView } from "../shared/views";

export const TASK_CLASS_LABELS: Readonly<Record<TaskClass, string>> = {
  [TaskClass.light]: "Light",
  [TaskClass.standard]: "Standard",
  [TaskClass.heavy]: "Heavy",
};

export const CLI_DEFAULT_MODEL_LABEL = "CLI default";
export const NOT_ROUTED_LABEL = "not routed";
export const OVERRIDE_LABEL = "override";
export const AGENT_MODEL_LABEL = "agent model";
const FALLBACK_SEPARATOR = " → ";
const BADGE_SEPARATOR = " · ";
const API_PROVIDER_SEPARATOR = "/";

export interface TurnBadge {
  readonly text: string;
  readonly description: string;
}

export function servedModel(turn: TurnRouteView): string | null {
  return turn.effectiveModel ?? turn.model;
}

function modelLabel(turn: TurnRouteView): string {
  if (turn.effectiveModel !== null) {
    return turn.effectiveModel;
  }
  const { model } = turn;
  if (model === null) {
    return CLI_DEFAULT_MODEL_LABEL;
  }
  const prefix = `${turn.apiProvider ?? ""}${API_PROVIDER_SEPARATOR}`;
  return turn.apiProvider === null || model.startsWith(prefix)
    ? model
    : `${prefix}${model}`;
}

export function sessionModelText(session: SessionView): string {
  const last = session.turns.at(-1);
  return (
    session.currentModel ??
    (last === undefined ? CLI_DEFAULT_MODEL_LABEL : modelLabel(last))
  );
}

function classLabel(turn: TurnRouteView): string {
  switch (turn.source) {
    case RouteSource.override:
      return OVERRIDE_LABEL;
    case RouteSource.agent:
      return AGENT_MODEL_LABEL;
    case RouteSource.routed:
      return turn.servedClass === null ||
        turn.servedClass === turn.requestedClass
        ? turn.requestedClass
        : `${turn.requestedClass}${FALLBACK_SEPARATOR}${turn.servedClass}`;
    case RouteSource.account:
    case RouteSource.cliDefault:
      return `${turn.requestedClass}${BADGE_SEPARATOR}${NOT_ROUTED_LABEL}`;
  }
}

export function turnBadge(turn: TurnRouteView): TurnBadge {
  const model = modelLabel(turn);
  const classText = classLabel(turn);
  return {
    text: `${model}${BADGE_SEPARATOR}${classText}`,
    description: `This turn used ${model} (${classText})`,
  };
}

export function modelSuggestions(account: AccountView | null): string[] {
  const api = account?.api ?? null;
  if (api === null) {
    return [];
  }
  const modelIds = [
    ...MODEL_TIERS.filter((tier) => tier.provider === api.provider).map(
      (tier) => tier.modelId,
    ),
    api.model,
  ];
  return [...new Set(modelIds)]
    .filter((modelId) => isModelAllowed(api, modelId))
    .map((modelId) => `${api.provider}${API_PROVIDER_SEPARATOR}${modelId}`);
}

export function hasUnknownApiProvider(model: string): boolean {
  const trimmed = model.trim();
  if (trimmed === "" || isAutoModel(trimmed)) {
    return false;
  }
  const prefix = trimmed.split(API_PROVIDER_SEPARATOR)[0] ?? "";
  return !Object.values(ApiProviderId).some((id) => id === prefix);
}
