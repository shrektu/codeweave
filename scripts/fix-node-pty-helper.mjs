import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

const PACKAGE_NAME = "node-pty";
const PREBUILDS_DIR = "prebuilds";
const DARWIN_PREFIX = "darwin-";
const HELPER_NAME = "spawn-helper";
const HELPER_MODE = 0o755;
const MODULE_NOT_FOUND = "MODULE_NOT_FOUND";

function resolvePackageDir() {
  const [explicitDir] = process.argv.slice(2);
  if (explicitDir !== undefined) {
    return explicitDir;
  }
  try {
    const manifest = createRequire(import.meta.url).resolve(
      `${PACKAGE_NAME}/package.json`,
    );
    return dirname(manifest);
  } catch (error) {
    if (error.code === MODULE_NOT_FOUND) {
      return null;
    }
    throw error;
  }
}

function makeHelpersExecutable(packageDir) {
  const prebuilds = join(packageDir, PREBUILDS_DIR);
  if (!existsSync(prebuilds)) {
    return;
  }
  for (const entry of readdirSync(prebuilds)) {
    const helper = join(prebuilds, entry, HELPER_NAME);
    if (entry.startsWith(DARWIN_PREFIX) && existsSync(helper)) {
      chmodSync(helper, HELPER_MODE);
    }
  }
}

const packageDir = resolvePackageDir();
if (packageDir !== null) {
  makeHelpersExecutable(packageDir);
}
