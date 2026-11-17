import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { locateClaudeAcpEntry } from "../../src/backend/claude/launch";
import {
  createExecutableResolver,
  startBackend,
  type Backend,
} from "../../src/backend/startup";
import { createProcessContainer } from "../../src/backend/process/select";
import { inspectWorktree } from "../../src/backend/worktree";
import {
  PermissionProfile,
  ProviderId,
  SwitchReason,
} from "../../src/domain/types";
import type { SessionView } from "../../src/shared/views";
import { createFakeVault } from "../fakes/fakeVault";
import {
  ChatScenario,
  startOpenaiChatMock,
  type OpenaiChatMock,
} from "../fakes/openaiChatMock";

import {
  OPENCODE_ACCOUNT_SPECS,
  OPENCODE_KEYS,
  OPENCODE_KEY_A,
  OPENCODE_KEY_B,
  OPENCODE_ROTATION_SCENARIOS,
  findKeyLeaks,
  opencodeAddParams,
  opencodeBinaryOnPath,
  runtimeRunDirs,
} from "./opencodeRotationFixture";
import {
  ALLOW_ONCE_KIND,
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
const EFFECTS_FILE = "effects.log";
const EXPECTED_EFFECT_LINES = ["deploy-side-effect"];
const CONFIGURED_MODEL = "mock-model";
const UNKNOWN_MODEL = "requested-model";
const PROC_ROOT = "/proc";
const SERVE_ARGUMENT = "serve";
const OPENCODE_CMDLINE_MARKER = "opencode";
const PID_PATTERN = /^\d+$/;
const NUL = "\0";
const VANISHED_PROCESS_CODES: readonly string[] = ["ENOENT", "ESRCH"];
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
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

interface Rig {
  readonly backend: Backend;
  readonly mock: OpenaiChatMock;
  readonly root: string;
  readonly userData: string;
  readonly repo: string;
  readonly consoleOutput: string[];
}

const cleanup = createCleanupStack();

function isolatedParentEnv(): NodeJS.ProcessEnv {
  const entries = ENV_ALLOW_LIST.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return Object.fromEntries(entries);
}

function captureConsole(): string[] {
  const output: string[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  }
  return output;
}

async function openRig(
  scenarios: Readonly<
    Record<string, ChatScenario>
  > = OPENCODE_ROTATION_SCENARIOS,
): Promise<Rig> {
  opencodeBinaryOnPath();
  const consoleOutput = captureConsole();
  const mock = await startOpenaiChatMock({
    scenarios,
    toolCommand: ROTATION_COMMAND,
  });
  cleanup.add(() => mock.close());
  const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  cleanup.add(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  await createRepo(repo);
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
    inspectWorktree,
  });
  cleanup.add(() => backend.shutdown());
  for (const spec of OPENCODE_ACCOUNT_SPECS) {
    await backend.handlers["accounts/add"](
      opencodeAddParams(spec, userData, mock.url),
    );
  }
  return { backend, mock, root, userData, repo, consoleOutput };
}

async function sessionOf(rig: Rig): Promise<SessionView> {
  const { session } = await rig.backend.handlers["sessions/snapshot"]({});
  if (session === null) {
    throw new Error("no session in snapshot");
  }
  return session;
}

async function approveCommand(rig: Rig): Promise<void> {
  let pending: SessionView["permissions"] = [];
  await vi.waitFor(async () => {
    pending = (await sessionOf(rig)).permissions;
    expect(pending).toHaveLength(1);
  }, WAIT_OPTIONS);
  const [permission] = pending;
  const allow = permission?.options.find(
    (option) => option.kind === ALLOW_ONCE_KIND,
  );
  expect(permission?.command).toContain(ROTATION_COMMAND);
  expect(existsSync(join(rig.repo, EFFECTS_FILE))).toBe(false);
  await rig.backend.handlers["permission/answer"]({
    requestId: permission?.requestId ?? "",
    optionId: allow?.optionId ?? "",
  });
}

async function accountIds(rig: Rig): Promise<Record<string, string>> {
  const { accounts } = await rig.backend.handlers["accounts/list"]({});
  return Object.fromEntries(
    accounts.map((account) => [account.label, account.id]),
  );
}

async function rotate(): Promise<Rig> {
  const rig = await openRig();
  const ids = await accountIds(rig);
  const { handlers } = rig.backend;
  await handlers["session/start"]({
    cwd: rig.repo,
    profile: PermissionProfile.ask,
    provider: ProviderId.opencode,
  });
  await handlers["session/prompt"]({ text: ROTATION_PROMPT });
  await approveCommand(rig);
  await vi.waitFor(async () => {
    const view = await sessionOf(rig);
    expect(view.activeAccountId).toBe(ids.B);
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).not.toBeNull();
  }, WAIT_OPTIONS);
  return rig;
}

async function cmdlineOf(pid: string): Promise<string> {
  try {
    return await readFile(join(PROC_ROOT, pid, "cmdline"), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      VANISHED_PROCESS_CODES.includes(error.code)
    ) {
      return "";
    }
    throw error;
  }
}

