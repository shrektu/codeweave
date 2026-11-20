import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentToolAccess } from "../../src/backend/agentAdapter";
import { PermissionProfile } from "../../src/domain/types";
import {
  agentOf,
  createRig,
  removeRigDirs,
  type AcpRig,
} from "../fakes/fakeAcpAgent";

const TOKEN = "tok-5f3a9c1e77";

function toolsOf(overrides: Partial<AgentToolAccess> = {}): AgentToolAccess {
  return {
    server: "codeweave",
    url: "http://127.0.0.1:41234/mcp",
    token: TOKEN,
    toolNames: ["run_flow", "list_flows"],
    ...overrides,
  };
}

async function startWithTools(
  tools: AgentToolAccess | undefined,
): Promise<AcpRig> {
  const rig = await createRig();
  const result = await rig.start(PermissionProfile.ask, "run-1", tools);
  if (!result.ok) {
    throw new Error(`start failed: ${result.reason}: ${result.message}`);
  }
  return rig;
}

function requestOf(rig: AcpRig): NewSessionRequest {
  const request = agentOf(rig).newSessions[0];
  if (request === undefined) {
    throw new Error("no newSession request was recorded");
  }
  return request;
}

function launchEnvOf(rig: AcpRig): Record<string, string> {
  const spec = rig.container.specs[0];
  if (spec === undefined) {
    throw new Error("no process was spawned");
  }
  return spec.env;
}

afterEach(removeRigDirs);

describe("claude tool access", () => {
  it("sends_one_http_mcp_server_with_the_bearer_header", async () => {
    const rig = await startWithTools(toolsOf());

    expect(requestOf(rig).mcpServers).toEqual([
      {
        type: "http",
        name: "codeweave",
        url: "http://127.0.0.1:41234/mcp",
        headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
      },
    ]);
  });

  it("allows_exactly_the_prefixed_tool_names", async () => {
    const rig = await startWithTools(toolsOf());

    expect(requestOf(rig)._meta).toEqual({
      claudeCode: {
        options: {
          allowedTools: [
            "mcp__codeweave__run_flow",
            "mcp__codeweave__list_flows",
          ],
        },
      },
    });
  });

  it("disables_tool_search_in_the_agent_env", async () => {
    const rig = await startWithTools(toolsOf());

    expect(launchEnvOf(rig).ENABLE_TOOL_SEARCH).toBe("false");
  });

  it("never_puts_the_tool_token_in_argv", async () => {
    const rig = await startWithTools(toolsOf());

    const spec = rig.container.specs[0];
    expect(spec?.args.join(" ")).not.toContain(TOKEN);
    expect(spec?.command).not.toContain(TOKEN);
  });

  it("leaves_the_session_untouched_without_tools", async () => {
    const rig = await startWithTools(undefined);

    const request = requestOf(rig);
    expect(request.mcpServers).toEqual([]);
    expect(Object.hasOwn(request, "_meta")).toBe(false);
    expect(Object.hasOwn(launchEnvOf(rig), "ENABLE_TOOL_SEARCH")).toBe(false);
  });
});

describe("claude tool access boundaries", () => {
  it("sends_an_empty_allow_list_for_zero_tool_names", async () => {
    const rig = await startWithTools(toolsOf({ toolNames: [] }));

    expect(requestOf(rig)._meta).toEqual({
      claudeCode: { options: { allowedTools: [] } },
    });
  });

  it("maps_a_single_tool_name", async () => {
    const rig = await startWithTools(toolsOf({ toolNames: ["only"] }));

    expect(requestOf(rig)._meta).toEqual({
      claudeCode: { options: { allowedTools: ["mcp__codeweave__only"] } },
    });
  });

  it("keeps_server_name_characters_verbatim", async () => {
    const rig = await startWithTools(
      toolsOf({ server: "code-weave.v2_x", toolNames: ["a", "b", "c"] }),
    );

    const request = requestOf(rig);
    expect(request.mcpServers[0]?.name).toBe("code-weave.v2_x");
    expect(request._meta).toEqual({
      claudeCode: {
        options: {
          allowedTools: [
            "mcp__code-weave.v2_x__a",
            "mcp__code-weave.v2_x__b",
            "mcp__code-weave.v2_x__c",
          ],
        },
      },
    });
  });
});
