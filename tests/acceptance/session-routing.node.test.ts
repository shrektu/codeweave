import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import type { ApiProviderId } from "../../src/domain/apiProviders";
import type { TaskClass } from "../../src/domain/taskClass";
import { ProviderId } from "../../src/domain/types";
import type { ParamsMap } from "../../src/shared/protocol";
import type { AccountView, SessionView } from "../../src/shared/views";
import {
  ACCOUNT_A,
  agentOf,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import {
  OPENCODE_SESSION_ID,
  type OpencodeStep,
} from "../fakes/fakeOpencodeServer";
import { settled } from "../fakes/settle";

const PROMPT_PATH = `/session/${OPENCODE_SESSION_ID}/prompt_async`;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const RATE_LIMITED: OpencodeStep = {
  type: "error",
  name: "APIError",
  message: "Rate limit exceeded",
  statusCode: 429,
  headers: { "retry-after": "120" },
};
const EXHAUSTED_TURN: readonly OpencodeStep[] = [
  RATE_LIMITED,
  { type: "idle" },
];
const PromptBodySchema = z.looseObject({
  model: z.looseObject({ modelID: z.string() }).optional(),
});

interface ApiSpec {
  readonly label: string;
  readonly provider: ApiProviderId;
  readonly model?: string;
}

afterEach(closeRigs);

async function addApi(rig: BackendRig, spec: ApiSpec): Promise<AccountView> {
  const { account } = await rig.call("accounts/add", {
    label: spec.label,
    configDir: join(rig.userData, "accounts", spec.label.replaceAll(" ", "-")),
    provider: ProviderId.opencode,
    api: {
      provider: spec.provider,
      model: spec.model ?? GROQ_MODEL,
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: `sk-test-${spec.label.toLowerCase().replaceAll(" ", "-")}-0001`,
  });
  return account;
}

function promptedModels(rig: BackendRig, serverIndex: number): string[] {
  const server = rig.opencodeContainer.servers[serverIndex];
  if (server === undefined) {
    throw new Error(`opencode server ${String(serverIndex)} was not spawned`);
  }
  return server
    .requestsTo("POST", PROMPT_PATH)
    .map(
      (request) =>
        PromptBodySchema.parse(request.body).model?.modelID ?? "<none>",
    );
}

async function startOpencode(
  rig: BackendRig,
  extra: Partial<ParamsMap["session/start"]> = {},
): Promise<void> {
  await rig.call("session/start", {
    cwd: rig.cwd,
    provider: ProviderId.opencode,
    ...extra,
  });
}

async function turnSettled(rig: BackendRig): Promise<SessionView> {
  return settled(async () => {
    const view = await rig.session();
    expect(view.turnInFlight).toBe(false);
    return view;
  });
}

async function promptAndSettle(
  rig: BackendRig,
  params: ParamsMap["session/prompt"],
): Promise<SessionView> {
  await rig.call("session/prompt", params);
  return turnSettled(rig);
}

async function promptOn(
  rig: BackendRig,
  text: string,
  taskClass: TaskClass,
): Promise<SessionView> {
  return promptAndSettle(rig, { text, taskClass });
}

async function runningOn(rig: BackendRig, accountId: string): Promise<void> {
  await settled(async () => {
    const view = await rig.session();
    expect(view.phase).toEqual({ phase: "running", accountId });
    expect(view.turnInFlight).toBe(false);
  });
}

it("routes each class on a groq account", async () => {
  const rig = await openRig({});
  const groq = await addApi(rig, { label: "Groq A", provider: "groq" });
  await startOpencode(rig);

  await promptOn(rig, "small chore", "light");
  const view = await promptOn(rig, "big refactor", "heavy");

  expect(promptedModels(rig, 0)).toEqual([
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
  ]);
  expect(view.turns).toEqual([
    {
      promptSeq: 0,
      accountId: groq.id,
      model: "openai/gpt-oss-20b",
      effectiveModel: null,
      apiProvider: "groq",
      requestedClass: "light",
      servedClass: "light",
      source: "routed",
    },
    {
      promptSeq: 1,
      accountId: groq.id,
      model: "openai/gpt-oss-120b",
      effectiveModel: null,
      apiProvider: "groq",
      requestedClass: "heavy",
      servedClass: "heavy",
      source: "routed",
    },
  ]);
});

it("standard falls back to the stronger class in the session", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Groq A", provider: "groq" });
  await startOpencode(rig);

  const view = await promptOn(rig, "regular work", "standard");

  expect(promptedModels(rig, 0)).toEqual(["openai/gpt-oss-120b"]);
  expect(view.turns[0]).toMatchObject({
    model: "openai/gpt-oss-120b",
    requestedClass: "standard",
    servedClass: "heavy",
    source: "routed",
  });
});

it("rotation routes the resend on the next account", async () => {
  const rig = await openRig({});
  const groq = await addApi(rig, { label: "Groq A", provider: "groq" });
  const cerebras = await addApi(rig, {
    label: "Cerebras B",
    provider: "cerebras",
  });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);
  await startOpencode(rig);

  await rig.call("session/prompt", {
    text: "big refactor",
    taskClass: "heavy",
  });
  await runningOn(rig, cerebras.id);
  const view = await rig.session();

  expect(promptedModels(rig, 0)).toEqual(["openai/gpt-oss-120b"]);
  await settled(() => {
    expect(promptedModels(rig, 1)).toEqual(["qwen-3.8-27b"]);
  });
  expect(view.turns).toEqual([
    {
      promptSeq: 0,
      accountId: cerebras.id,
      model: "qwen-3.8-27b",
      effectiveModel: null,
      apiProvider: "cerebras",
      requestedClass: "heavy",
      servedClass: "heavy",
      source: "routed",
    },
  ]);
  expect(groq.id).not.toBe(cerebras.id);
});

