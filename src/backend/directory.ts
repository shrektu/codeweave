import { statSync } from "node:fs";

export function isDirectoryOrThrow(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
