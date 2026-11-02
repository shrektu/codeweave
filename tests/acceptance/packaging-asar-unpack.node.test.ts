import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ADAPTER_NAME = "@agentclientprotocol/claude-agent-acp";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface BuilderConfig {
  readonly asarUnpack: readonly string[];
}

function findPackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

function runtimeClosure(): ReadonlySet<string> {
  const names = new Set<string>([ADAPTER_NAME]);
  const queue = [findPackageDir(ADAPTER_NAME, REPO_ROOT)];
  for (const dir of queue) {
    if (dir === undefined) {
      continue;
    }
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as PackageManifest;
    const deps = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(deps)) {
      const depDir = findPackageDir(name, dir);
      if (depDir !== undefined && !names.has(name)) {
        names.add(name);
        queue.push(depDir);
      }
    }
  }
  return names;
}

it("agy_hook_entry_is_a_main_bundle_input_and_asar_unpacked", () => {
  const config = parse(
    readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8"),
  ) as BuilderConfig;
  const viteConfig = readFileSync(
    join(REPO_ROOT, "electron.vite.config.ts"),
    "utf8",
  );

  expect(viteConfig).toMatch(
    /agyHook:\s*srcPath\("backend",\s*"agy",\s*"hook\.ts"\)/,
  );
  expect(existsSync(join(REPO_ROOT, "src", "backend", "agy", "hook.ts"))).toBe(
    true,
  );
  expect(config.asarUnpack).toEqual(
    expect.arrayContaining([
      "out/main/agyHook*.js",
      "out/main/chunks/**",
      "node_modules/shell-quote/**",
    ]),
  );
});

it("adapter_runtime_closure_is_asar_unpacked", () => {
  const config = parse(
    readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8"),
  ) as BuilderConfig;
  const unpacked = new Set(config.asarUnpack);

  const uncovered = [...runtimeClosure()]
    .filter((name) => !unpacked.has(`node_modules/${name}/**`))
    .sort();

  expect(uncovered).toEqual([]);
});