it("agent model stays on its own provider after rotation", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Groq A", provider: "groq" });
  const cerebras = await addApi(rig, {
    label: "Cerebras B",
    provider: "cerebras",
  });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);
  await startOpencode(rig, {
    model: { provider: ProviderId.opencode, model: "groq/openai/gpt-oss-20b" },
  });

  await rig.call("session/prompt", { text: "go" });
  await runningOn(rig, cerebras.id);
  const view = await rig.session();

  expect(promptedModels(rig, 0)).toEqual(["openai/gpt-oss-20b"]);
  await settled(() => {
    expect(promptedModels(rig, 1)).toEqual(["qwen-3.8-27b"]);
  });
  expect(view.turns).toEqual([
    expect.objectContaining({
      accountId: cerebras.id,
      model: "qwen-3.8-27b",
      source: "routed",
    }),
  ]);
});

it("agent model is used as sent on its own provider", async () => {
  const rig = await openRig({});
  const groq = await addApi(rig, { label: "Groq A", provider: "groq" });
  await startOpencode(rig, {
    model: { provider: ProviderId.opencode, model: "groq/openai/gpt-oss-20b" },
  });

  const view = await promptOn(rig, "go", "heavy");

  expect(promptedModels(rig, 0)).toEqual(["openai/gpt-oss-20b"]);
  expect(view.turns).toEqual([
    {
      promptSeq: 0,
      accountId: groq.id,
      model: "openai/gpt-oss-20b",
      effectiveModel: null,
      apiProvider: "groq",
      requestedClass: "heavy",
      servedClass: null,
      source: "agent",
    },
  ]);
});

it("override for another provider falls back to routing", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Groq A", provider: "groq" });
  const cerebras = await addApi(rig, {
    label: "Cerebras B",
    provider: "cerebras",
  });
  rig.opencodeContainer.scriptNextServer(EXHAUSTED_TURN);
  await startOpencode(rig);

  await rig.call("session/prompt", {
    text: "go",
    taskClass: "light",
    model: { provider: ProviderId.opencode, model: "cerebras/qwen-3.8-27b" },
  });
  await runningOn(rig, cerebras.id);
  const view = await rig.session();

  expect(promptedModels(rig, 0)).toEqual(["openai/gpt-oss-20b"]);
  await settled(() => {
    expect(promptedModels(rig, 1)).toEqual(["qwen-3.8-27b"]);
  });
  expect(view.turns).toEqual([
    expect.objectContaining({
      accountId: cerebras.id,
      model: "qwen-3.8-27b",
      requestedClass: "light",
      servedClass: null,
      source: "override",
    }),
  ]);
});

