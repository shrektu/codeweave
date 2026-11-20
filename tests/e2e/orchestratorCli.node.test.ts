import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOLS_NOT_SUPPORTED_MESSAGE } from "../../src/backend/agy/constants";
import { locateClaudeAcpEntry } from "../../src/backend/claude/launch";
import { execText } from "../../src/backend/exec";
import {
  FLOW_TOOL_NAMES,
  FlowToolName,
} from "../../src/backend/flowTools/tools";
import { createConsoleLoginProbe } from "../../src/backend/opencode/consoleLogin";
import { createConsoleUsageProbe } from "../../src/backend/opencode/consoleUsage";
import { createVersionProbe } from "../../src/backend/opencode/version";
import { createProcessContainer } from "../../src/backend/process/select";
import {
  createExecutableResolver,
  startBackend,
  type Backend,
} from "../../src/backend/startup";
import { inspectWorktree } from "../../src/backend/worktree";
import { FLOW_TOOL_SERVER_NAME } from "../../src/domain/constants";
import { FlowDecision, FlowRunStatus } from "../../src/domain/flowRun";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import type { SessionView } from "../../src/shared/views";
import { createFakeVault } from "../fakes/fakeVault";
import { TurnKind, type MockTurn } from "../fakes/mockTurn";
import {
  ChatScenario,
  startOpenaiChatMock,
  type ChatRequestBody,
} from "../fakes/openaiChatMock";
import {
  ResponsesScenario,
  startResponsesMock,
  type ResponsesRequestBody,
} from "../fakes/responsesMock";

import {
  assertWorkspaceIsolated,
  createCodexRotationWorkspace,
} from "./codexRotationFixture";
import {
  BUILD_REPLY,
  FLOW_TASK,
  isBuildNodePrompt,
  isReviewNodePrompt,
  writeFlowFiles,
} from "./flowRunFixture";
import {
  OPENCODE_ACCOUNT_SPECS,
  OPENCODE_KEY_A,
  opencodeAddParams,
  opencodeBinaryOnPath,
} from "./opencodeRotationFixture";
import {
  DECISION_NOTE,
  FINAL_ANSWER,
  GREETING_CONTENT,
  GREETING_FILE,
  chatTranscript,
  isOrchestratorRequest,
  nextOrchestratorStep,
  responsesTranscript,
  responsesWireTurn,
  toolIs,
  type OrchestratorTranscript,
} from "./orchestratorScript";
import { agyAddParams } from "./agyRotationFixture";
import {
  KEY_A,
  KEY_B,
  WORKSPACE_PREFIX,
  createCleanupStack,
  createRepo,
} from "./rotationFixture";

const TEST_TIMEOUT_MS = 240_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 150_000;
const POLL_INTERVAL_MS = 250;
const DIAGNOSTIC_TAIL_CHARS = 400;
const REVIEW_REPLY_WITHOUT_VERDICT = "Looks correct.";
const REVIEW_VERDICT_MARKER = "## Verdict";
const EXEC_TOOL = "exec_command";
const SHELL_TOOL = "shell";
const BASH_TOOL = "bash";
const SHELL_BINARY = "bash";
const SHELL_FLAG = "-lc";
const BASH_DESCRIPTION = "Write the greeting file";
const MIN_NODE_REQUESTS = 3;
const ENV_ALLOW_LIST = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;
const WAIT_OPTIONS = {
  timeout: STEP_TIMEOUT_MS,
  interval: POLL_INTERVAL_MS,
} as const;

interface Observed {
  readonly orchestrator: OrchestratorTranscript[];
  readonly nodeToolNames: (readonly string[])[];
}

interface Adapter<Body> {
  transcriptOf(body: Body): OrchestratorTranscript;
  promptOf(body: Body): string;
  shellTurn(toolNames: readonly string[], command: string): MockTurn;
  toWire(body: Body, turn: MockTurn): MockTurn;
}

const cleanup = createCleanupStack();

afterEach(async () => {
  await cleanup.run();
}, CLEANUP_TIMEOUT_MS);

function isolatedParentEnv(): NodeJS.ProcessEnv {
  const entries = ENV_ALLOW_LIST.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return Object.fromEntries(entries);
}

async function startOrchestratorBackend(userData: string): Promise<Backend> {
  const backend = await startBackend({
    vault: createFakeVault(),
    args: { userData, testAgentEnv: {} },
    broadcast: () => undefined,
    createContainer: (instanceId) =>
      createProcessContainer(process.platform, undefined, instanceId),
    execPath: process.execPath,
    adapterEntry: locateClaudeAcpEntry(),
    parentEnv: isolatedParentEnv(),
    homeDir: homedir(),
    platform: process.platform,
    now: () => Date.now(),
    schedule: (atMillis, run) => {
      const timer = setTimeout(run, Math.max(0, atMillis - Date.now()));
      timer.unref();
      return () => {
        clearTimeout(timer);
      };
    },
    newRunId: () => randomUUID(),
    resolveExecutable: createExecutableResolver(process.env, process.platform),
    opencodeConsoleLogin: createConsoleLoginProbe({
      exec: execText,
      platform: process.platform,
    }),
    opencodeConsoleUsage: createConsoleUsageProbe({
      exec: execText,
      platform: process.platform,
    }),
    opencodeGeneration: createVersionProbe({
      exec: execText,
      platform: process.platform,
    }),
    inspectWorktree,
  });
  cleanup.add(() => backend.shutdown());
  return backend;
}

