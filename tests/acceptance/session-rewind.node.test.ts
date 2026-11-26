import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  CHECKPOINT_BLOBS_DIR,
  CHECKPOINT_INDEX_FILE,
  CHECKPOINTS_DIR,
  SESSIONS_DIR,
  STORAGE_VERSION,
} from "../../src/backend/constants";
import type { RewindMode } from "../../src/domain/checkpoints";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import { FlowRunViewSchema, type StoredSession } from "../../src/shared/views";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import type { FakeAcpAgent, ScriptStep } from "../fakes/fakeAcpAgent";
import {
  connectTools,
  TASK,
  toolEndpointOf,
  writeFlowFiles,
  type ToolClient,
} from "../fakes/orchestratorHarness";
import { settled } from "../fakes/settle";

vi.setConfig({ testTimeout: 20_000 });

const END_TURN: ScriptStep = { type: "end", stopReason: "end_turn" };
const CONVERSATION_AND_FILES: RewindMode = "conversation_and_files";
const CONVERSATION: RewindMode = "conversation";
const FILES: RewindMode = "files";

const tempDirs: string[] = [];
const clients: ToolClient[] = [];
const SEEDED_ID = "22222222-2222-4222-8222-222222222222";
let toolCounter = 0;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await closeRigs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempUserData(prefix: string): Promise<string> {
  const userData = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(userData);
  return userData;
}

async function rigWithUserData(prefix: string): Promise<BackendRig> {
  return openRig({
    accounts: [ACCOUNT_A],
    userData: await tempUserData(prefix),
  });
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function seedStoredSession(
  rig: BackendRig,
  sessionId: string,
): Promise<void> {
  const sessions = join(rig.userData, SESSIONS_DIR);
  await mkdir(sessions, { recursive: true });
  const stored: StoredSession = {
    version: STORAGE_VERSION,
    id: sessionId,
    createdAt: 0,
    updatedAt: 0,
    title: "keep",
    cwd: rig.cwd,
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    orchestrate: false,
    archived: false,
    prompts: [
      { seq: 0, text: "keep" },
      { seq: 2, text: "cut" },
    ],
    messages: [],
    toolCalls: [],
    turns: [],
    lastTurn: null,
    nativeSessions: [],
  };
  await writeFile(join(sessions, `${sessionId}.json`), JSON.stringify(stored));
}

async function seedCheckpoint(
  rig: BackendRig,
  sessionId: string,
  path: string,
): Promise<void> {
  const sessionDir = join(rig.userData, CHECKPOINTS_DIR, sessionId);
  const blobs = join(sessionDir, CHECKPOINT_BLOBS_DIR);
  await mkdir(blobs, { recursive: true });
  const before = "v0\n";
  const after = "v1\n";
  await writeFile(join(blobs, hashOf(before)), before);
  await writeFile(join(blobs, hashOf(after)), after);
  await writeFile(
    join(sessionDir, CHECKPOINT_INDEX_FILE),
    JSON.stringify({
      version: STORAGE_VERSION,
      nextOrder: 1,
      entries: [
        {
          editKey: "seed",
          promptSeq: 2,
          path,
          before: {
            kind: "stored",
            hash: hashOf(before),
            bytes: Buffer.byteLength(before, "utf8"),
          },
          after: {
            kind: "stored",
            hash: hashOf(after),
            bytes: Buffer.byteLength(after, "utf8"),
          },
          order: 0,
        },
      ],
    }),
  );
}

async function writeText(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf8");
}

function latestAgent(rig: BackendRig): FakeAcpAgent {
  return agentOf(rig, rig.container.agents.length - 1);
}

interface EditPromptInput {
  readonly rig: BackendRig;
  readonly agent: FakeAcpAgent;
  readonly sessionId: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly text: string;
}

async function editPrompt({
  rig,
  agent,
  sessionId,
  path,
  before,
  after,
  text,
}: EditPromptInput): Promise<void> {
  await writeFile(path, after, "utf8");
  toolCounter += 1;
  const toolCallId = `edit-${String(toolCounter)}`;
  agent.enqueue([
    { type: "tool_call", toolCallId, title: "Edit", kind: "edit" },
    {
      type: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "diff", path, oldText: before, newText: after }],
    },
    END_TURN,
  ]);
  await rig.call("session/prompt", { sessionId, text });
  await turnEnded(rig);
}

