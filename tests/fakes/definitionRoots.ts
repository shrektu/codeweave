import { join } from "node:path";

import { DEFINITION_LIBRARY_DIR_NAME } from "../../src/backend/constants";
import type { DefinitionRoots } from "../../src/backend/definitionLibrary";

export function projectRoots(cwd: string): DefinitionRoots {
  return { project: cwd, library: join(cwd, DEFINITION_LIBRARY_DIR_NAME) };
}

export function libraryOnlyRoots(library: string): DefinitionRoots {
  return { project: null, library };
}