function greetingCommand(repo: string): string {
  return `printf %s ${GREETING_CONTENT} > ${join(repo, GREETING_FILE)}`;
}

function nodeTurn<Body>(
  adapter: Adapter<Body>,
  body: Body,
  transcript: OrchestratorTranscript,
  repo: string,
): MockTurn | undefined {
  if (transcript.calls.length > 0) {
    return { kind: TurnKind.text, text: BUILD_REPLY };
  }
  const prompt = adapter.promptOf(body);
  if (isReviewNodePrompt(prompt) || prompt.includes(REVIEW_VERDICT_MARKER)) {
    return { kind: TurnKind.text, text: REVIEW_REPLY_WITHOUT_VERDICT };
  }
  return isBuildNodePrompt(prompt)
    ? adapter.shellTurn(transcript.toolNames, greetingCommand(repo))
    : undefined;
}

function scriptedResponder<Body>(
  adapter: Adapter<Body>,
  repoOf: () => string,
  observed: Observed,
): (body: Body) => MockTurn | undefined {
  return (body) => {
    const transcript = adapter.transcriptOf(body);
    if (transcript.toolNames.length === 0) {
      return undefined;
    }
    if (isOrchestratorRequest(transcript.toolNames)) {
      observed.orchestrator.push(transcript);
      return adapter.toWire(body, nextOrchestratorStep(transcript));
    }
    observed.nodeToolNames.push(transcript.toolNames);
    const turn = nodeTurn(adapter, body, transcript, repoOf());
    return turn === undefined ? undefined : adapter.toWire(body, turn);
  };
}

const responsesAdapter: Adapter<ResponsesRequestBody> = {
  transcriptOf: responsesTranscript,
  promptOf: (body) => JSON.stringify(body.input),
  shellTurn: (toolNames, command) => {
    if (toolNames.includes(EXEC_TOOL)) {
      return { kind: TurnKind.tool, name: EXEC_TOOL, input: { cmd: command } };
    }
    if (toolNames.includes(SHELL_TOOL)) {
      return {
        kind: TurnKind.tool,
        name: SHELL_TOOL,
        input: { command: [SHELL_BINARY, SHELL_FLAG, command] },
      };
    }
    throw new Error(`no shell tool offered; offered: ${toolNames.join(", ")}`);
  },
  toWire: responsesWireTurn,
};

const chatAdapter: Adapter<ChatRequestBody> = {
  transcriptOf: chatTranscript,
  promptOf: (body) => JSON.stringify(body.messages),
  shellTurn: (toolNames, command) => {
    if (toolNames.includes(BASH_TOOL)) {
      return {
        kind: TurnKind.tool,
        name: BASH_TOOL,
        input: { command, description: BASH_DESCRIPTION },
      };
    }
    throw new Error(`no bash tool offered; offered: ${toolNames.join(", ")}`);
  },
  toWire: (_body, turn) => turn,
};

async function sessionOf(backend: Backend): Promise<SessionView> {
  const { session } = await backend.handlers["sessions/snapshot"]({});
  if (session === null) {
    throw new Error("no session in snapshot");
  }
  return session;
}

function transcriptText(session: SessionView): string {
  return session.messages.map((message) => message.text).join("");
}

function progressOf(session: SessionView, observed: Observed): string {
  return JSON.stringify({
    transcriptTail: transcriptText(session).slice(-DIAGNOSTIC_TAIL_CHARS),
    orchestratorRequests: observed.orchestrator.length,
    lastOrchestrator: observed.orchestrator.at(-1) ?? null,
    lastNodeToolNames: observed.nodeToolNames.at(-1) ?? null,
  });
}

async function runOrchestration(
  backend: Backend,
  repo: string,
  provider: ProviderId,
  observed: Observed,
): Promise<void> {
  const { handlers } = backend;
  await handlers["session/start"]({
    cwd: repo,
    profile: PermissionProfile.unattended,
    provider,
    orchestrate: true,
  });
  await handlers["session/prompt"]({ text: FLOW_TASK });
  await vi.waitFor(async () => {
    const session = await sessionOf(backend);
    expect(
      transcriptText(session).endsWith(FINAL_ANSWER),
      progressOf(session, observed),
    ).toBe(true);
  }, WAIT_OPTIONS);
}

