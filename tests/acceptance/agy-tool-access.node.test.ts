import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentStartFailure,
  type AgentToolAccess,
} from "../../src/backend/agentAdapter";
import { PermissionProfile } from "../../src/domain/types";
import { createAgyRig, removeAgyRigDirs } from "../fakes/fakeAgy";

const TOOLS: AgentToolAccess = {
  server: "codeweave",
  url: "http://127.0.0.1:41234/mcp",
  token: "orchestrator-secret-token",
  toolNames: ["start_flow", "get_flow_status"],
};
const NOT_SUPPORTED_MESSAGE =
  "Orchestrate is not supported on Gemini (agy) yet";

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAgyRigDirs();
});

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

describe("agy tool access", () => {
  it("refuses tools on agy", async () => {
    const rig = await createAgyRig();

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result).toEqual({
      ok: false,
      reason: AgentStartFailure.error,
      message: NOT_SUPPORTED_MESSAGE,
    });
  });

  it("a refused tools start writes nothing and spawns nothing", async () => {
    const rig = await createAgyRig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(rig.container.spawns).toHaveLength(0);
    expect(rig.hookWrites).toHaveLength(0);
    expect(await filesUnder(rig.configDir)).toEqual([]);
  });

  it("never leaves the tool token in the account config after launch", async () => {
    const rig = await createAgyRig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    const files = await filesUnder(rig.configDir);
    const contents = await Promise.all(
      files.map((file) => readFile(join(rig.configDir, file), "utf8")),
    );
    expect(files).not.toContain(join("config", "mcp_config.json"));
    expect(contents.join("\n")).not.toContain(TOOLS.token);
  });

  it("a start without tools still succeeds and writes no mcp_config.json", async () => {
    const rig = await createAgyRig();

    const result = await rig.start(PermissionProfile.ask);

    expect(result.ok).toBe(true);
    expect(await filesUnder(rig.configDir)).not.toContain(
      join("config", "mcp_config.json"),
    );
  });
});
