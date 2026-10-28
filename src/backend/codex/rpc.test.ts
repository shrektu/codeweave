import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { collectLines } from "../../../tests/fakes/processHelpers";

import { CodexRpcError, createCodexRpc } from "./rpc";

const ResultSchema = z.looseObject({ ok: z.boolean() });

function setup(): {
  input: PassThrough;
  lines: string[];
  rpc: ReturnType<typeof createCodexRpc>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = collectLines(output);
  return { input, lines, rpc: createCodexRpc(input, output) };
}

function feed(input: PassThrough, message: unknown): void {
  input.write(`${JSON.stringify(message)}\n`);
}

describe("codex rpc framing", () => {
  it("request_writes_id_method_params_without_jsonrpc_field", async () => {
    const { input, lines, rpc } = setup();

    const first = rpc.request("a/b", { x: 1 }, ResultSchema);
    const second = rpc.request("c/d", undefined, ResultSchema);
    await vi.waitFor(() => {
      expect(lines).toHaveLength(2);
    });
    feed(input, { id: 0, result: { ok: true } });
    feed(input, { id: 1, result: { ok: false } });

    expect(lines).toEqual([
      '{"id":0,"method":"a/b","params":{"x":1}}',
      '{"id":1,"method":"c/d"}',
    ]);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: false });
  });

  it("notify_without_params_omits_the_params_key", async () => {
    const { lines, rpc } = setup();

    rpc.notify("initialized");
    rpc.notify("other", { a: 1 });

    await vi.waitFor(() => {
      expect(lines).toEqual([
        '{"method":"initialized"}',
        '{"method":"other","params":{"a":1}}',
      ]);
    });
  });

  it("error_response_rejects_with_typed_rpc_error", async () => {
    const { input, rpc } = setup();

    const pending = rpc.request("a/b", {}, ResultSchema);
    feed(input, {
      id: 0,
      error: { code: -32600, message: "Not initialized", data: { why: 1 } },
    });

    const error: unknown = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error).toMatchObject({
      code: -32600,
      message: "Not initialized",
      data: { why: 1 },
    });
  });
});

describe("codex rpc failures", () => {
  it("peer_close_rejects_pending_requests", async () => {
    const { input, rpc } = setup();

    const pending = rpc.request("a/b", {}, ResultSchema);
    input.end();

    await expect(pending).rejects.toBeInstanceOf(CodexRpcError);
    await expect(rpc.request("c/d", {}, ResultSchema)).rejects.toBeInstanceOf(
      CodexRpcError,
    );
  });

  it("stdout_stream_error_closes_peer_without_crash", async () => {
    const { input, rpc } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pending = rpc.request("a/b", {}, ResultSchema);
    input.destroy(new Error("EPIPE"));

    await expect(pending).rejects.toBeInstanceOf(CodexRpcError);
    await expect(rpc.closed).resolves.toBeUndefined();
    await expect(rpc.request("c/d", {}, ResultSchema)).rejects.toBeInstanceOf(
      CodexRpcError,
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("garbage_line_is_ignored_and_later_response_still_resolves", async () => {
    const { input, rpc } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pending = rpc.request("a/b", {}, ResultSchema);
    input.write("this is not json\n");
    feed(input, { id: 0, result: { ok: true } });

    await expect(pending).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("response_failing_the_schema_rejects_the_request", async () => {
    const { input, rpc } = setup();

    const pending = rpc.request("a/b", {}, ResultSchema);
    feed(input, { id: 0, result: { ok: "yes" } });

    await expect(pending).rejects.toThrow("Invalid a/b response");
  });
});

describe("codex rpc inbound messages", () => {
  it("routes_notifications_and_server_requests_and_answers_with_same_id", async () => {
    const { input, lines, rpc } = setup();
    const notifications: [string, unknown][] = [];
    const requests: [number | string, string, unknown][] = [];
    rpc.onNotification((method, params) => {
      notifications.push([method, params]);
    });
    rpc.onServerRequest((id, method, params) => {
      requests.push([id, method, params]);
    });

    feed(input, { method: "turn/started", params: { a: 1 } });
    feed(input, { method: "item/x/requestApproval", id: 7, params: { b: 2 } });
    feed(input, { method: "item/y/requestApproval", id: "s-1" });
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    rpc.respond(7, { decision: "accept" });
    rpc.respondError("s-1", -32601, "Method not found");

    expect(notifications).toEqual([["turn/started", { a: 1 }]]);
    expect(requests).toEqual([
      [7, "item/x/requestApproval", { b: 2 }],
      ["s-1", "item/y/requestApproval", undefined],
    ]);
    await vi.waitFor(() => {
      expect(lines).toEqual([
        '{"id":7,"result":{"decision":"accept"}}',
        '{"id":"s-1","error":{"code":-32601,"message":"Method not found"}}',
      ]);
    });
  });

  it("handler_exception_does_not_break_later_messages", async () => {
    const { input, rpc } = setup();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const seen: string[] = [];
    rpc.onNotification((method) => {
      seen.push(method);
      if (method === "first") {
        throw new Error("boom");
      }
    });

    feed(input, { method: "first" });
    feed(input, { method: "second" });

    await vi.waitFor(() => {
      expect(seen).toEqual(["first", "second"]);
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
