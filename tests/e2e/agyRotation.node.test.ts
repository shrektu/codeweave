import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { locateClaudeAcpEntry } from "../../src/backend/claude/launch";
import { execText } from "../../src/backend/exec";
import { createConsoleLoginProbe } from "../../src/backend/opencode/consoleLogin";
import { createVersionProbe } from "../../src/backend/opencode/version";
import { createProcessContainer } from "../../src/backend/process/select";
import {
  createExecutableResolver,
  startBackend,
  type Backend,
} from "../../src/backend/startup";
import { inspectWorktree } from "../../src/backend/worktree";
import {
  PermissionProfile,
  ProviderId,
  SwitchReason,
} from "../../src/domain/types";
import type { SessionView } from "../../src/shared/views";
import { createFakeVault } from "../fakes/fakeVault";
import {
  GeminiRequestKind,
  GeminiScenario,
  startGeminiApiMock,
  type GeminiApiMock,
} from "../fakes/geminiApiMock";
import { ChatScenario, startOpenaiChatMock } from "../fakes/openaiChatMock";

import {
  AGY_ACCOUNT_LABEL,
  AGY_PATH_ERROR,
  agyAddParams,
  agyBinaryOnPath,
  agyConfigDir,
  agyProcessPids,
  assertAgyIsolated,
  builtAgyHookEntry,
  createAgyIsolation,
  startChatProxy,
  writeAgySettings,
  writeHookLauncher,
  type AgyIsolation,
  type ChatProxy,
} from "./agyRotationFixture";
import {
  OPENCODE_KEY_B,
  opencodeAddParams,
  opencodeBinaryOnPath,
} from "./opencodeRotationFixture";
import {
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  WORKSPACE_PREFIX,
  createCleanupStack,
  createRepo,
  readEffectLines,
} from "./rotationFixture";

const TEST_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const EXPECTED_EFFECT_LINES = ["deploy-side-effect"];
const EXPECTED_MAIN_REQUESTS = 2;
const CONTEXT_INTRO =
  "You are taking over a coding session from another account that hit its usage limit.";
const NO_RERUN_WORDING =
  "Side effect: do not re-run automatically; verify its effect first.";
const COMPLETED_STATUS = "Status: completed";
const HOOK_DENIAL_REASON = "privilege escalation is blocked";
const HOOK_DENIAL_OUTPUT = `tool call denied by pre-tool hook: ${HOOK_DENIAL_REASON}`;
const SUDO_COMMAND = "sudo true";
const DONE_TEXT = "DONE";
const OPENCODE_LABEL = "B";
const ENV_ALLOW_LIST = ["PATH", "LANG", "TMPDIR", "XDG_RUNTIME_DIR"] as const;
const WAIT_OPTIONS = {
  timeout: STEP_TIMEOUT_MS,
  interval: POLL_INTERVAL_MS,
} as const;

interface Rig {
  readonly backend: Backend;
  readonly gemini: GeminiApiMock;
  readonly proxy: ChatProxy;
  readonly isolation: AgyIsolation;
  readonly root: string;
  readonly repo: string;
}

const REQUESTED_MODEL = "Gemini 3.8 Flash (Medium)";
const REQUESTED_MODEL_API_NAME = "gemini-3.8-flash";

const cleanup = createCleanupStack();

function isolatedParentEnv(): NodeJS.ProcessEnv {
  const entries = ENV_ALLOW_LIST.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return Object.fromEntries(entries);
}

async function startBackendFor(
  userData: string,
  isolation: AgyIsolation,
  hookLauncher: string,
): Promise<Backend> {
  const backend = await startBackend({
    vault: createFakeVault(),
    args: { userData, testAgentEnv: { ...isolation.agentEnv } },
    broadcast: () => undefined,
    createContainer: (instanceId) =>
      createProcessContainer(process.platform, undefined, instanceId),
    execPath: hookLauncher,
    adapterEntry: locateClaudeAcpEntry(),
    parentEnv: isolatedParentEnv(),
    homeDir: isolation.agentEnv.HOME,
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
    opencodeGeneration: createVersionProbe({
      exec: execText,
      platform: process.platform,
    }),
    inspectWorktree,
  });
  cleanup.add(() => backend.shutdown());
  return backend;
}

