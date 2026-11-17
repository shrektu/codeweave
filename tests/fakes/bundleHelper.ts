import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { build } from "esbuild";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CACHE_DIR = join(REPO_ROOT, "node_modules", ".cache");
const BUNDLE_DIR_PREFIX = "codeweave-bundle-";
const STAND_IN_ENTRY = join(REPO_ROOT, "tests", "fakes", "standInBackend.ts");
const EXTERNAL_PACKAGES = ["koffi", "node-pty"];
const NODE_TARGET = "node24";

export interface BundledScript {
  readonly file: string;
  dispose(): Promise<void>;
}

export async function bundleStandInBackend(): Promise<BundledScript> {
  await mkdir(CACHE_DIR, { recursive: true });
  const dir = await mkdtemp(join(CACHE_DIR, BUNDLE_DIR_PREFIX));
  const file = join(dir, "standInBackend.cjs");
  try {
    await build({
      entryPoints: [STAND_IN_ENTRY],
      outfile: file,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: NODE_TARGET,
      external: EXTERNAL_PACKAGES,
      logLevel: "silent",
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    file,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
