import type { FileCompletion } from "../../src/backend/fileCompletion";

export function fakeFileCompletion(
  overrides: Partial<FileCompletion> = {},
): FileCompletion {
  return {
    complete: () => Promise.resolve([]),
    ...overrides,
  };
}