async function openRig(scenario: GeminiScenario): Promise<Rig> {
  agyBinaryOnPath();
  opencodeBinaryOnPath();
  const gemini = await startGeminiApiMock({
    scenario,
    toolCommand: ROTATION_COMMAND,
  });
  cleanup.add(() => gemini.close());
  const chat = await startOpenaiChatMock({
    scenarios: { [OPENCODE_KEY_B]: ChatScenario.ok },
    toolCommand: ROTATION_COMMAND,
  });
  cleanup.add(() => chat.close());
  const proxy = await startChatProxy(chat.url);
  cleanup.add(() => proxy.close());
  const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  cleanup.add(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  await createRepo(repo);
  const isolation = await createAgyIsolation(
    root,
    agyConfigDir(userData),
    gemini.baseUrl,
  );
  await writeAgySettings(isolation);
  const hookLauncher = await writeHookLauncher(root, builtAgyHookEntry());
  const backend = await startBackendFor(userData, isolation, hookLauncher);
  assertAgyIsolated(isolation);
  await backend.handlers["accounts/add"](agyAddParams(userData));
  await backend.handlers["accounts/add"](
    opencodeAddParams(
      { label: OPENCODE_LABEL, apiKey: OPENCODE_KEY_B },
      userData,
      proxy.url,
    ),
  );
  return { backend, gemini, proxy, isolation, root, repo };
}

async function sessionOf(rig: Rig): Promise<SessionView> {
  const { session } = await rig.backend.handlers["sessions/snapshot"]({});
  if (session === null) {
    throw new Error("no session in snapshot");
  }
  return session;
}

async function accountIds(rig: Rig): Promise<Record<string, string>> {
  const { accounts } = await rig.backend.handlers["accounts/list"]({});
  return Object.fromEntries(
    accounts.map((account) => [account.label, account.id]),
  );
}

async function runTurn(rig: Rig): Promise<void> {
  assertAgyIsolated(rig.isolation);
  const { handlers } = rig.backend;
  await handlers["session/start"]({
    cwd: rig.repo,
    profile: PermissionProfile.unattended,
    provider: ProviderId.gemini,
  });
  await handlers["session/prompt"]({ text: ROTATION_PROMPT });
}

async function rotate(): Promise<Rig> {
  const rig = await openRig(GeminiScenario.toolThen429);
  const ids = await accountIds(rig);
  await runTurn(rig);
  await vi.waitFor(async () => {
    const view = await sessionOf(rig);
    expect(view.activeAccountId).toBe(ids[OPENCODE_LABEL]);
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).not.toBeNull();
  }, WAIT_OPTIONS);
  return rig;
}

function expectContextPackage(rig: Rig): void {
  const first = rig.proxy.requests().find((request) => request.hasTools);
  expect(first).toBeDefined();
  const text = first?.body ?? "";
  expect(text).toContain(CONTEXT_INTRO);
  expect(text).toContain(ROTATION_PROMPT);
  expect(text).toContain(ROTATION_COMMAND);
  expect(text).toContain(COMPLETED_STATUS);
  expect(text).toContain(NO_RERUN_WORDING);
}

afterEach(async () => {
  await cleanup.run();
}, CLEANUP_TIMEOUT_MS);

