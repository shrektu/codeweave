import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IpcError, IpcErrorCode } from "../../shared/protocol";
import {
  FakeFlowControl,
  FlowControlOp,
  SAMPLE_RUN,
} from "../../../tests/fakes/fakeFlowControl";
import { createFlowToolMcpServer } from "./tools";

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

const clients: Client[] = [];

async function connect(control: FakeFlowControl): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createFlowToolMcpServer(control).connect(serverSide);
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }),
  );
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return { text, isError: result.isError === true };
}

async function pagedDiff(length: number, offset?: number): Promise<string> {
  const control = new FakeFlowControl();
  control.diffText = "x".repeat(length);
  const client = await connect(control);
  const args = offset === undefined ? {} : { offset };
  return (await call(client, "flow_diff", { runId: "run-1", ...args })).text;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

describe("flow tool paging", () => {
  it("returns exactly one page without a continuation line", async () => {
    const text = await pagedDiff(20_000);
    expect(text).toBe("x".repeat(20_000));
  });

  it("adds a continuation line when one character remains", async () => {
    const text = await pagedDiff(20_001);
    expect(text).toBe(
      `${"x".repeat(20_000)}\n[characters 0-20000 of 20001; call again with offset=20000]`,
    );
  });

  it("returns empty text for an empty result", async () => {
    expect(await pagedDiff(0)).toBe("");
  });

  it("returns empty text when the offset equals the total", async () => {
    expect(await pagedDiff(30, 30)).toBe("");
  });

  it("returns empty text when the offset is past the total", async () => {
    expect(await pagedDiff(30, 500)).toBe("");
  });

  it("reports the remaining range for a mid-result offset", async () => {
    const text = await pagedDiff(50_000, 10);
    expect(
      text.endsWith(
        "\n[characters 10-20010 of 50000; call again with offset=20010]",
      ),
    ).toBe(true);
    expect(text).toHaveLength(20_000 + 61);
  });
});

describe("decide tool", () => {
  it("forwards the note", async () => {
    const control = new FakeFlowControl();
    const client = await connect(control);

    const outcome = await call(client, "decide", {
      runId: "run-1",
      decision: "approve",
      note: "Diff matches the task",
    });

    expect(outcome.isError).toBe(false);
    expect(control.calls).toEqual([
      {
        op: FlowControlOp.decide,
        args: ["run-1", "approve", "Diff matches the task"],
      },
    ]);
  });

  it("forwards no note when none is given", async () => {
    const control = new FakeFlowControl();
    const client = await connect(control);

    await call(client, "decide", { runId: "run-1", decision: "stop" });

    expect(control.calls).toEqual([
      { op: FlowControlOp.decide, args: ["run-1", "stop"] },
    ]);
  });

  it("rejects a note over the limit", async () => {
    const control = new FakeFlowControl();
    const client = await connect(control);

    const outcome = await call(client, "decide", {
      runId: "run-1",
      decision: "approve",
      note: "x".repeat(1001),
    });

    expect(outcome.isError).toBe(true);
    expect(control.calls).toEqual([]);
  });

  it("accepts a note of exactly the limit", async () => {
    const control = new FakeFlowControl();
    const client = await connect(control);

    const outcome = await call(client, "decide", {
      runId: "run-1",
      decision: "approve",
      note: "x".repeat(1000),
    });

    expect(outcome.isError).toBe(false);
  });
});

describe("flow tool results and errors", () => {
  it("renders a run view as indented JSON", async () => {
    const client = await connect(new FakeFlowControl());
    const { text } = await call(client, "flow_status", { runId: "run-1" });
    expect(text).toBe(JSON.stringify(SAMPLE_RUN, null, 2));
  });

  it("answers stop_flow with a plain confirmation", async () => {
    const client = await connect(new FakeFlowControl());
    expect(await call(client, "stop_flow", { runId: "run-1" })).toEqual({
      text: "Stopped",
      isError: false,
    });
  });

  it("maps an IpcError to its message", async () => {
    const control = new FakeFlowControl();
    control.failure = new IpcError(IpcErrorCode.CONFLICT, "run is busy");
    const client = await connect(control);
    expect(await call(client, "stop_flow", { runId: "run-1" })).toEqual({
      text: "run is busy",
      isError: true,
    });
    expect(control.calls).toEqual([
      { op: FlowControlOp.stop, args: ["run-1"] },
    ]);
  });

  it("hides the message of an unexpected error and logs it", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const control = new FakeFlowControl();
    const failure = new Error("secret path /home/x");
    control.failure = failure;
    const client = await connect(control);
    expect(await call(client, "flow_status", { runId: "run-1" })).toEqual({
      text: "Internal error",
      isError: true,
    });
    expect(logged).toHaveBeenCalledWith(failure);
  });
});