it("subscription session uses the CLI default", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });
  rig.container.scriptNext([
    { type: "text", text: "done" },
    { type: "end", stopReason: "end_turn" },
  ]);
  await rig.call("session/start", { cwd: rig.cwd });

  const view = await promptOn(rig, "go", "light");

  expect(agentOf(rig).configCalls).toEqual([]);
  expect(view.turns).toEqual([
    {
      promptSeq: 0,
      accountId: ACCOUNT_A.id,
      model: null,
      effectiveModel: null,
      apiProvider: null,
      requestedClass: "light",
      servedClass: null,
      source: "cli_default",
    },
  ]);
});

it("free z.ai account never gets a paid model", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Zai A", provider: "zai", model: "glm-5.3" });
  await startOpencode(rig);

  await promptOn(rig, "heavy one", "heavy");
  await promptOn(rig, "regular one", "standard");
  const view = await promptOn(rig, "light one", "light");

  expect(promptedModels(rig, 0)).toEqual([
    "glm-4.7-flash",
    "glm-4.7-flash",
    "glm-4.7-flash",
  ]);
  expect(view.turns.map((turn) => turn.servedClass)).toEqual([
    "light",
    "light",
    "light",
  ]);
});

it("prompt class beats node and agent class", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Groq A", provider: "groq" });
  await startOpencode(rig, { taskClass: "heavy" });

  await promptOn(rig, "first", "light");
  const view = await promptAndSettle(rig, { text: "second" });

  expect(promptedModels(rig, 0)).toEqual([
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
  ]);
  expect(view.turns.map((turn) => turn.requestedClass)).toEqual([
    "light",
    "heavy",
  ]);
});

it("settings default class applies when no layer sets one", async () => {
  const rig = await openRig({});
  await addApi(rig, { label: "Groq A", provider: "groq" });
  await rig.call("settings/set", { defaultTaskClass: "light" });
  await startOpencode(rig);

  const view = await promptAndSettle(rig, { text: "go" });

  expect(promptedModels(rig, 0)).toEqual(["openai/gpt-oss-20b"]);
  expect(view.turns[0]?.requestedClass).toBe("light");
});

it("adapter model event fills the turn", async () => {
  const rig = await openRig({
    opencodeConfig: {
      assistantModel: { providerID: "groq", modelID: "gpt-oss-20b-0925" },
    },
  });
  await addApi(rig, { label: "Groq A", provider: "groq" });
  await startOpencode(rig);

  const view = await promptOn(rig, "go", "light");

  expect(view.turns).toEqual([
    expect.objectContaining({
      model: "openai/gpt-oss-20b",
      effectiveModel: "gpt-oss-20b-0925",
    }),
  ]);
});

it("free z.ai account ignores an explicit paid model", async () => {
  const rig = await openRig({});
  await addApi(rig, {
    label: "Zai A",
    provider: "zai",
    model: "glm-4.7-flash",
  });
  await startOpencode(rig, {
    model: { provider: ProviderId.opencode, model: "zai/glm-5.3" },
  });

  await promptAndSettle(rig, { text: "agent model" });
  const view = await promptAndSettle(rig, {
    text: "override",
    taskClass: "heavy",
    model: { provider: ProviderId.opencode, model: "zai/glm-5.3" },
  });

  expect(promptedModels(rig, 0)).toEqual(["glm-4.7-flash", "glm-4.7-flash"]);
  expect(view.turns.map((turn) => turn.source)).toEqual(["routed", "routed"]);
});

it("every turn gets its effective model", async () => {
  const rig = await openRig({
    opencodeConfig: {
      assistantModel: { providerID: "groq", modelID: "gpt-oss-20b-0925" },
    },
  });
  await addApi(rig, { label: "Groq A", provider: "groq" });
  await startOpencode(rig);

  await promptOn(rig, "first", "light");
  const view = await promptOn(rig, "second", "light");

  expect(view.turns.map((turn) => turn.effectiveModel)).toEqual([
    "gpt-oss-20b-0925",
    "gpt-oss-20b-0925",
  ]);
});

it("explicit paid model on a custom endpoint routes to the account model", async () => {
  const rig = await openRig({});
  await addApi(rig, {
    label: "Custom A",
    provider: "custom",
    model: "account-model",
  });
  await startOpencode(rig, {
    model: { provider: ProviderId.opencode, model: "custom/requested-model" },
  });

  const view = await promptOn(rig, "go", "standard");

  expect(promptedModels(rig, 0)).toEqual(["account-model"]);
  expect(view.turns).toEqual([
    expect.objectContaining({
      model: "account-model",
      source: "account",
    }),
  ]);
});
