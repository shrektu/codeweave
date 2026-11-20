import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildClaudeLaunch,
  locateClaudeAcpEntry,
  resolveAdapterEntry,
} from "./launch";

const execFileAsync = promisify(execFile);
const PROBE_SOURCE = `process.stdout.write(JSON.stringify({
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  kept: process.env.CODEWEAVE_PROBE ?? null,
}));`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeProbe(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-probe-"));
  tempDirs.push(dir);
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, PROBE_SOURCE);
  return probe;
}

async function runProbe(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<unknown> {
  const { stdout } = await execFileAsync(command, [...args], { env });
  return JSON.parse(stdout);
}

describe("buildClaudeLaunch", () => {
  it("runs_the_electron_binary_with_the_entry_as_last_argument", () => {
    const env = { PATH: "/usr/bin" };

    const launch = buildClaudeLaunch({
      execPath: "/opt/app/codeweave",
      adapterEntry: "/opt/app/acp/dist/index.js",
      env,
    });

    expect(launch.command).toBe("/opt/app/codeweave");
    expect(launch.args).toHaveLength(3);
    expect(launch.args[0]).toBe("-e");
    expect(launch.args[2]).toBe("/opt/app/acp/dist/index.js");
    expect(launch.env).toEqual({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("adds_enable_tool_search_false_only_when_tools_are_enabled", () => {
    const base = {
      execPath: "/opt/app/codeweave",
      adapterEntry: "/opt/app/acp/dist/index.js",
      env: { PATH: "/usr/bin" },
    };

    expect(buildClaudeLaunch({ ...base, toolsEnabled: true }).env).toEqual({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(buildClaudeLaunch({ ...base, toolsEnabled: false }).env).toEqual({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("launcher_child_does_not_inherit_electron_run_as_node", async () => {
    const probe = await writeProbe();
    const launch = buildClaudeLaunch({
      execPath: process.execPath,
      adapterEntry: probe,
      env: { CODEWEAVE_PROBE: "yes" },
    });

    const direct = await runProbe(process.execPath, [probe], launch.env);
    const launched = await runProbe(launch.command, launch.args, launch.env);

    expect(direct).toEqual({ runAsNode: "1", kept: "yes" });
    expect(launched).toEqual({ runAsNode: null, kept: "yes" });
  });
});

describe("resolveAdapterEntry", () => {
  it.each([
    [
      "/opt/App/resources/app.asar/node_modules/pkg/dist/index.js",
      "/opt/App/resources/app.asar.unpacked/node_modules/pkg/dist/index.js",
    ],
    [
      "C:\\Program Files\\App\\resources\\app.asar\\node_modules\\pkg\\dist\\index.js",
      "C:\\Program Files\\App\\resources\\app.asar.unpacked\\node_modules\\pkg\\dist\\index.js",
    ],
    [
      "/opt/App/resources/app.asar.unpacked/node_modules/pkg/dist/index.js",
      "/opt/App/resources/app.asar.unpacked/node_modules/pkg/dist/index.js",
    ],
    [
      "/home/jane/code/node_modules/pkg/dist/index.js",
      "/home/jane/code/node_modules/pkg/dist/index.js",
    ],
  ])("maps_%s", (input, expected) => {
    expect(resolveAdapterEntry(input)).toBe(expected);
  });
});

describe("locateClaudeAcpEntry", () => {
  it("resolves_the_installed_adapter_bin", async () => {
    const entry = locateClaudeAcpEntry();

    expect(entry.endsWith(join("claude-agent-acp", "dist", "index.js"))).toBe(
      true,
    );
    await expect(access(entry)).resolves.toBeUndefined();
  });
});
