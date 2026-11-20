import type { NewSessionRequest } from "@agentclientprotocol/sdk";

import type { AgentToolAccess } from "../agentAdapter";
import {
  AUTHORIZATION_HEADER,
  BEARER_SCHEME,
  MCP_HTTP_SERVER_TYPE,
  MCP_TOOL_NAME_PREFIX,
  MCP_TOOL_NAME_SEPARATOR,
} from "../constants";

export function allowedToolNames(tools: AgentToolAccess): string[] {
  return tools.toolNames.map(
    (name) =>
      `${MCP_TOOL_NAME_PREFIX}${tools.server}${MCP_TOOL_NAME_SEPARATOR}${name}`,
  );
}

export function buildNewSessionRequest(
  cwd: string,
  tools: AgentToolAccess | undefined,
): NewSessionRequest {
  if (tools === undefined) {
    return { cwd, mcpServers: [] };
  }
  return {
    cwd,
    mcpServers: [
      {
        type: MCP_HTTP_SERVER_TYPE,
        name: tools.server,
        url: tools.url,
        headers: [
          {
            name: AUTHORIZATION_HEADER,
            value: `${BEARER_SCHEME} ${tools.token}`,
          },
        ],
      },
    ],
    _meta: {
      claudeCode: { options: { allowedTools: allowedToolNames(tools) } },
    },
  };
}
