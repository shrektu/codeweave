import { afterEach, describe, expect, it } from "vitest";

import type { AgentToolAccess } from "../../src/backend/agentAdapter";
import { PermissionProfile } from "../../src/domain/types";
import {
  createCodexRig,
  removeCodexRigDirs,
} from "../fakes/fakeCodexAppServer";

const TOKEN = "s3cret-token-value";

const TOOLS: AgentToolAccess = {
  server: "codeweave",
  url: "http://127.0.0.1:43111/mcp",
  token: TOKEN,
  toolNames: ["start_flow", "get_flow"],
};

afterEach(removeCodexRigDirs);

describe("codex tool access: spawn", () => {
  it("tools_session_spawns_with_the_four_mcp_overrides", async () => {
    const rig = await createCodexRig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(rig.container.specs[0]?.args).toEqual([
      "-c",
      'mcp_servers.codeweave.url="http://127.0.0.1:43111/mcp"',
      "-c",
      'mcp_servers.codeweave.bearer_token_env_var="CODEWEAVE_MCP_TOKEN"',
      "-c",
      'mcp_servers.codeweave.default_tools_approval_mode="approve"',
      "-c",
      'mcp_servers.codeweave.enabled_tools=["start_flow","get_flow"]',
      "app-server",
    ]);
  });

  it("tools_session_passes_the_token_through_env", async () => {
    const rig = await createCodexRig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(rig.container.specs[0]?.env.CODEWEAVE_MCP_TOKEN).toBe(TOKEN);
  });

  it("never puts the tool token in argv", async () => {
    const rig = await createCodexRig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    const joined = rig.container.specs[0]?.args.join("\n") ?? "";
    expect(joined).not.toContain(TOKEN);
  });

  it("session_without_tools_keeps_args_and_env_unchanged", async () => {
    const rig = await createCodexRig();

    await rig.start();

    expect(rig.container.specs[0]?.args).toEqual(["app-server"]);
    expect(rig.container.specs[0]?.env).not.toHaveProperty(
      "CODEWEAVE_MCP_TOKEN",
    );
  });
});
