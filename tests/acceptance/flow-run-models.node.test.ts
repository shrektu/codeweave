import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import type { Account } from "../../src/domain/types";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACCOUNT_CODEX_A,
  agentOf,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import { agentDelta } from "../fakes/fakeCodexAppServer";
import { OPENCODE_SESSION_ID } from "../fakes/fakeOpencodeServer";
import { settled } from "../fakes/settle";

const PINNED_MODEL = "claude-sonnet-4-5";
const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};

const AGENTS = `---
id: pinned
role: Writes the change
provider: claude
model: ${PINNED_MODEL}
permissionProfile: unattended
---

Write small, tested changes.

---
id: automatic
role: Writes the change
provider: claude
model: auto
permissionProfile: unattended
---

Write small, tested changes.

---
id: heavy-opencode
role: Writes the change
provider: opencode
taskClass: heavy
permissionProfile: unattended
---

Write small, tested changes.
`;

function soloFlow(
  id: string,
  agent: string,
  provider?: string,
  taskClass?: string,
): string {
  const providerLine =
    provider === undefined ? "" : `    provider: ${provider}\n`;
  const classLine =
    taskClass === undefined ? "" : `    taskClass: ${taskClass}\n`;
  return `---\nid: ${id}\ntitle: Flow ${id}\nnodes:\n  - id: build\n    agent: ${agent}\n${providerLine}${classLine}edges: []\n---\n`;
}

const FILES: Readonly<Record<string, string>> = {
  "agents/team.md": AGENTS,
  "flows/pinned.md": soloFlow("pinned", "pinned"),
  "flows/automatic.md": soloFlow("automatic", "automatic"),
  "flows/pinned-on-codex.md": soloFlow("pinned-on-codex", "pinned", "codex"),
  "flows/node-light.md": soloFlow(
    "node-light",
    "heavy-opencode",
    undefined,
    "light",
  ),
  "flows/agent-heavy.md": soloFlow("agent-heavy", "heavy-opencode"),
};
const PROMPT_PATH = `/session/${OPENCODE_SESSION_ID}/prompt_async`;
const PromptBodySchema = z.looseObject({
  model: z.looseObject({ modelID: z.string() }),
});

afterEach(closeRigs);

async function openFlowRig(accounts: readonly Account[]): Promise<BackendRig> {
  const rig = await openRig({ accounts });
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(join(rig.cwd, file, ".."), { recursive: true });
    await writeFile(join(rig.cwd, file), text);
  }
  return rig;
}

async function startAndFinish(rig: BackendRig, flowId: string): Promise<void> {
  await rig.call("flow/start", { cwd: rig.cwd, flowId, task: "Add a form" });
  await settled(async () => {
    const { flowRuns } = await rig.call("sessions/snapshot", {});
    expect(flowRuns.map((run) => run.status)).toEqual(["done"]);
  });
}

function say(text: string): readonly ScriptStep[] {
  return [{ type: "text", text }, END_TURN];
}

function codexTurnParams(rig: BackendRig): unknown[] {
  return rig.codexContainer.servers.flatMap((server) =>
    server.paramsOf("turn/start"),
  );
}

it("agent model reaches the adapter on its own provider", async () => {
  const rig = await openFlowRig([ACCOUNT_A, ACCOUNT_B]);
  rig.container.scriptNext(say("done"));

  await startAndFinish(rig, "pinned");

  expect(agentOf(rig).configCalls).toEqual([
    { configId: "model", value: PINNED_MODEL },
  ]);
  expect(agentOf(rig).callOrder).toEqual(["set_config_option", "prompt"]);
});

it("auto model sends no model", async () => {
  const rig = await openFlowRig([ACCOUNT_A, ACCOUNT_B]);
  rig.container.scriptNext(say("done"));

  await startAndFinish(rig, "automatic");

  expect(agentOf(rig).configCalls).toEqual([]);
  expect(agentOf(rig).prompts).toHaveLength(1);
});

it("flow_run_node_reports_served_model", async () => {
  const rig = await openFlowRig([ACCOUNT_A, ACCOUNT_B]);
  rig.container.scriptNext([
    { type: "usage_update", meta: { "_claude/model": "claude-opus-5-5" } },
    ...say("done"),
  ]);

  await startAndFinish(rig, "automatic");

  const { flowRuns } = await rig.call("sessions/snapshot", {});
  expect(flowRuns.map((run) => run.nodes)).toEqual([
    [
      {
        id: "build",
        status: "done",
        visits: 1,
        result: "done",
        model: "claude-opus-5-5",
      },
    ],
  ]);
});

it("node provider override sends no agent model", async () => {
  const rig = await openFlowRig([ACCOUNT_A, ACCOUNT_CODEX_A]);
  rig.codexContainer.scriptNext([
    agentDelta("m1", "Built on codex"),
    { type: "complete", status: "completed" },
  ]);

  await startAndFinish(rig, "pinned-on-codex");

  const [params] = codexTurnParams(rig);
  expect(params).toEqual(expect.objectContaining({ threadId: "thr-1" }));
  expect(params).not.toHaveProperty("model");
  expect(rig.container.agents).toHaveLength(0);
});

it("agent model stays on its own provider after rotation", async () => {
  const rig = await openFlowRig([ACCOUNT_A, ACCOUNT_CODEX_A]);
  rig.container.scriptNext([RATE_LIMIT_FAILURE]);
  rig.codexContainer.scriptNext([
    agentDelta("m1", "Built on codex"),
    { type: "complete", status: "completed" },
  ]);

  await startAndFinish(rig, "pinned");

  expect(agentOf(rig).configCalls).toEqual([
    { configId: "model", value: PINNED_MODEL },
  ]);
  const [params] = codexTurnParams(rig);
  expect(params).toEqual(expect.objectContaining({ threadId: "thr-1" }));
  expect(params).not.toHaveProperty("model");
});

it("agent model follows rotation within its own provider", async () => {
  const rig = await openFlowRig([ACCOUNT_A, ACCOUNT_B]);
  rig.container.scriptNext([RATE_LIMIT_FAILURE]);
  rig.container.scriptNext(say("done"));

  await startAndFinish(rig, "pinned");

  expect(rig.container.agents).toHaveLength(2);
  expect(agentOf(rig, 1).configCalls).toEqual([
    { configId: "model", value: PINNED_MODEL },
  ]);
});

async function openGroqFlowRig(): Promise<BackendRig> {
  const rig = await openFlowRig([]);
  await rig.call("accounts/add", {
    label: "Groq A",
    configDir: join(rig.userData, "accounts", "groq-a"),
    provider: "opencode",
    api: {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: "sk-test-groq-a-0001",
  });
  return rig;
}

function promptedModels(rig: BackendRig): string[] {
  return (
    rig.opencodeContainer.servers[0]?.requestsTo("POST", PROMPT_PATH) ?? []
  ).map((request) => PromptBodySchema.parse(request.body).model.modelID);
}

it("node task class reaches the session", async () => {
  const rig = await openGroqFlowRig();

  await startAndFinish(rig, "node-light");

  expect(promptedModels(rig)).toEqual(["openai/gpt-oss-20b"]);
});

it("agent task class reaches the session when the node has none", async () => {
  const rig = await openGroqFlowRig();

  await startAndFinish(rig, "agent-heavy");

  expect(promptedModels(rig)).toEqual(["openai/gpt-oss-120b"]);
});
