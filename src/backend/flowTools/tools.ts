import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { z } from "zod";

import {
  FLOW_DECISION_NOTE_CHARS,
  FLOW_REPOSITORY_PATH_MAX_CHARS,
  FLOW_TOOL_PAGE_CHARS,
  FLOW_TOOL_SERVER_NAME,
  FLOW_TOOL_SERVER_VERSION,
} from "../../domain/constants";
import { FlowDecision } from "../../domain/flowRun";
import { FlowPlacement } from "../../domain/types";
import { IpcError } from "../../shared/protocol";
import type { FlowsList } from "../../shared/views";
import { FLOWS_DIR } from "../flows";
import type { FlowControl } from "./control";

export const FlowToolName = {
  listFlows: "list_flows",
  startFlow: "start_flow",
  flowStatus: "flow_status",
  nodeResult: "node_result",
  flowDiff: "flow_diff",
  decide: "decide",
  stopFlow: "stop_flow",
  mergeFlow: "merge_flow",
  finishMerge: "finish_merge",
  abortMerge: "abort_merge",
} as const;
export type FlowToolName = (typeof FlowToolName)[keyof typeof FlowToolName];

export const FLOW_TOOL_NAMES: readonly FlowToolName[] =
  Object.values(FlowToolName);

const INTERNAL_ERROR_MESSAGE = "Internal error";
const JSON_INDENT = 2;

const RunIdShape = {
  runId: z.string().min(1).describe("Run id returned by start_flow"),
};
const RepositoryShape = {
  repository: z
    .string()
    .min(1)
    .max(FLOW_REPOSITORY_PATH_MAX_CHARS)
    .optional()
    .describe(
      "Path of the git repository to use, relative to your working directory, absolute or starting with ~; omit it to use your working directory",
    ),
};
const OffsetShape = {
  offset: z
    .int()
    .min(0)
    .default(0)
    .describe("Character offset to continue reading from"),
};

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, JSON_INDENT));
}

function flowsResult(list: FlowsList): CallToolResult {
  const { flows, errors, locations } = list;
  if (flows.length > 0) {
    return jsonResult(list);
  }
  const looked = [locations.project, locations.library]
    .filter((root): root is string => root !== null)
    .map((root) => join(root, FLOWS_DIR))
    .join(" and ");
  const message = `No flows found. Looked in ${looked}; set the agents and flows library in Settings to use shared flows.`;
  return errors.length === 0
    ? textResult(message)
    : textResult(`${message}\n\n${JSON.stringify(errors, null, JSON_INDENT)}`);
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function pagedResult(full: string, offset: number): CallToolResult {
  const end = Math.min(offset + FLOW_TOOL_PAGE_CHARS, full.length);
  const page = full.slice(offset, end);
  if (end >= full.length) {
    return textResult(page);
  }
  const range = `${String(offset)}-${String(end)} of ${String(full.length)}`;
  return textResult(
    `${page}\n[characters ${range}; call again with offset=${String(end)}]`,
  );
}

async function guarded(
  action: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof IpcError) {
      return errorResult(error.message);
    }
    console.error(error);
    return errorResult(INTERNAL_ERROR_MESSAGE);
  }
}

function registerQueryTools(server: McpServer, control: FlowControl): void {
  server.registerTool(
    FlowToolName.listFlows,
    {
      description:
        "List the flows you can run from the project and the user's flow library, each with its source, nodes, agents and any flow file errors; call this first to pick a flowId. Pass repository to list the flows of one repository inside your working directory.",
      inputSchema: RepositoryShape,
    },
    ({ repository }) =>
      guarded(async () => flowsResult(await control.listFlows(repository))),
  );
  server.registerTool(
    FlowToolName.flowStatus,
    {
      description:
        "Get the current state of a flow run: status, round, per-node status and truncated results, and any pending decision.",
      inputSchema: RunIdShape,
    },
    ({ runId }) => guarded(() => jsonResult(control.status(runId))),
  );
  server.registerTool(
    FlowToolName.nodeResult,
    {
      description:
        "Read the full untruncated result of one node of a flow run, in pages of 20000 characters; repeat with the offset from the continuation line until it is absent.",
      inputSchema: {
        ...RunIdShape,
        nodeId: z.string().min(1).describe("Node id from flow_status"),
        ...OffsetShape,
      },
    },
    ({ runId, nodeId, offset }) =>
      guarded(() => pagedResult(control.nodeResult(runId, nodeId), offset)),
  );
  server.registerTool(
    FlowToolName.flowDiff,
    {
      description:
        "Read the unified diff of the changes a flow run made to its working tree, in pages of 20000 characters; repeat with the offset from the continuation line until it is absent.",
      inputSchema: { ...RunIdShape, ...OffsetShape },
    },
    ({ runId, offset }) =>
      guarded(async () => pagedResult(await control.diff(runId), offset)),
  );
}

