import { posix, win32 } from "node:path";

import { DEFAULT_PATHEXT, WINDOWS_PATH_DELIMITER } from "./constants";

export interface ExecutableDeps {
  readonly pathEnv: string;
  readonly pathExt: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly isFile: (path: string) => boolean;
}

const QUOTE_PATTERN = /^"(.*)"$/;

function candidateExtensions(deps: ExecutableDeps, extname: string): string[] {
  if (deps.platform !== "win32") {
    return [""];
  }
  const extensions = (deps.pathExt ?? DEFAULT_PATHEXT)
    .split(WINDOWS_PATH_DELIMITER)
    .filter((extension) => extension !== "");
  const hasKnownExtension = extensions.some(
    (extension) => extension.toLowerCase() === extname.toLowerCase(),
  );
  return hasKnownExtension ? ["", ...extensions] : extensions;
}

export function resolveExecutable(
  name: string,
  deps: ExecutableDeps,
): string | null {
  const pathApi = deps.platform === "win32" ? win32 : posix;
  const extensions = candidateExtensions(deps, pathApi.extname(name));
  const directories =
    pathApi.isAbsolute(name) || name !== pathApi.basename(name)
      ? [""]
      : deps.pathEnv
          .split(pathApi.delimiter)
          .map((entry) => entry.replace(QUOTE_PATTERN, "$1"))
          .filter((entry) => entry !== "");
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate =
        directory === ""
          ? `${name}${extension}`
          : pathApi.join(directory, `${name}${extension}`);
      if (deps.isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
