import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

import { builderInvocation, childEnvironment } from "./builderInvocation.ts";
import type { ReleaseTarget } from "./builderInvocation.ts";
import { verifyReleaseDir } from "./nativeArch.ts";

const TARGETS: readonly ReleaseTarget[] = ["linux", "windows", "mac"];
const RELEASE_DIR = resolve(import.meta.dirname, "../../release");
const BUILDER_CLI = "electron-builder/cli.js";

function isReleaseTarget(value: string | undefined): value is ReleaseTarget {
  return TARGETS.some((target) => target === value);
}

export interface BuildBoundaries {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run: (
    command: string,
    args: readonly string[],
    env: Record<string, string>,
  ) => void;
  readonly verify: () => number;
}

const DEFAULT_BOUNDARIES: BuildBoundaries = {
  env: process.env,
  run: (command, args, env) => {
    execFileSync(command, args, { stdio: "inherit", env });
  },
  verify: () => verifyReleaseDir(RELEASE_DIR),
};

export function build(
  target: ReleaseTarget,
  extraArgs: readonly string[],
  boundaries: BuildBoundaries = DEFAULT_BOUNDARIES,
): number {
  const invocation = builderInvocation(target, boundaries.env);
  for (const warning of invocation.warnings) {
    console.warn(`::warning::${warning}`);
  }
  const cli = createRequire(import.meta.url).resolve(BUILDER_CLI);
  boundaries.run(
    process.execPath,
    [cli, ...invocation.args, ...extraArgs],
    childEnvironment(boundaries.env, invocation),
  );
  console.log(
    `${target} build finished (${invocation.signed ? "signed" : "unsigned"})`,
  );
  return boundaries.verify();
}

if (import.meta.main) {
  const [target, ...extraArgs] = process.argv.slice(2);
  if (!isReleaseTarget(target)) {
    console.error(
      `usage: build.ts <${TARGETS.join("|")}> [electron-builder args]`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = build(target, extraArgs);
  }
}
