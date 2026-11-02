import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

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

it("node_pty_native_module_is_asar_unpacked", () => {
  const config = parse(
    readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8"),
  ) as BuilderConfig;

  expect(config.asarUnpack).toContain("node_modules/node-pty/**");
});

const EXECUTABLE_BITS = 0o111;
const NON_EXECUTABLE_MODE = 0o644;
const HELPER_SCRIPT = join(REPO_ROOT, "scripts", "fix-node-pty-helper.mjs");

function darwinHelpers(prebuildsDir: string): string[] {
  return readdirSync(prebuildsDir)
    .filter((entry) => entry.startsWith("darwin-"))
    .map((entry) => join(prebuildsDir, entry, "spawn-helper"));
}

it.skipIf(process.platform === "win32")(
  "node_pty_spawn_helpers_are_executable",
  () => {
    const helpers = darwinHelpers(
      join(findPackageDir("node-pty", REPO_ROOT) ?? "", "prebuilds"),
    );

    expect(helpers).toHaveLength(2);
    for (const helper of helpers) {
      expect(statSync(helper).mode & EXECUTABLE_BITS, helper).toBe(
        EXECUTABLE_BITS,
      );
    }
  },
);

it.skipIf(process.platform === "win32")(
  "spawn_helper_script_makes_darwin_helpers_executable",
  () => {
    const packageDir = mkdtempSync(join(tmpdir(), "node-pty-"));
    try {
      const arm = join(packageDir, "prebuilds", "darwin-arm64");
      const win = join(packageDir, "prebuilds", "win32-x64");
      mkdirSync(arm, { recursive: true });
      mkdirSync(win, { recursive: true });
      writeFileSync(join(arm, "spawn-helper"), "bin", {
        mode: NON_EXECUTABLE_MODE,
      });
      writeFileSync(join(win, "conpty.dll"), "dll", {
        mode: NON_EXECUTABLE_MODE,
      });

      execFileSync(process.execPath, [HELPER_SCRIPT, packageDir]);

      expect(statSync(join(arm, "spawn-helper")).mode & 0o777).toBe(0o755);
      expect(statSync(join(win, "conpty.dll")).mode & 0o777).toBe(
        NON_EXECUTABLE_MODE,
      );
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "spawn_helper_script_ignores_a_package_without_prebuilds",
  () => {
    const packageDir = mkdtempSync(join(tmpdir(), "node-pty-"));
    try {
      expect(() =>
        execFileSync(process.execPath, [HELPER_SCRIPT, packageDir]),
      ).not.toThrow();
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  },
);

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
