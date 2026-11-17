import { resolve } from "node:path";
import process from "node:process";

import { verifyReleaseDir } from "./nativeArch.ts";

const DEFAULT_RELEASE_DIR = resolve(import.meta.dirname, "../../release");

if (import.meta.main) {
  const [releaseDir = DEFAULT_RELEASE_DIR] = process.argv.slice(2);
  process.exitCode = verifyReleaseDir(resolve(releaseDir));
}