async function awaitCheckpointPlan(
  rig: BackendRig,
  sessionId: string,
  promptSeq: number,
): Promise<void> {
  await settled(async () => {
    const plan = await rig.call("session/rewindPreview", {
      sessionId,
      promptSeq,
    });
    expect(plan.files.length).toBeGreaterThan(0);
  });
}

async function twoEdits(
  rig: BackendRig,
  path: string,
): Promise<{ readonly sessionId: string; readonly cutSeq: number }> {
  await rig.call("session/start", startParams(rig));
  const session = await rig.session();
  await writeFile(path, "v0\n", "utf8");
  const agent = latestAgent(rig);
  await editPrompt({
    rig,
    agent,
    sessionId: session.id,
    path,
    before: "v0\n",
    after: "v1\n",
    text: "first",
  });
  await editPrompt({
    rig,
    agent,
    sessionId: session.id,
    path,
    before: "v1\n",
    after: "v2\n",
    text: "second",
  });
  const cut = (await rig.session()).prompts[1];
  if (cut === undefined) {
    throw new Error("the second prompt was not recorded");
  }
  await awaitCheckpointPlan(rig, session.id, cut.seq);
  return { sessionId: session.id, cutSeq: cut.seq };
}

it("rewindPreview returns the plan and rejects an unknown prompt", async () => {
  const rig = await rigWithUserData("cw-rewind-preview-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);

  const plan = await rig.call("session/rewindPreview", {
    sessionId,
    promptSeq: cutSeq,
  });
  expect(plan).toEqual({
    sessionId,
    promptSeq: cutSeq,
    files: [{ path: a, action: "write", skip: null }],
  });

  await expect(
    rig.call("session/rewindPreview", { sessionId, promptSeq: 999 }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.NOT_FOUND,
    message: "Prompt not found",
  });
  await expect(
    rig.call("session/rewindPreview", {
      sessionId: "00000000-0000-4000-8000-000000000000",
      promptSeq: cutSeq,
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.NOT_FOUND,
    message: "Prompt not found",
  });
});

it("conversation_and_files rewinds files and the stored transcript", async () => {
  const rig = await rigWithUserData("cw-rewind-both-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);
  const agentsBefore = rig.container.agents.length;

  const result = await rig.call("session/rewind", {
    sessionId,
    promptSeq: cutSeq,
    mode: CONVERSATION_AND_FILES,
    overwrite: [],
  });

  expect(result.promptText).toBe("second");
  expect(result.report).not.toBeNull();
  expect(await readFile(a, "utf8")).toBe("v1\n");
  expect(result.session?.id).toBe(sessionId);
  expect(result.session?.prompts.map((prompt) => prompt.text)).toEqual([
    "first",
  ]);

  const stored = await rig.call("history/get", { sessionId });
  expect(stored.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
  expect(stored.prompts.every((prompt) => prompt.seq < cutSeq)).toBe(true);
  expect(stored.messages.every((message) => message.seq < cutSeq)).toBe(true);
  expect(stored.toolCalls.every((tool) => tool.seq < cutSeq)).toBe(true);
  expect(stored.turns.every((turn) => turn.promptSeq < cutSeq)).toBe(true);
  expect(stored.nativeSessions).toEqual([]);

  expect(rig.container.agents.length).toBe(agentsBefore + 1);
  const resumed = latestAgent(rig);
  expect(resumed.resumeCalls).toEqual([]);
  expect(resumed.newSessions).toHaveLength(1);

  resumed.enqueue([{ type: "text", text: "Resumed reply" }, END_TURN]);
  await rig.call("session/prompt", { sessionId, text: "next" });
  await turnEnded(rig);
  const [firstPrompt] = resumed.prompts;
  expect(firstPrompt).toContain("## Working tree");
  expect(firstPrompt).toContain("first");
});

it("conversation mode keeps files and folds entries for the next prompt", async () => {
  const rig = await rigWithUserData("cw-rewind-conversation-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);

  const result = await rig.call("session/rewind", {
    sessionId,
    promptSeq: cutSeq,
    mode: CONVERSATION,
    overwrite: [],
  });

  expect(result.report).toBeNull();
  expect(await readFile(a, "utf8")).toBe("v2\n");
  expect(result.session?.prompts.map((prompt) => prompt.text)).toEqual([
    "first",
  ]);

  const resumed = latestAgent(rig);
  await editPrompt({
    rig,
    agent: resumed,
    sessionId,
    path: a,
    before: "v2\n",
    after: "v3\n",
    text: "third",
  });
  const nextPrompt = (await rig.session()).prompts.at(-1);
  expect(nextPrompt?.text).toBe("third");
  expect(nextPrompt?.seq).toBe(cutSeq);
  await awaitCheckpointPlan(rig, sessionId, cutSeq);

  const filesResult = await rig.call("session/rewind", {
    sessionId,
    promptSeq: cutSeq,
    mode: FILES,
    overwrite: [],
  });
  expect(filesResult.promptText).toBe("third");
  expect(filesResult.session).toBeNull();
  expect(await readFile(a, "utf8")).toBe("v2\n");

  const stored = await rig.call("history/get", { sessionId });
  expect(stored.prompts.map((prompt) => prompt.text)).toEqual([
    "first",
    "third",
  ]);
  expect((await rig.session()).prompts.map((prompt) => prompt.text)).toEqual([
    "first",
    "third",
  ]);
});

it("files mode leaves the transcript and the live session untouched", async () => {
  const rig = await rigWithUserData("cw-rewind-files-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);
  const agentsBefore = rig.container.agents.length;

  const result = await rig.call("session/rewind", {
    sessionId,
    promptSeq: cutSeq,
    mode: FILES,
    overwrite: [],
  });

  expect(result.report?.restored).toEqual([a]);
  expect(result.session).toBeNull();
  expect(result.promptText).toBe("second");
  expect(await readFile(a, "utf8")).toBe("v1\n");
  expect(rig.container.agents.length).toBe(agentsBefore);
  expect((await rig.session()).prompts.map((prompt) => prompt.text)).toEqual([
    "first",
    "second",
  ]);
  const stored = await rig.call("history/get", { sessionId });
  expect(stored.prompts.map((prompt) => prompt.text)).toEqual([
    "first",
    "second",
  ]);
});

it("rewind rejects while a turn is in flight", async () => {
  const rig = await rigWithUserData("cw-rewind-turn-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);
  const agent = latestAgent(rig);
  agent.enqueue([{ type: "hang" }]);
  await rig.call("session/prompt", { sessionId, text: "hang" });
  await settled(async () => {
    expect((await rig.session()).turnInFlight).toBe(true);
  });

  await expect(
    rig.call("session/rewind", {
      sessionId,
      promptSeq: cutSeq,
      mode: CONVERSATION_AND_FILES,
      overwrite: [],
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Stop the agent before rewinding",
  });

  expect(await readFile(a, "utf8")).toBe("v2\n");
  await settled(async () => {
    const stored = await rig.call("history/get", { sessionId });
    expect(stored.prompts.map((prompt) => prompt.text)).toEqual([
      "first",
      "second",
    ]);
  });
  await rig.call("session/stop", { sessionId });
});

it("rewind rejects while a flow runs", async () => {
  const rig = await rigWithUserData("cw-rewind-flow-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);
  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });

  await writeFlowFiles(rig.cwd);
  rig.container.scriptNext([{ type: "hang" }]);
  const run = await rig.call("flow/start", {
    cwd: rig.cwd,
    flowId: "solo",
    task: "hold the run open",
  });

  await expect(
    rig.call("session/rewind", {
      sessionId,
      promptSeq: cutSeq,
      mode: CONVERSATION,
      overwrite: [],
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is running",
  });

  await rig.call("flow/stop", { runId: run.runId });
});

it("a failed file restore leaves the transcript untouched", async () => {
  const rig = await rigWithUserData("cw-rewind-failure-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);
  const agentsBefore = rig.container.agents.length;
  await rm(join(rig.userData, CHECKPOINTS_DIR, sessionId, "blobs"), {
    recursive: true,
    force: true,
  });

  await expect(
    rig.call("session/rewind", {
      sessionId,
      promptSeq: cutSeq,
      mode: CONVERSATION_AND_FILES,
      overwrite: [],
    }),
  ).rejects.toThrow();

  expect(await readFile(a, "utf8")).toBe("v2\n");
  expect(rig.container.agents.length).toBe(agentsBefore);
  expect((await rig.session()).prompts.map((prompt) => prompt.text)).toEqual([
    "first",
    "second",
  ]);
  await settled(async () => {
    const stored = await rig.call("history/get", { sessionId });
    expect(stored.prompts.map((prompt) => prompt.text)).toEqual([
      "first",
      "second",
    ]);
  });
  await rig.call("session/stop", { sessionId });
});

it("conversation rewind of a history-only session returns no session", async () => {
  const rig = await rigWithUserData("cw-rewind-history-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId, cutSeq } = await twoEdits(rig, a);
  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });

  const result = await rig.call("session/rewind", {
    sessionId,
    promptSeq: cutSeq,
    mode: CONVERSATION,
    overwrite: [],
  });

  expect(result.session).toBeNull();
  expect(result.report).toBeNull();
  expect(result.promptText).toBe("second");
  const stored = await rig.call("history/get", { sessionId });
  expect(stored.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
  expect(stored.nativeSessions).toEqual([]);
  expect(await readFile(a, "utf8")).toBe("v2\n");
});

it("history rewind rejects an unknown history-only prompt", async () => {
  const rig = await rigWithUserData("cw-rewind-unknown-");
  const a = join(rig.cwd, "a.txt");
  const { sessionId } = await twoEdits(rig, a);
  await rig.call("session/stop", { sessionId });
  await rig.call("session/close", { sessionId });

  await expect(
    rig.call("session/rewind", {
      sessionId,
      promptSeq: 999,
      mode: CONVERSATION,
      overwrite: [],
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.NOT_FOUND,
    message: "Prompt not found",
  });
});

it("rewind rejects while an orchestrator child run is open", async () => {
  const rig = await openRig({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    userData: await tempUserData("cw-rewind-orchestrator-"),
  });
  await writeFlowFiles(rig.cwd);
  await rig.call("session/start", { cwd: rig.cwd, orchestrate: true });
  const tools = await connectTools(toolEndpointOf(agentOf(rig)));
  clients.push(tools);

  agentOf(rig).enqueue([{ type: "text", text: "ready" }, END_TURN]);
  const sessionId = (await rig.session()).id;
  await rig.call("session/prompt", { sessionId, text: "go" });
  await turnEnded(rig);
  const promptSeq = (await rig.session()).prompts[0]?.seq ?? 0;

  rig.container.scriptNext([{ type: "hang" }]);
  const run = FlowRunViewSchema.parse(
    await tools.json("start_flow", { flowId: "solo", task: TASK }),
  );

  await expect(
    rig.call("session/rewind", {
      sessionId,
      promptSeq,
      mode: CONVERSATION,
      overwrite: [],
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is running",
  });

  await rig.call("flow/stop", { runId: run.runId });
});

it("a rewind to a new prompt whose seq equals N-1 restores the state at the cut", async () => {
  const rig = await rigWithUserData("cw-rewind-fold-");
  const a = join(rig.cwd, "a.txt");
  await writeText(a, "v1\n");
  await seedStoredSession(rig, SEEDED_ID);
  await seedCheckpoint(rig, SEEDED_ID, a);

  const resumed = await rig.call("session/resume", { sessionId: SEEDED_ID });
  expect(resumed.prompts.map((prompt) => prompt.text)).toEqual(["keep", "cut"]);

  const result = await rig.call("session/rewind", {
    sessionId: SEEDED_ID,
    promptSeq: 2,
    mode: CONVERSATION,
    overwrite: [],
  });
  expect(result.session?.prompts.map((prompt) => prompt.text)).toEqual([
    "keep",
  ]);

  const agent = latestAgent(rig);
  await editPrompt({
    rig,
    agent,
    sessionId: SEEDED_ID,
    path: a,
    before: "v1\n",
    after: "v2\n",
    text: "new",
  });
  const next = (await rig.session()).prompts.at(-1);
  expect(next?.text).toBe("new");
  expect(next?.seq).toBe(1);
  await awaitCheckpointPlan(rig, SEEDED_ID, 1);

  await rig.call("session/rewind", {
    sessionId: SEEDED_ID,
    promptSeq: 1,
    mode: FILES,
    overwrite: [],
  });
  expect(await readFile(a, "utf8")).toBe("v1\n");
});
