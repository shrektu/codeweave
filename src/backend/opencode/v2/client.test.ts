import { describe, expect, it } from "vitest";

import { OpencodeHttpError } from "../client";

import { createOpencodeV2Client, type OpencodeV2Client } from "./client";

const PASSWORD = "pw-test-fake";
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
const DIRECTORY = "/work/project";

interface Recorded {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly directory: string | null;
  readonly body: unknown;
  readonly authorization: string | null;
  readonly contentType: string | null;
}

interface Harness {
  readonly client: OpencodeV2Client;
  readonly requests: Recorded[];
}

function harness(respond: () => Response): Harness {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      pathname: url.pathname,
      search: url.search,
      directory: url.searchParams.get("location[directory]"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
    });
    return Promise.resolve(respond());
  };
  const client = createOpencodeV2Client({
    baseUrl: "http://127.0.0.1:4096",
    password: PASSWORD,
    directory: DIRECTORY,
    fetchImpl,
  });
  return { client, requests };
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

describe("v2 client requests", () => {
  it("warm_up_requests_the_provider_list_for_the_location", async () => {
    const { client, requests } = harness(() =>
      Response.json({ data: [{ settings: { apiKey: "sk-test-fake" } }] }),
    );

    await client.warmUp();

    expect(requests).toEqual([
      {
        method: "GET",
        pathname: "/api/provider",
        search: `?location%5Bdirectory%5D=${encodeURIComponent(DIRECTORY)}`,
        directory: DIRECTORY,
        body: undefined,
        authorization: AUTHORIZATION,
        contentType: null,
      },
    ]);
  });

  it("warm_up_discards_the_provider_body", async () => {
    const { client } = harness(() =>
      Response.json({ data: [{ settings: { apiKey: "sk-test-fake" } }] }),
    );

    await expect(client.warmUp()).resolves.toBeUndefined();
  });

  it("create_session_posts_the_location_and_agent", async () => {
    const { client, requests } = harness(() =>
      Response.json({ data: { id: "ses_1", cost: 0 } }),
    );

    expect(await client.createSession("plan")).toBe("ses_1");
    expect(requests).toEqual([
      {
        method: "POST",
        pathname: "/api/session",
        search: "",
        directory: null,
        body: { location: { directory: DIRECTORY }, agent: "plan" },
        authorization: AUTHORIZATION,
        contentType: "application/json",
      },
    ]);
  });
});

describe("v2 client session actions", () => {
  it("prompt_posts_the_text", async () => {
    const { client, requests } = harness(() =>
      Response.json({ data: { id: "msg_1" } }),
    );

    await client.prompt("ses_1", "hello");

    expect(requests).toMatchObject([
      {
        method: "POST",
        pathname: "/api/session/ses_1/prompt",
        search: "",
        body: { text: "hello" },
        authorization: AUTHORIZATION,
      },
    ]);
  });

  it("switch_agent_posts_the_agent", async () => {
    const { client, requests } = harness(noContent);

    await client.switchAgent("ses_1", "build");

    expect(requests).toMatchObject([
      {
        method: "POST",
        pathname: "/api/session/ses_1/agent",
        search: "",
        body: { agent: "build" },
      },
    ]);
  });
});

describe("v2 client model and interrupt", () => {
  it("switch_model_posts_the_model_reference", async () => {
    const { client, requests } = harness(noContent);

    await client.switchModel("ses_1", { id: "llama", providerID: "groq" });

    expect(requests).toMatchObject([
      {
        method: "POST",
        pathname: "/api/session/ses_1/model",
        search: "",
        body: { model: { id: "llama", providerID: "groq" } },
      },
    ]);
  });

  it.each([true, false])("interrupt_returns_%s", async (flag) => {
    const { client, requests } = harness(() =>
      Response.json({ interrupted: flag }),
    );

    expect(await client.interrupt("ses_1")).toBe(flag);
    expect(requests).toMatchObject([
      {
        method: "POST",
        pathname: "/api/session/ses_1/interrupt",
        search: "",
        body: undefined,
        contentType: null,
      },
    ]);
  });
});

describe("v2 client replies and errors", () => {
  it("reply_permission_posts_the_decision", async () => {
    const { client, requests } = harness(noContent);

    await client.replyPermission("ses_1", "per_1", "always");

    expect(requests).toMatchObject([
      {
        method: "POST",
        pathname: "/api/session/ses_1/permission/per_1/reply",
        search: "",
        body: { decision: "always" },
      },
    ]);
  });

  it("is_active_checks_the_active_session_map", async () => {
    const { client, requests } = harness(() =>
      Response.json({ data: { ses_1: { type: "running" } } }),
    );

    expect(await client.isActive("ses_1")).toBe(true);
    expect(await client.isActive("ses_2")).toBe(false);
    expect(await client.isActive("constructor")).toBe(false);
    expect(requests[0]).toMatchObject({
      method: "GET",
      pathname: "/api/session/active",
      search: "",
    });
  });

  it("session_ids_are_url_encoded", async () => {
    const { client, requests } = harness(noContent);

    await client.replyPermission("a/b c", "p?1", "once");

    expect(requests[0]?.pathname).toBe(
      "/api/session/a%2Fb%20c/permission/p%3F1/reply",
    );
  });

  it("non_2xx_raises_opencode_http_error", async () => {
    const { client } = harness(() =>
      Response.json({ _tag: "NotFound" }, { status: 404 }),
    );

    await expect(client.prompt("ses_1", "x")).rejects.toMatchObject({
      name: OpencodeHttpError.name,
      status: 404,
      message: "opencode POST /api/session/ses_1/prompt failed with HTTP 404",
    });
  });
});

describe("v2 client events", () => {
  it("events_skip_unparseable_frames", async () => {
    const frames = [
      'data: {"type":"server.connected","data":{}}',
      'data: {"type":"session.usage.updated","data":{"sessionID":"ses_1"}}',
      'data: {"type":"session.text.delta","data":{"sessionID":"ses_1"}}',
      'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}',
    ];
    const { client, requests } = harness(
      () => new Response(`${frames.join("\n\n")}\n\n`),
    );

    const seen: string[] = [];
    for await (const event of await client.events(
      new AbortController().signal,
    )) {
      seen.push(event.type);
    }

    expect(seen).toEqual(["server.connected", "session.execution.succeeded"]);
    expect(requests).toMatchObject([
      { method: "GET", pathname: "/api/event", search: "" },
    ]);
  });
});
