import { afterEach, describe, expect, it } from "vitest";

import {
  FakeCodexAppServer,
  type FakeCodexConfig,
} from "../../../tests/fakes/fakeCodexAppServer";
import { FakeContained } from "../../../tests/fakes/fakeContainer";

import { openCodexAccount, withTimeout } from "./handshake";
import { createCodexRpc, type CodexRpc } from "./rpc";

const SHORT_TIMEOUT_MS = 20;
const LONG_TIMEOUT_MS = 5000;

const open: CodexRpc[] = [];

afterEach(() => {
  open.splice(0).forEach((rpc) => {
    rpc.close();
  });
});

function connect(config: FakeCodexConfig): {
  rpc: CodexRpc;
  server: FakeCodexAppServer;
} {
  const contained = new FakeContained("run-1", []);
  const server = new FakeCodexAppServer(contained, config);
  const rpc = createCodexRpc(contained.stdout, contained.stdin);
  open.push(rpc);
  return { rpc, server };
}

describe("openCodexAccount", () => {
  it("reports a logged-in account after the three-step handshake", async () => {
    const { rpc, server } = connect({});

    await expect(openCodexAccount(rpc)).resolves.toEqual({ needsLogin: false });

    expect(server.methods()).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
  });

  it("reports that login is required for a logged-out home", async () => {
    const { rpc } = connect({ loggedIn: false });

    await expect(openCodexAccount(rpc)).resolves.toEqual({ needsLogin: true });
  });
});

describe("withTimeout", () => {
  it("resolves with the value of work that finishes in time", async () => {
    await expect(
      withTimeout(Promise.resolve("done"), LONG_TIMEOUT_MS),
    ).resolves.toBe("done");
  });

  it("rejects when the work outlasts the limit", async () => {
    await expect(
      withTimeout(new Promise<never>(() => undefined), SHORT_TIMEOUT_MS),
    ).rejects.toThrow("Timed out after 20 ms");
  });
});
