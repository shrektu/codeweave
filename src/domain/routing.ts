import { API_PROVIDERS, ApiTier, FreeModels } from "./apiProviders";
import {
  explicitModelFor,
  FREE_MODEL_MARKER,
  type ModelChoice,
} from "./modelChoice";
import { MODEL_TIERS, type ModelTier } from "./modelTiers";
import { TASK_CLASS_ORDER, type TaskClass } from "./taskClass";
import { ProviderId, type Account, type ApiAccount } from "./types";

export const RouteSource = {
  routed: "routed",
  account: "account",
  cliDefault: "cli_default",
  override: "override",
  agent: "agent",
} as const;
export type RouteSource = (typeof RouteSource)[keyof typeof RouteSource];

export interface ClassRoute {
  readonly model: string | null;
  readonly requestedClass: TaskClass;
  readonly servedClass: TaskClass | null;
  readonly source: RouteSource;
}

function isFreeOnly(api: ApiAccount): boolean {
  const info = API_PROVIDERS[api.provider];
  return info.tier === ApiTier.free && info.freeModels === FreeModels.marked;
}

function candidatesFor(
  api: ApiAccount,
  tiers: readonly ModelTier[],
): ModelTier[] {
  const freeOnly = isFreeOnly(api);
  return tiers.filter(
    (tier) => tier.provider === api.provider && (!freeOnly || tier.free),
  );
}

function nearestRow(
  candidates: readonly ModelTier[],
  requested: TaskClass,
): ModelTier[] {
  const target = TASK_CLASS_ORDER.indexOf(requested);
  const ranked = TASK_CLASS_ORDER.map((taskClass, index) => ({
    taskClass,
    index,
    distance: Math.abs(index - target),
  }))
    .filter(({ taskClass }) =>
      candidates.some((tier) => tier.taskClass === taskClass),
    )
    .toSorted((a, b) => a.distance - b.distance || b.index - a.index);
  const [best] = ranked;
  return candidates.filter((tier) => tier.taskClass === best?.taskClass);
}

export function routeByClass(
  account: Account,
  taskClass: TaskClass,
  tiers: readonly ModelTier[] = MODEL_TIERS,
): ClassRoute {
  const { api } = account;
  if (account.provider !== ProviderId.opencode || api === undefined) {
    return {
      model: null,
      requestedClass: taskClass,
      servedClass: null,
      source: RouteSource.cliDefault,
    };
  }
  const served = nearestRow(candidatesFor(api, tiers), taskClass);
  const row = served.find((tier) => tier.modelId === api.model) ?? served[0];
  if (row === undefined) {
    return {
      model: api.model,
      requestedClass: taskClass,
      servedClass: null,
      source: RouteSource.account,
    };
  }
  return {
    model: row.modelId,
    requestedClass: taskClass,
    servedClass: row.taskClass,
    source: RouteSource.routed,
  };
}

export interface RouteRequest {
  readonly account: Account;
  readonly taskClass: TaskClass;
  readonly override: ModelChoice | null;
  readonly agentModel: ModelChoice | null;
}

function explicitRoute(
  request: RouteRequest,
  model: string,
  source: RouteSource,
): ClassRoute {
  return {
    model,
    requestedClass: request.taskClass,
    servedClass: null,
    source,
  };
}

export function isModelAllowed(
  api: ApiAccount,
  model: string,
  tiers: readonly ModelTier[] = MODEL_TIERS,
): boolean {
  return (
    !isFreeOnly(api) ||
    model === api.model ||
    model.includes(FREE_MODEL_MARKER) ||
    tiers.some(
      (tier) =>
        tier.provider === api.provider && tier.modelId === model && tier.free,
    )
  );
}

function allowedExplicitModel(
  account: Account,
  choice: ModelChoice | null,
  tiers: readonly ModelTier[],
): string | null {
  const model = explicitModelFor(account, choice);
  const { api } = account;
  if (model === null || api === undefined) {
    return model;
  }
  return isModelAllowed(api, model, tiers) ? model : null;
}

export function routeTurn(
  request: RouteRequest,
  tiers: readonly ModelTier[] = MODEL_TIERS,
): ClassRoute {
  const { account, taskClass } = request;
  const override = allowedExplicitModel(account, request.override, tiers);
  if (override !== null) {
    return explicitRoute(request, override, RouteSource.override);
  }
  const agent = allowedExplicitModel(account, request.agentModel, tiers);
  if (agent !== null) {
    return explicitRoute(request, agent, RouteSource.agent);
  }
  return routeByClass(account, taskClass, tiers);
}

export function resolveTaskClass(
  layers: readonly (TaskClass | null | undefined)[],
  fallback: TaskClass,
): TaskClass {
  return (
    layers.find((layer) => layer !== null && layer !== undefined) ?? fallback
  );
}
