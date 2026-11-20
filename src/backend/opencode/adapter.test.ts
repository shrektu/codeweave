import { describe, expect, it } from "vitest";

import type { AgentToolAccess } from "../agentAdapter";

import { secretsOf } from "./adapter";
import type { ApiKeyCredentials, ConsoleLoginCredentials } from "./config";

const API: ApiKeyCredentials = {
  auth: "api_key",
  providerId: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  apiKey: "sk-test-A",
};
const CONSOLE: ConsoleLoginCredentials = {
  auth: "console_login",
  providerId: "opencode-go",
  model: "kimi-k2.7-code",
  baseUrl: null,
};
const TOOLS: AgentToolAccess = {
  server: "codeweave",
  url: "http://127.0.0.1:1/mcp",
  token: "tok-1",
  toolNames: ["ping"],
};

describe("secretsOf", () => {
  it("lists_the_key_and_the_password_without_tools", () => {
    expect(secretsOf(API, "pw", undefined)).toEqual(["sk-test-A", "pw"]);
  });

  it("registers the tool token for an api key run", () => {
    expect(secretsOf(API, "pw", TOOLS)).toEqual(["sk-test-A", "pw", "tok-1"]);
  });

  it("registers the tool token for a console login run", () => {
    expect(secretsOf(CONSOLE, "pw", TOOLS)).toEqual(["pw", "tok-1"]);
  });
});
