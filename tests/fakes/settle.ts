import { vi } from "vitest";

export const SETTLE_TIMEOUT_MS = 4000;

export function settled<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: SETTLE_TIMEOUT_MS });
}
