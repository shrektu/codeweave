import path, { type PlatformPath } from "node:path";

import {
  CLI_CREDENTIAL_FILES,
  CLI_HOME_DIRS,
  PROTECTED_HOME_PATHS,
} from "./constants";

export interface ProtectedPathsInput {
  readonly homeDir: string;
  readonly userData: string;
  readonly accountDirs: readonly string[];
}

const PARENT_SEGMENT = "..";

function isWithin(
  child: string,
  parent: string,
  flavor: PlatformPath,
): boolean {
  const relation = flavor.relative(parent, child);
  return (
    relation === "" ||
    (relation !== PARENT_SEGMENT &&
      !relation.startsWith(`${PARENT_SEGMENT}${flavor.sep}`) &&
      !flavor.isAbsolute(relation))
  );
}

export function protectedPaths(
  input: ProtectedPathsInput,
  flavor: PlatformPath = path,
): readonly string[] {
  const credentialFiles = (dir: string): string[] =>
    CLI_CREDENTIAL_FILES.map((file) => flavor.join(dir, file));
  const homePaths = PROTECTED_HOME_PATHS.map((segments) =>
    flavor.join(input.homeDir, ...segments),
  );
  const cliFiles = CLI_HOME_DIRS.flatMap((segments) =>
    credentialFiles(flavor.join(input.homeDir, ...segments)),
  );
  const importedFiles = input.accountDirs
    .filter((dir) => !isWithin(dir, input.userData, flavor))
    .flatMap(credentialFiles);
  return [
    ...new Set([...homePaths, ...cliFiles, input.userData, ...importedFiles]),
  ];
}