async function expectLoopCompleted(
  backend: Backend,
  repo: string,
  observed: Observed,
): Promise<void> {
  const { flowRuns } = await backend.handlers["sessions/snapshot"]({});
  expect(flowRuns).toHaveLength(1);
  expect(flowRuns[0]?.status).toBe(FlowRunStatus.done);
  expect(flowRuns[0]?.decisions[0]).toMatchObject({
    decision: FlowDecision.approve,
    note: DECISION_NOTE,
  });
  expect(await readFile(join(repo, GREETING_FILE), "utf8")).toBe(
    GREETING_CONTENT,
  );
  const last = observed.orchestrator.at(-1);
  const offered = last?.toolNames ?? [];
  for (const bare of FLOW_TOOL_NAMES) {
    expect(
      offered.some((name) => toolIs(name, bare)),
      `${bare} not offered; offered: ${offered.join(", ")}`,
    ).toBe(true);
  }
  expect(
    last?.calls.some(
      (call) =>
        toolIs(call.tool, FlowToolName.flowDiff) &&
        call.result.includes(GREETING_FILE),
    ),
    `no flow_diff result with ${GREETING_FILE}; calls: ${JSON.stringify(last?.calls)}`,
  ).toBe(true);
  expect(observed.nodeToolNames.length).toBeGreaterThanOrEqual(
    MIN_NODE_REQUESTS,
  );
  for (const names of observed.nodeToolNames) {
    expect(
      names.filter((name) => name.includes(FLOW_TOOL_SERVER_NAME)),
      "node sessions get no flow tools",
    ).toEqual([]);
  }
}

describe("orchestrator mode with the real codex CLI and a scripted model", () => {
  it(
    "codex orchestrator completes the flow loop",
    async () => {
      const observed: Observed = { orchestrator: [], nodeToolNames: [] };
      let repo = "";
      const mock = await startResponsesMock(
        { [KEY_A]: ResponsesScenario.ok, [KEY_B]: ResponsesScenario.ok },
        {
          respond: scriptedResponder(responsesAdapter, () => repo, observed),
        },
      );
      cleanup.add(() => mock.close());
      const workspace = await createCodexRotationWorkspace(
        PermissionProfile.unattended,
        mock.url,
      );
      cleanup.add(() => workspace.dispose());
      assertWorkspaceIsolated(workspace, mock.url);
      repo = workspace.repo;
      await writeFlowFiles(repo, {
        provider: ProviderId.codex,
        builderProfile: PermissionProfile.unattended,
      });
      const backend = await startOrchestratorBackend(workspace.userData);

      await runOrchestration(backend, repo, ProviderId.codex, observed);

      await expectLoopCompleted(backend, repo, observed);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("orchestrator mode with the real opencode CLI and a scripted model", () => {
  it(
    "opencode v1 orchestrator completes the flow loop",
    async () => {
      opencodeBinaryOnPath();
      const observed: Observed = { orchestrator: [], nodeToolNames: [] };
      const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
      cleanup.add(() => rm(root, { recursive: true, force: true }));
      const repo = join(root, "repo");
      await createRepo(repo);
      await writeFlowFiles(repo, {
        provider: ProviderId.opencode,
        builderProfile: PermissionProfile.unattended,
      });
      const mock = await startOpenaiChatMock({
        scenarios: { [OPENCODE_KEY_A]: ChatScenario.ok },
        toolCommand: greetingCommand(repo),
        respond: scriptedResponder(chatAdapter, () => repo, observed),
      });
      cleanup.add(() => mock.close());
      const userData = join(root, "user-data");
      const backend = await startOrchestratorBackend(userData);
      const [spec] = OPENCODE_ACCOUNT_SPECS;
      if (spec === undefined) {
        throw new Error("no opencode account spec");
      }
      await backend.handlers["accounts/add"](
        opencodeAddParams(spec, userData, mock.url),
      );

      await runOrchestration(backend, repo, ProviderId.opencode, observed);

      await expectLoopCompleted(backend, repo, observed);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("orchestrator mode on Gemini (agy)", () => {
  it(
    "gemini orchestrate start is refused",
    async () => {
      const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
      cleanup.add(() => rm(root, { recursive: true, force: true }));
      const repo = join(root, "repo");
      await createRepo(repo);
      const userData = join(root, "user-data");
      const backend = await startOrchestratorBackend(userData);
      await backend.handlers["accounts/add"](agyAddParams(userData));

      await expect(
        backend.handlers["session/start"]({
          cwd: repo,
          profile: PermissionProfile.ask,
          provider: ProviderId.gemini,
          orchestrate: true,
        }),
      ).rejects.toThrow(TOOLS_NOT_SUPPORTED_MESSAGE);
    },
    TEST_TIMEOUT_MS,
  );
});