function registerRunTools(server: McpServer, control: FlowControl): void {
  server.registerTool(
    FlowToolName.startFlow,
    {
      description:
        "Start a flow run on a task and return its initial state; use worktree placement to isolate its changes on a separate branch, in_place to edit the project directly. Pass repository to run in one repository inside your working directory; the flow definitions, the changes and the worktree all belong to that repository.",
      inputSchema: {
        flowId: z.string().min(1).describe("Flow id from list_flows"),
        task: z.string().min(1).describe("The task the flow should carry out"),
        placement: z
          .enum(FlowPlacement)
          .default(FlowPlacement.inPlace)
          .describe("Where the run edits files"),
        ...RepositoryShape,
      },
    },
    ({ repository, ...request }) =>
      guarded(async () =>
        jsonResult(
          await control.startFlow(
            repository === undefined ? request : { ...request, repository },
          ),
        ),
      ),
  );
  server.registerTool(
    FlowToolName.decide,
    {
      description:
        "Answer a flow run that is awaiting a decision: approve it, run another round, or stop it; use after flow_status reports a pending decision.",
      inputSchema: {
        ...RunIdShape,
        decision: z.enum(FlowDecision).describe("How to proceed"),
        note: z
          .string()
          .max(FLOW_DECISION_NOTE_CHARS)
          .optional()
          .describe("Why you chose this decision; shown to the user"),
      },
    },
    ({ runId, decision, note }) =>
      guarded(async () =>
        jsonResult(await control.decide(runId, decision, note)),
      ),
  );
  server.registerTool(
    FlowToolName.stopFlow,
    {
      description:
        "Stop a flow run that is still running and discard further work; use when the run is no longer wanted.",
      inputSchema: RunIdShape,
    },
    ({ runId }) =>
      guarded(async () => {
        await control.stop(runId);
        return textResult("Stopped");
      }),
  );
}

function registerMergeTools(server: McpServer, control: FlowControl): void {
  server.registerTool(
    FlowToolName.mergeFlow,
    {
      description:
        "Merge the branch of a finished worktree run into the project; returns the merge commit, or the conflicting files to resolve before finish_merge.",
      inputSchema: RunIdShape,
    },
    ({ runId }) => guarded(async () => jsonResult(await control.merge(runId))),
  );
  server.registerTool(
    FlowToolName.finishMerge,
    {
      description:
        "Complete a merge that stopped on conflicts after you resolved them in the project directory.",
      inputSchema: RunIdShape,
    },
    ({ runId }) =>
      guarded(async () => jsonResult(await control.finishMerge(runId))),
  );
  server.registerTool(
    FlowToolName.abortMerge,
    {
      description:
        "Abandon a merge that stopped on conflicts and restore the project to its state before the merge.",
      inputSchema: RunIdShape,
    },
    ({ runId }) =>
      guarded(async () => {
        await control.abortMerge(runId);
        return textResult("Aborted");
      }),
  );
}

export function createFlowToolMcpServer(control: FlowControl): McpServer {
  const server = new McpServer({
    name: FLOW_TOOL_SERVER_NAME,
    version: FLOW_TOOL_SERVER_VERSION,
  });
  registerQueryTools(server, control);
  registerRunTools(server, control);
  registerMergeTools(server, control);
  return server;
}