async function opencodeServePids(): Promise<string[]> {
  const entries = await readdir(PROC_ROOT);
  const matches = await Promise.all(
    entries
      .filter((entry) => PID_PATTERN.test(entry))
      .map(async (pid) => {
        const cmdline = await cmdlineOf(pid);
        const parts = cmdline.split(NUL);
        const isServe =
          parts.includes(SERVE_ARGUMENT) &&
          parts.some((part) => part.includes(OPENCODE_CMDLINE_MARKER));
        return isServe ? [pid] : [];
      }),
  );
  return matches.flat();
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup.run();
}, CLEANUP_TIMEOUT_MS);

describe("model selection with the real opencode CLI and a local chat mock", () => {
  it(
    "model reaches the real opencode",
    async () => {
      const rig = await openRig({
        [OPENCODE_KEY_A]: ChatScenario.ok,
        [OPENCODE_KEY_B]: ChatScenario.ok,
      });
      const { handlers } = rig.backend;

      await handlers["session/start"]({
        cwd: rig.repo,
        profile: PermissionProfile.unattended,
        provider: ProviderId.opencode,
        model: {
          provider: ProviderId.opencode,
          model: `custom/${CONFIGURED_MODEL}`,
        },
      });
      await handlers["session/prompt"]({ text: "Reply with one word" });
      await vi.waitFor(async () => {
        expect((await sessionOf(rig)).lastTurn).not.toBeNull();
      }, WAIT_OPTIONS);

      expect((await sessionOf(rig)).lastTurn).toEqual({
        kind: "ended",
        stopReason: "end_turn",
      });
      expect(rig.mock.requests().map((request) => request.model)).toContain(
        CONFIGURED_MODEL,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("rejected model with the real opencode CLI and a local chat mock", () => {
  it(
    "model unknown to the real opencode fails the turn without rotation",
    async () => {
      const rig = await openRig({
        [OPENCODE_KEY_A]: ChatScenario.ok,
        [OPENCODE_KEY_B]: ChatScenario.ok,
      });
      const { handlers } = rig.backend;

      await handlers["session/start"]({
        cwd: rig.repo,
        profile: PermissionProfile.unattended,
        provider: ProviderId.opencode,
        model: {
          provider: ProviderId.opencode,
          model: `custom/${UNKNOWN_MODEL}`,
        },
      });
      await handlers["session/prompt"]({ text: "Reply with one word" });
      await vi.waitFor(async () => {
        expect((await sessionOf(rig)).lastTurn).not.toBeNull();
      }, WAIT_OPTIONS);

      const view = await sessionOf(rig);
      expect(view.lastTurn).toEqual({
        kind: "failed",
        message: expect.stringContaining(UNKNOWN_MODEL) as string,
      });
      expect(view.activeAccountId).toBe((await accountIds(rig)).A);
      expect(rig.mock.requests().filter((request) => request.hasTools)).toEqual(
        [],
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("key rotation with the real opencode CLI and a local chat mock", () => {
  it(
    "opencode_rotates_key_a_to_b_after_rate_limit",
    async () => {
      const rig = await rotate();
      const ids = await accountIds(rig);

      const { entries } = await rig.backend.handlers["switchLog/list"]({});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        from: ids.A,
        to: ids.B,
        reason: SwitchReason.rateLimit,
      });
      expect(entries[0]?.resetsAt).toEqual(expect.any(Number));
      const keys = rig.mock.requests().map((request) => request.key);
      const lastA = keys.lastIndexOf(OPENCODE_KEY_A);
      expect(lastA).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(OPENCODE_KEY_B)).toBeGreaterThan(lastA);
      expect(rig.mock.requests().every((request) => request.key !== "")).toBe(
        true,
      );
      const view = await sessionOf(rig);
      expect(view.activeAccountId).toBe(ids.B);
      expect(view.turnInFlight).toBe(false);
      expect(await readEffectLines(rig.repo)).toEqual(EXPECTED_EFFECT_LINES);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "opencode_keys_never_reach_disk_env_or_logs",
    async () => {
      const rig = await rotate();

      const pids = await opencodeServePids();
      expect(pids.length).toBeGreaterThan(0);
      for (const pid of pids) {
        const environ = await readFile(join(PROC_ROOT, pid, "environ"));
        for (const key of OPENCODE_KEYS) {
          expect(environ.includes(key)).toBe(false);
        }
      }
      const runDirs = await runtimeRunDirs();
      expect(runDirs.length).toBeGreaterThan(0);
      expect(await findKeyLeaks([rig.root, ...runDirs], OPENCODE_KEYS)).toEqual(
        [],
      );
      await rig.backend.shutdown();
      expect(await findKeyLeaks([rig.root], OPENCODE_KEYS)).toEqual([]);
      const output = rig.consoleOutput.join("\n");
      for (const key of OPENCODE_KEYS) {
        expect(output).not.toContain(key);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
