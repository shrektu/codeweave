import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, vi } from "vitest";

import { execText } from "../../src/backend/exec";
import type {
  FlowControl,
  FlowStartRequest,
} from "../../src/backend/flowTools/control";
import {
  startFlowToolServer,
  type FlowToolServer,
  type ToolGrant,
} from "../../src/backend/flowTools/server";
import type { FlowDecision } from "../../src/domain/flowRun";
import type { MergeOutcome } from "../../src/domain/types";
import type { FlowRunView, FlowsList } from "../../src/shared/views";

import { settled } from "./settle";
import type { BackendRig } from "./backendRig";
import type { FakeAcpAgent } from "./fakeAcpAgent";

const AGENTS = `---
id: coder
role: Writes the change
provider: claude
permissionProfile: unattended
---

Write small, tested changes.

---
id: reviewer
role: Reviews the change
provider: claude
permissionProfile: unattended
---

Review the diff and report bugs only.
`;

const BUILD_REVIEW_NODES = `  - id: build
    agent: coder
  - id: review
    agent: reviewer
`;

export const FLOW_FILES: Readonly<Record<string, string>> = {
  "agents/team.md": AGENTS,
  "flows/solo.md": `---\nid: solo\ntitle: Flow solo\nnodes:\n  - id: build\n    agent: coder\nedges: []\n---\n`,
  "flows/gated.md": `---
id: gated
title: Flow gated
nodes:
${BUILD_REVIEW_NODES}edges:
  - from: build
    to: review
    kind: hands_off_to
    gate: true
---
`,
};

export const TASK = "Add a login form";
export const TOOL_SERVER_NAME = "codeweave";
export const BASE_FILE = "a.txt";
export const BASE_CONTENT = "one\n";

export interface ToolEndpoint {
  readonly url: string;
  readonly token: string;
}

export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

export interface ToolClient {
  call(name: string, args: Record<string, unknown>): Promise<ToolReply>;
  json(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface FlowRepo {
  readonly root: string;
  readonly repo: string;
}

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

export function isolateGitEnv(): void {
  for (const [name, value] of Object.entries(GIT_ENV)) {
    vi.stubEnv(name, value);
  }
}

export function restoreEnv(): void {
  vi.unstubAllEnvs();
}

export function git(cwd: string, args: readonly string[]): Promise<string> {
  return execText("git", ["-C", cwd, ...args], { env: GIT_ENV });
}

export async function writeFlowFiles(dir: string): Promise<void> {
  for (const [file, text] of Object.entries(FLOW_FILES)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
}

export const IGNORE_FLOW_FILES = "flows/\nagents/\n";

export async function createFlowRepo(
  options: { readonly ignoreFlowFiles?: boolean } = {},
): Promise<FlowRepo> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cw-orch-")));
  const repo = join(root, "project");
  await mkdir(repo);
  await git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, BASE_FILE), BASE_CONTENT);
  if (options.ignoreFlowFiles === true) {
    await writeFile(join(repo, ".gitignore"), IGNORE_FLOW_FILES);
  }
  await writeFlowFiles(repo);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "-m", "Initial commit"]);
  return { root, repo };
}

export function removeFlowRepo(flowRepo: FlowRepo): Promise<void> {
  return rm(flowRepo.root, { recursive: true, force: true });
}

export function toolEndpointOf(agent: FakeAcpAgent, index = 0): ToolEndpoint {
  const servers = agent.newSessions[index]?.mcpServers;
  expect(servers).toHaveLength(1);
  const server = servers?.[0];
  if (server === undefined || !("url" in server)) {
    throw new Error("the session carries no http mcp server");
  }
  const bearer = server.headers.find(
    (header) => header.name === "Authorization",
  );
  if (bearer === undefined) {
    throw new Error("the mcp server carries no bearer header");
  }
  return { url: server.url, token: bearer.value.replace("Bearer ", "") };
}

export async function connectTools(
  endpoint: ToolEndpoint,
): Promise<ToolClient> {
  const client = new Client({ name: "orchestrator-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    }),
  );
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolReply> => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }),
    );
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return { text, isError: result.isError === true };
  };
  return {
    call,
    json: async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const reply = await call(name, args);
      expect(reply.isError).toBe(false);
      return JSON.parse(reply.text);
    },
    close: () => client.close(),
  };
}

export async function postWithToken(
  endpoint: ToolEndpoint,
  token: string,
): Promise<number> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_flows", arguments: {} },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

export interface StartGate {
  readonly entered: PromiseWithResolvers<undefined>;
  readonly release: Promise<undefined>;
}

class GatedStartControl implements FlowControl {
  private readonly inner: FlowControl;
  private readonly gate: StartGate;

  constructor(inner: FlowControl, gate: StartGate) {
    this.inner = inner;
    this.gate = gate;
  }

  listFlows(): Promise<FlowsList> {
    return this.inner.listFlows();
  }

  async startFlow(request: FlowStartRequest): Promise<FlowRunView> {
    this.gate.entered.resolve(undefined);
    await this.gate.release;
    return this.inner.startFlow(request);
  }

  status(runId: string): FlowRunView {
    return this.inner.status(runId);
  }

  nodeResult(runId: string, nodeId: string): string {
    return this.inner.nodeResult(runId, nodeId);
  }

  diff(runId: string): Promise<string> {
    return this.inner.diff(runId);
  }

  decide(
    runId: string,
    decision: FlowDecision,
    note?: string,
  ): Promise<FlowRunView> {
    return this.inner.decide(runId, decision, note);
  }

  stop(runId: string): Promise<void> {
    return this.inner.stop(runId);
  }

  merge(runId: string): Promise<MergeOutcome> {
    return this.inner.merge(runId);
  }

  finishMerge(runId: string): Promise<MergeOutcome> {
    return this.inner.finishMerge(runId);
  }

  abortMerge(runId: string): Promise<void> {
    return this.inner.abortMerge(runId);
  }
}

function wrappedToolServer(
  wrap: (control: FlowControl) => FlowControl,
  grants: ToolGrant[] = [],
): () => Promise<FlowToolServer> {
  return async () => {
    const server = await startFlowToolServer();
    return {
      url: server.url,
      register: (control) => {
        const grant = server.register(wrap(control));
        grants.push(grant);
        return grant;
      },
      revoke: (token) => {
        server.revoke(token);
      },
      close: () => server.close(),
    };
  };
}

export function gatedStartToolServer(
  gate: StartGate,
): () => Promise<FlowToolServer> {
  return wrappedToolServer((control) => new GatedStartControl(control, gate));
}

export function recordingToolServer(
  grants: ToolGrant[],
): () => Promise<FlowToolServer> {
  return wrappedToolServer((control) => control, grants);
}

export async function runViewOf(
  rig: BackendRig,
  runId: string,
): Promise<FlowRunView | undefined> {
  const { flowRuns } = await rig.call("sessions/snapshot", {});
  return flowRuns.find((run) => run.runId === runId);
}

export async function untilRunStatus(
  rig: BackendRig,
  runId: string,
  status: FlowRunView["status"],
): Promise<FlowRunView> {
  return settled(async () => {
    const view = await runViewOf(rig, runId);
    expect(view?.status).toBe(status);
    if (view === undefined) {
      throw new Error("unreachable");
    }
    return view;
  });
}

export async function untilAgents(
  rig: BackendRig,
  count: number,
): Promise<void> {
  await settled(() => {
    expect(rig.container.agents).toHaveLength(count);
  });
}
