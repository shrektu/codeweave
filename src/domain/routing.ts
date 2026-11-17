import { API_PROVIDERS, ApiTier, FreeModels } from "./apiProviders";
import { MODEL_TIERS, type ModelTier } from "./modelTiers";
import { TASK_CLASS_ORDER, type TaskClass } from "./taskClass";
import { ProviderId, type Account, type ApiAccount } from "./types";

export const RouteSource = {
  routed: "routed",
  account: "account",
  cliDefault: "cli_default",
} as const;
export type RouteSource = (typeof RouteSource)[keyof typeof RouteSource];

export interface ClassRoute {
  readonly model: string | null;
  readonly requestedClass: TaskClass;
  readonly servedClass: TaskClass | null;
  readonly source: RouteSource;
}

function candidatesFor(
  api: ApiAccount,
  tiers: readonly ModelTier[],
): ModelTier[] {
  const info = API_PROVIDERS[api.provider];
  const freeOnly =
    info.tier === ApiTier.free && info.freeModels === FreeModels.marked;
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

export function resolveTaskClass(
  layers: readonly (TaskClass | null | undefined)[],
  fallback: TaskClass,
): TaskClass {
  return (
    layers.find((layer) => layer !== null && layer !== undefined) ?? fallback
  );
}
