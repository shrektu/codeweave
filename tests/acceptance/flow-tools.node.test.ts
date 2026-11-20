import { request } from "node:http";
import { connect as connectSocket } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startFlowToolServer,
  type FlowToolServer,
  type ToolGrant,
} from "../../src/backend/flowTools/server";
import { IpcError, IpcErrorCode } from "../../src/shared/protocol";
import {
  postExpectingContinue,
  postRevokedInFlight,
} from "../fakes/inFlightPost";
import {
  FakeFlowControl,
  FlowControlOp,
  SAMPLE_FLOWS,
  SAMPLE_RUN,
} from "../fakes/fakeFlowControl";

const EXPECTED_TOOLS = [
  "abort_merge",
  "decide",
  "finish_merge",
  "flow_diff",
  "flow_status",
  "list_flows",
  "merge_flow",
  "node_result",
  "start_flow",
  "stop_flow",
];

const LIST_FLOWS_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_flows", arguments: {} },
});

const ALPHABET_LENGTH = 26;
const FIRST_LETTER_CODE = 97;

function alphabetText(length: number): string {
  return Array.from({ length }, (_, index) =>
    String.fromCharCode(FIRST_LETTER_CODE + (index % ALPHABET_LENGTH)),
  ).join("");
}

interface Connected {
  readonly client: Client;
  readonly control: FakeFlowControl;
  readonly grant: ToolGrant;
}

let server: FlowToolServer;
const openClients: Client[] = [];

async function connectClient(grant: ToolGrant): Promise<Client> {
  const client = new Client({ name: "flow-tools-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
  openClients.push(client);
  return client;
}

async function connectedControl(): Promise<Connected> {
  const control = new FakeFlowControl();
  const grant = server.register(control);
  return { client: await connectClient(grant), control, grant };
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }),
  );
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return { text, isError: result.isError === true };
}

function postStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_flows", arguments: {} },
      }),
    );
  });
}

beforeEach(async () => {
  server = await startFlowToolServer();
});

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await server.close();
});

describe("flow tool server discovery", () => {
  it("lists exactly the ten tools with input schemas", async () => {
    const { client } = await connectedControl();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
    }
    const start = tools.find((tool) => tool.name === "start_flow");
    expect(Object.keys(start?.inputSchema.properties ?? {}).sort()).toEqual([
      "flowId",
      "placement",
      "task",
    ]);
    expect(start?.inputSchema.required).toEqual(["flowId", "task"]);
  });

  it("returns the flows list as JSON from list_flows", async () => {
    const { client } = await connectedControl();
    const { text, isError } = await callText(client, "list_flows", {});
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual(SAMPLE_FLOWS);
  });

  it("forwards start_flow with the default placement in place", async () => {
    const { client, control } = await connectedControl();
    const { text } = await callText(client, "start_flow", {
      flowId: "review",
      task: "Fix the bug",
    });
    expect(JSON.parse(text)).toEqual(SAMPLE_RUN);
    expect(control.calls).toEqual([
      {
        op: FlowControlOp.startFlow,
        args: [
          { flowId: "review", task: "Fix the bug", placement: "in_place" },
        ],
      },
    ]);
  });
});

describe("flow tool server queries", () => {
  it("forwards an explicit worktree placement", async () => {
    const { client, control } = await connectedControl();
    await callText(client, "start_flow", {
      flowId: "review",
      task: "Fix the bug",
      placement: "worktree",
    });
    expect(control.calls[0]?.args).toEqual([
      { flowId: "review", task: "Fix the bug", placement: "worktree" },
    ]);
  });

  it("returns the run view from flow_status", async () => {
    const { client, control } = await connectedControl();
    const { text } = await callText(client, "flow_status", { runId: "run-1" });
    expect(JSON.parse(text)).toEqual(SAMPLE_RUN);
    expect(control.calls).toEqual([
      { op: FlowControlOp.status, args: ["run-1"] },
    ]);
  });
});

