import { request } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FakeFlowControl,
  FlowControlOp,
} from "../../../tests/fakes/fakeFlowControl";
import {
  postExpectingContinue,
  postRevokedInFlight,
} from "../../../tests/fakes/inFlightPost";
import { startFlowToolServer, type FlowToolServer } from "./server";

const MIB = 1024 * 1024;
const LIST_FLOWS_CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_flows", arguments: {} },
});

interface PostOptions {
  readonly path?: string;
  readonly host?: string;
  readonly token?: string;
  readonly body?: string;
}

let server: FlowToolServer;
let control: FakeFlowControl;
let token: string;

function post(options: PostOptions): Promise<number> {
  const target = new URL(server.url);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${options.token ?? token}`,
  };
  if (options.host !== undefined) {
    headers.Host = options.host;
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method: "POST",
        headers,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(options.body ?? LIST_FLOWS_CALL);
  });
}

beforeEach(async () => {
  server = await startFlowToolServer();
  control = new FakeFlowControl();
  token = server.register(control).token;
});

afterEach(async () => {
  await server.close();
});

describe("flow tool server continue gating", () => {
  it("sends no continue to a request without a valid token", async () => {
    const url = server.url;
    const body = LIST_FLOWS_CALL;
    const revoked = server.register(control).token;
    server.revoke(revoked);
    const outcomes = [
      await postExpectingContinue({ url, body }),
      await postExpectingContinue({ url, body, token: "wrong" }),
      await postExpectingContinue({ url, body, token: revoked }),
    ];
    expect(outcomes).toEqual([
      { status: 401, continued: false },
      { status: 401, continued: false },
      { status: 401, continued: false },
    ]);
    expect(control.calls).toEqual([]);
  });

  it("sends no continue to a foreign host or path", async () => {
    const url = server.url;
    const body = LIST_FLOWS_CALL;
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

describe("flow tool server transport rules", () => {
  it("binds a loopback url with the mcp path", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("answers 413 to a body over one MiB without calling the control", async () => {
    expect(await post({ body: "x".repeat(MIB + 1) })).toBe(413);
    expect(control.calls).toEqual([]);
  });

  it("rejects a request revoked while its body is in flight", async () => {
    const outcome = await postRevokedInFlight(
      server.url,
      token,
      LIST_FLOWS_CALL,
      () => {
        server.revoke(token);
      },
    );
    expect(outcome).toEqual({ status: 401, continued: true });
    expect(control.calls).toEqual([]);
  });

  it("answers 404 to another path", async () => {
    expect(await post({ path: "/other" })).toBe(404);
    expect(control.calls).toEqual([]);
  });

  it("answers 400 to a body that is not JSON", async () => {
    expect(await post({ body: "{nope" })).toBe(400);
    expect(control.calls).toEqual([]);
  });

  it("accepts the loopback and localhost hosts with the right port", async () => {
    const { port } = new URL(server.url);
    expect(await post({ host: `127.0.0.1:${port}` })).toBe(200);
    expect(await post({ host: `localhost:${port}` })).toBe(200);
    expect(control.calls).toEqual([
      { op: FlowControlOp.listFlows, args: [] },
      { op: FlowControlOp.listFlows, args: [] },
    ]);
  });

  it("answers 403 to a wrong port, a missing port or a foreign host", async () => {
    const { port } = new URL(server.url);
    const statuses = [
      await post({ host: "localhost:1" }),
      await post({ host: "127.0.0.1" }),
      await post({ host: `evil.example:${port}` }),
      await post({ host: `127.0.0.1.evil.example:${port}` }),
    ];
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(control.calls).toEqual([]);
  });
});
