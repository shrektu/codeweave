import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createOpencodeClient, type OpencodeClient } from "./client";

const SERVER_SECRET = randomUUID();
const REQUEST_TIMEOUT_MS = 20;
const WARM_UP_TIMEOUT_MS = 300;
const SLOW_RESPONSE_MS = 80;
const OBSERVATION_MS = 150;
const SETTLE_WINDOW_MS = 1000;
const HUNG = "hung";

const stalledFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });

function slowFetch(delayMs: number): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(Response.json({ id: "ses_1" }));
      }, delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
}

function endlessStreamFetch(seen: AbortSignal[]): typeof fetch {
  return (_input, init) => {
    if (init?.signal) {
      seen.push(init.signal);
    }
    return Promise.resolve(
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
}

function clientWith(fetchImpl: typeof fetch): OpencodeClient {
  return createOpencodeClient({
    baseUrl: "http://127.0.0.1:1",
    password: SERVER_SECRET,
    directory: "/work",
    fetchImpl,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    warmUpTimeoutMs: REQUEST_TIMEOUT_MS,
  });
}

function outcomeOf(work: Promise<unknown>): Promise<string> {
  return Promise.race([
    work
      .then(() => "resolved")
      .catch((error: unknown) =>
        error instanceof Error ? "rejected" : "unexpected",
      ),
    new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve(HUNG);
      }, SETTLE_WINDOW_MS),
    ),
  ]);
}

describe("request timeouts", () => {
  it("client_request_times_out", async () => {
    const client = clientWith(stalledFetch);

    expect(await outcomeOf(client.warmUp())).toBe("rejected");
    expect(await outcomeOf(client.createSession())).toBe("rejected");
    expect(
      await outcomeOf(
        client.promptAsync({ sessionId: "ses_1", text: "go", agent: "build" }),
      ),
    ).toBe("rejected");
    expect(await outcomeOf(client.abort("ses_1"))).toBe("rejected");
    expect(
      await outcomeOf(client.replyPermission("ses_1", "per_1", "once")),
    ).toBe("rejected");
  });

  it("warm_up_uses_its_own_timeout", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://127.0.0.1:1",
      password: SERVER_SECRET,
      directory: "/work",
      fetchImpl: slowFetch(SLOW_RESPONSE_MS),
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      warmUpTimeoutMs: WARM_UP_TIMEOUT_MS,
    });

    expect(await outcomeOf(client.warmUp())).toBe("resolved");
    expect(await outcomeOf(client.createSession())).toBe("rejected");
  });

  it("warm_up_beyond_its_timeout_is_rejected", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://127.0.0.1:1",
      password: SERVER_SECRET,
      directory: "/work",
      fetchImpl: stalledFetch,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      warmUpTimeoutMs: WARM_UP_TIMEOUT_MS,
    });

    expect(await outcomeOf(client.warmUp())).toBe("rejected");
  });

  it("event_stream_request_is_not_timed", async () => {
    const seen: AbortSignal[] = [];
    const caller = new AbortController();
    const client = clientWith(endlessStreamFetch(seen));

    await client.events(caller.signal);
    await new Promise((resolve) => setTimeout(resolve, OBSERVATION_MS));

    expect(seen.map((signal) => signal.aborted)).toEqual([false]);
    caller.abort();
    expect(seen.map((signal) => signal.aborted)).toEqual([true]);
  });
});