describe("flow tool server node result paging", () => {
  it("pages node_result in 20000 character pages", async () => {
    const { client, control } = await connectedControl();
    control.nodeResultText = alphabetText(45_000);

    const first = await callText(client, "node_result", {
      runId: "run-1",
      nodeId: "write",
    });
    expect(first.text).toHaveLength(
      20_000 +
        "\n[characters 0-20000 of 45000; call again with offset=20000]".length,
    );
    expect(first.text.startsWith("abcdef")).toBe(true);
    expect(first.text[19_999]).toBe("f");
    expect(
      first.text.endsWith(
        "\n[characters 0-20000 of 45000; call again with offset=20000]",
      ),
    ).toBe(true);

    const second = await callText(client, "node_result", {
      runId: "run-1",
      nodeId: "write",
      offset: 20_000,
    });
    expect(second.text.startsWith("ghijkl")).toBe(true);
    expect(
      second.text.endsWith(
        "\n[characters 20000-40000 of 45000; call again with offset=40000]",
      ),
    ).toBe(true);

    const last = await callText(client, "node_result", {
      runId: "run-1",
      nodeId: "write",
      offset: 40_000,
    });
    expect(last.text).toHaveLength(5000);
    expect(last.text).not.toContain("[characters");

    const past = await callText(client, "node_result", {
      runId: "run-1",
      nodeId: "write",
      offset: 45_000,
    });
    expect(past).toEqual({ text: "", isError: false });
    expect(control.calls[0]).toEqual({
      op: FlowControlOp.nodeResult,
      args: ["run-1", "write"],
    });
  });
});

describe("flow tool server diff and actions", () => {
  it("pages flow_diff the same way", async () => {
    const { client, control } = await connectedControl();
    control.diffText = alphabetText(20_001);
    const first = await callText(client, "flow_diff", { runId: "run-1" });
    expect(
      first.text.endsWith(
        "\n[characters 0-20000 of 20001; call again with offset=20000]",
      ),
    ).toBe(true);
    const last = await callText(client, "flow_diff", {
      runId: "run-1",
      offset: 20_000,
    });
    expect(last.text).toBe(alphabetText(20_001).slice(-1));
    expect(control.calls[0]).toEqual({
      op: FlowControlOp.diff,
      args: ["run-1"],
    });
  });

  it("forwards decide, stop, merge, finish and abort to the control", async () => {
    const { client, control } = await connectedControl();
    const decided = await callText(client, "decide", {
      runId: "run-1",
      decision: "another_round",
    });
    expect(JSON.parse(decided.text)).toEqual(SAMPLE_RUN);
    await callText(client, "stop_flow", { runId: "run-2" });
    const merged = await callText(client, "merge_flow", { runId: "run-3" });
    expect(JSON.parse(merged.text)).toEqual({
      status: "merged",
      commit: "abc123",
    });
    await callText(client, "finish_merge", { runId: "run-4" });
    await callText(client, "abort_merge", { runId: "run-5" });
    expect(control.calls).toEqual([
      { op: FlowControlOp.decide, args: ["run-1", "another_round"] },
      { op: FlowControlOp.stop, args: ["run-2"] },
      { op: FlowControlOp.merge, args: ["run-3"] },
      { op: FlowControlOp.finishMerge, args: ["run-4"] },
      { op: FlowControlOp.abortMerge, args: ["run-5"] },
    ]);
  });
});

