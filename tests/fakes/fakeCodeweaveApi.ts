import type { CodeweaveApi } from "../../src/shared/api";

export function makeCodeweaveApi(
  overrides: Partial<CodeweaveApi> = {},
): CodeweaveApi {
  return {
    isGpuAccelerated: () => true,
    onGpuAcceleratedChanged: () => () => undefined,
    pickFolder: () => Promise.resolve(null),
    getAvailableUpdate: () => Promise.resolve(null),
    onUpdateAvailable: () => () => undefined,
    openUpdateRelease: () => Promise.resolve(),
    ...overrides,
  };
}

export interface FakeGpuAcceleration {
  readonly api: Pick<
    CodeweaveApi,
    "isGpuAccelerated" | "onGpuAcceleratedChanged"
  >;
  set(accelerated: boolean): void;
}

export function createFakeGpuAcceleration(
  initial: boolean,
): FakeGpuAcceleration {
  let current = initial;
  const listeners = new Set<(accelerated: boolean) => void>();
  return {
    api: {
      isGpuAccelerated: () => current,
      onGpuAcceleratedChanged: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(accelerated): void {
      current = accelerated;
      for (const listener of listeners) {
        listener(accelerated);
      }
    },
  };
}