describe("rotation with the real agy CLI and a local Gemini API mock", () => {
  it(
    "gemini_tool_then_quota_rotates_to_opencode",
    async () => {
      const rig = await rotate();
      const ids = await accountIds(rig);

      expect(await readEffectLines(rig.repo)).toEqual(EXPECTED_EFFECT_LINES);
      const { entries } = await rig.backend.handlers["switchLog/list"]({});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        from: ids[AGY_ACCOUNT_LABEL],
        to: ids[OPENCODE_LABEL],
        reason: SwitchReason.rateLimit,
      });
      expectContextPackage(rig);
      expect(rig.gemini.requests(GeminiRequestKind.main)).toHaveLength(
        EXPECTED_MAIN_REQUESTS,
      );
      expect(rig.gemini.requests(GeminiRequestKind.unknown)).toEqual([]);
      await vi.waitFor(async () => {
        expect(await agyProcessPids(rig.isolation.geminiDir)).toEqual([]);
      }, WAIT_OPTIONS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gemini_unattended_sudo_denied_by_hook",
    async () => {
      const rig = await openRig(GeminiScenario.sudoThenDone);
      await runTurn(rig);
      await vi.waitFor(async () => {
        const view = await sessionOf(rig);
        expect(view.turnInFlight).toBe(false);
        expect(view.lastTurn).not.toBeNull();
      }, WAIT_OPTIONS);

      const view = await sessionOf(rig);
      const sudo = view.toolCalls.find((tool) => tool.title === SUDO_COMMAND);
      expect(sudo?.status).toBe("failed");
      expect(sudo?.output).toBe(HOOK_DENIAL_OUTPUT);
      expect(view.lastTurn?.kind).toBe("ended");
      expect(view.messages.map((message) => message.text).join("")).toContain(
        DONE_TEXT,
      );
      const main = rig.gemini.requests(GeminiRequestKind.main);
      expect(main).toHaveLength(EXPECTED_MAIN_REQUESTS);
      expect(JSON.stringify(main[1]?.body)).toContain(HOOK_DENIAL_REASON);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("model selection with the real agy CLI and a local Gemini API mock", () => {
  it(
    "model reaches the real agy",
    async () => {
      const rig = await openRig(GeminiScenario.ok);
      assertAgyIsolated(rig.isolation);
      const { handlers } = rig.backend;

      await handlers["session/start"]({
        cwd: rig.repo,
        profile: PermissionProfile.unattended,
        provider: ProviderId.gemini,
        model: { provider: ProviderId.gemini, model: REQUESTED_MODEL },
      });
      await handlers["session/prompt"]({ text: "Reply with one word" });
      await vi.waitFor(async () => {
        expect((await sessionOf(rig)).lastTurn).not.toBeNull();
      }, WAIT_OPTIONS);

      expect((await sessionOf(rig)).lastTurn?.kind).toBe("ended");
      expect(
        rig.gemini
          .requests(GeminiRequestKind.main)
          .map((request) => request.model),
      ).toContain(REQUESTED_MODEL_API_NAME);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("rejected model with the real agy CLI", () => {
  it(
    "rejected model fails the real agy turn",
    async () => {
      const rig = await openRig(GeminiScenario.ok);
      assertAgyIsolated(rig.isolation);
      const { handlers } = rig.backend;

      await handlers["session/start"]({
        cwd: rig.repo,
        profile: PermissionProfile.unattended,
        provider: ProviderId.gemini,
        model: { provider: ProviderId.gemini, model: "nonsense" },
      });
      await handlers["session/prompt"]({ text: "Reply with one word" });
      await vi.waitFor(async () => {
        expect((await sessionOf(rig)).lastTurn).not.toBeNull();
      }, WAIT_OPTIONS);

      const { lastTurn } = await sessionOf(rig);
      expect(lastTurn?.kind).toBe("failed");
      expect(lastTurn).toMatchObject({
        message: expect.stringContaining(
          "model nonsense is not recognized as a known model",
        ) as unknown,
      });
      expect(rig.gemini.requests(GeminiRequestKind.main)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("agy test prerequisites", () => {
  it("agy_missing_from_path_throws", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
    cleanup.add(() => rm(emptyDir, { recursive: true, force: true }));
    await mkdir(join(emptyDir, "bin"));

    expect(() => agyBinaryOnPath(join(emptyDir, "bin"))).toThrow(
      AGY_PATH_ERROR,
    );
  });
});