describe("flow tool server errors and auth", () => {
  it("keeps serving after a control error", async () => {
    const { client, control } = await connectedControl();
    control.failure = new IpcError(IpcErrorCode.NOT_FOUND, "no such run: x");
    const failed = await callText(client, "flow_status", { runId: "x" });
    expect(failed).toEqual({ text: "no such run: x", isError: true });
    control.failure = null;
    const ok = await callText(client, "flow_status", { runId: "run-1" });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text)).toEqual(SAMPLE_RUN);
  });

  it("rejects invalid arguments without calling the control", async () => {
    const { client, control } = await connectedControl();
    const missing = await callText(client, "flow_status", {});
    const placement = await callText(client, "start_flow", {
      flowId: "review",
      task: "t",
      placement: "elsewhere",
    });
    const decision = await callText(client, "decide", {
      runId: "run-1",
      decision: "maybe",
    });
    const offset = await callText(client, "flow_diff", {
      runId: "run-1",
      offset: -1,
    });
    expect(
      [missing, placement, decision, offset].map((r) => r.isError),
    ).toEqual([true, true, true, true]);
    expect(control.calls).toEqual([]);
  });

  it("never calls the control without a valid token", async () => {
    const control = new FakeFlowControl();
    const grant = server.register(control);
    const statuses = await Promise.all([
      postStatus(grant.url, {}),
      postStatus(grant.url, { Authorization: "Bearer wrong" }),
      postStatus(grant.url, { Authorization: `Basic ${grant.token}` }),
    ]);
    expect(statuses).toEqual([401, 401, 401]);
    expect(control.calls).toEqual([]);
  });

  it("rejects a revoked token", async () => {
    const control = new FakeFlowControl();
    const grant = server.register(control);
    const bearer = { Authorization: `Bearer ${grant.token}` };
    expect(await postStatus(grant.url, bearer)).toBe(200);
    server.revoke(grant.token);
    expect(await postStatus(grant.url, bearer)).toBe(401);
    expect(control.calls).toEqual([{ op: FlowControlOp.listFlows, args: [] }]);
  });
});

describe("flow tool server continue gating", () => {
  it("sends no continue to a request without a valid token", async () => {
    const control = new FakeFlowControl();
    const grant = server.register(control);
    const { url } = grant;
    server.revoke(grant.token);
    const outcomes = [
      await postExpectingContinue({ url, body: LIST_FLOWS_BODY }),
      await postExpectingContinue({
        url,
        body: LIST_FLOWS_BODY,
        token: grant.token,
      }),
    ];
    expect(outcomes).toEqual([
      { status: 401, continued: false },
      { status: 401, continued: false },
    ]);
    expect(control.calls).toEqual([]);
  });

  it("sends no continue to a foreign host or path", async () => {
    const control = new FakeFlowControl();
    const { url, token } = server.register(control);
    const body = LIST_FLOWS_BODY;
    const outcomes = [
      await postExpectingContinue({ url, body, token, host: "evil.example" }),
      await postExpectingContinue({ url, body, token, path: "/other" }),
    ];
    expect(outcomes).toEqual([
      { status: 403, continued: false },
      { status: 404, continued: false },
    ]);
    expect(control.calls).toEqual([]);
  });
});

describe("flow tool server isolation", () => {
  it("rejects a request revoked while its body is in flight", async () => {
    const control = new FakeFlowControl();
    const grant = server.register(control);
    const outcome = await postRevokedInFlight(
      grant.url,
      grant.token,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_flows", arguments: {} },
      }),
      () => {
        server.revoke(grant.token);
      },
    );
    expect(outcome).toEqual({ status: 401, continued: true });
    expect(control.calls).toEqual([]);
  });

  it("routes each token only to its own control", async () => {
    const first = await connectedControl();
    const second = await connectedControl();
    expect(first.grant.token).not.toBe(second.grant.token);
    await callText(second.client, "stop_flow", { runId: "run-b" });
    await callText(first.client, "stop_flow", { runId: "run-a" });
    expect(first.control.calls).toEqual([
      { op: FlowControlOp.stop, args: ["run-a"] },
    ]);
    expect(second.control.calls).toEqual([
      { op: FlowControlOp.stop, args: ["run-b"] },
    ]);
  });

  it("answers 403 to a foreign Host header", async () => {
    const control = new FakeFlowControl();
    const grant = server.register(control);
    const bearer = { Authorization: `Bearer ${grant.token}` };
    const status = await postStatus(grant.url, {
      ...bearer,
      Host: "evil.example:80",
    });
    expect(status).toBe(403);
    expect(control.calls).toEqual([]);
  });

  it("refuses new connections after close", async () => {
    const { grant } = await connectedControl();
    const { port } = new URL(grant.url);
    await server.close();
    const outcome = await new Promise<string>((resolve) => {
      const socket = connectSocket(Number(port), "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? "error");
      });
    });
    expect(outcome).toBe("ECONNREFUSED");
  });
});
