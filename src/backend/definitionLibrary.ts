import { join } from "node:path";

import { DEFINITION_LIBRARY_DIR_NAME } from "./constants";
import type { JsonStore } from "./storage";

export interface DefinitionRoots {
  readonly project: string;
  readonly library: string;
}

export type ResolveDefinitionRoots = (cwd: string) => Promise<DefinitionRoots>;

export interface DefinitionRootsDeps {
  readonly store: JsonStore;
  readonly userData: string;
}

export function createDefinitionRoots({
  store,
  userData,
}: DefinitionRootsDeps): ResolveDefinitionRoots {
  return async (cwd) => {
    const { definitionLibrary } = await store.readSettings();
    return {
      project: cwd,
      library: definitionLibrary ?? join(userData, DEFINITION_LIBRARY_DIR_NAME),
    };
  };
}
