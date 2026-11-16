import type { CodeweaveApi } from "../../src/shared/api";

export function makeCodeweaveApi(
  overrides: Partial<CodeweaveApi> = {},
): CodeweaveApi {
  return {
    gpuAccelerated: true,
    pickFolder: () => Promise.resolve(null),
    getAvailableUpdate: () => Promise.resolve(null),
    onUpdateAvailable: () => () => undefined,
    openUpdateRelease: () => Promise.resolve(),
    ...overrides,
  };
}
