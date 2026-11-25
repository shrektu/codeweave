import type { ContextUsage } from "./events";

export function contextUsageOf(
  usedTokens: number,
  limitTokens: number | null | undefined,
): ContextUsage | null {
  if (!Number.isInteger(usedTokens) || usedTokens < 0) {
    return null;
  }
  const normalizedLimit =
    limitTokens !== null &&
    limitTokens !== undefined &&
    Number.isInteger(limitTokens) &&
    limitTokens > 0
      ? limitTokens
      : null;
  return { usedTokens, limitTokens: normalizedLimit };
}
