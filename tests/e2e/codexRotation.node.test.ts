import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { locateClaudeAcpEntry } from "../../src/backend/claude/launch";
import { PROBE_RUN_ID_PREFIX } from "../../src/backend/constants";
import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
} from "../../src/backend/process/container";
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
  startResponsesMock,
  type RecordedRequest,
  type ResponsesMock,
} from "../fakes/responsesMock";

import {
  assertWorkspaceIsolated,
  CODEX_ROTATION_SCENARIOS,
  createCodexRotationWorkspace,
} from "./codexRotationFixture";
import {
  ALLOW_ONCE_KIND,
  KEY_A,
  KEY_B,
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  createCleanupStack,
  readEffectLines,
  type RotationWorkspace,
} from "./rotationFixture";

const TEST_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const EFFECTS_FILE = "effects.log";
const EXPECTED_EFFECT_LINES = ["deploy-side-effect"];
const CONTEXT_INTRO =
  "You are taking over a coding session from another account that hit its usage limit.";
const NO_RERUN_WORDING =
  "Side effect: do not re-run automatically; verify its effect first.";
const COMPLETED_STATUS = "Status: completed";
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

interface Observation {
  spawned: number;
  runAGoneAtSecondSpawn: boolean | null;
}

interface Rig {
  readonly backend: Backend;
  readonly mock: ResponsesMock;
  readonly workspace: RotationWorkspace;
  readonly observation: Observation;
}

const cleanup = createCleanupStack();

function isolatedParentEnv(): NodeJS.ProcessEnv {
  const entries = ENV_ALLOW_LIST.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return Object.fromEntries(entries);
}

function recordingContainer(
  inner: ProcessContainer,
  spawned: Contained[],
  observation: Observation,
): ProcessContainer {
  return {
    kind: inner.kind,
    launch: (spec, launcher) => inner.launch(spec, launcher),
    async spawn(spec: SpawnSpec): Promise<Contained> {
      if (spec.runId.startsWith(PROBE_RUN_ID_PREFIX)) {
        return inner.spawn(spec);
      }
      const [runA] = spawned;
      if (runA !== undefined && observation.runAGoneAtSecondSpawn === null) {
        observation.runAGoneAtSecondSpawn = await runA.isEmpty();
      }
      const contained = await inner.spawn(spec);
      spawned.push(contained);
      observation.spawned = spawned.length;
      return contained;
    },
    sweepOrphans: (stale) => inner.sweepOrphans(stale),
  };
}

async function openRig(profile: PermissionProfile): Promise<Rig> {
  const mock = await startResponsesMock(CODEX_ROTATION_SCENARIOS);
  cleanup.add(() => mock.close());
  const workspace = await createCodexRotationWorkspace(profile, mock.url);
  cleanup.add(() => workspace.dispose());
  assertWorkspaceIsolated(workspace, mock.url);
  const spawned: Contained[] = [];
  const observation: Observation = {
    spawned: 0,
    runAGoneAtSecondSpawn: null,
  };
  const backend = await startBackend({
    vault: createFakeVault(),
    args: { userData: workspace.userData, testAgentEnv: {} },
    broadcast: () => undefined,
    createContainer: async (instanceId) =>
      recordingContainer(
        await createProcessContainer(process.platform, undefined, instanceId),
        spawned,
        observation,
      ),
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
  return { backend, mock, workspace, observation };
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
  expect(existsSync(join(rig.workspace.repo, EFFECTS_FILE))).toBe(false);
  await rig.backend.handlers["permission/answer"]({
    requestId: permission?.requestId ?? "",
    optionId: allow?.optionId ?? "",
  });
}

async function rotate(): Promise<Rig> {
  const profile = PermissionProfile.ask;
  const rig = await openRig(profile);
  const { handlers } = rig.backend;
  await handlers["session/start"]({
    cwd: rig.workspace.repo,
    profile,
    provider: ProviderId.codex,
  });
  await handlers["session/prompt"]({ text: ROTATION_PROMPT });
  await approveCommand(rig);
  await vi.waitFor(async () => {
    const view = await sessionOf(rig);
    expect(view.activeAccountId).toBe(rig.workspace.accountB.id);
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).not.toBeNull();
  }, WAIT_OPTIONS);
  return rig;
}

function requestsOf(
  mock: ResponsesMock,
  key: string,
): readonly RecordedRequest[] {
  return mock.requests().filter((request) => request.key === key);
}

function expectContextPackage(request: RecordedRequest | undefined): void {
  expect(request).toBeDefined();
  const text = request?.inputText ?? "";
  expect(text).toContain(CONTEXT_INTRO);
  expect(text).toContain(ROTATION_PROMPT);
  expect(text).toContain(ROTATION_COMMAND);
  expect(text).toContain(COMPLETED_STATUS);
  expect(text).toContain(NO_RERUN_WORDING);
}

function expectBHandoverOrder(mock: ResponsesMock): void {
  const all = mock.requests();
  const firstB = all.findIndex((request) => request.key === KEY_B);
  const lastA = all.findLastIndex((request) => request.key === KEY_A);
  expect(lastA).toBeGreaterThanOrEqual(0);
  expect(firstB).toBeGreaterThan(lastA);
  for (const request of requestsOf(mock, KEY_B)) {
    expect(request.functionCallOutputs).toBe(0);
    expect(request.inputText).toContain(CONTEXT_INTRO);
  }
}

async function expectSwitchEntry(rig: Rig): Promise<void> {
  const { workspace, mock } = rig;
  const { entries } = await rig.backend.handlers["switchLog/list"]({});
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    from: workspace.accountA.id,
    to: workspace.accountB.id,
    reason: SwitchReason.rateLimit,
    resetsAt: mock.resetEpoch,
  });
}

async function expectAccountsAfterRotation(rig: Rig): Promise<void> {
  const { workspace, mock } = rig;
  const { accounts } = await rig.backend.handlers["accounts/list"]({});
  const runtimeOf = (id: string): unknown =>
    accounts.find((account) => account.id === id)?.runtime;
  expect(runtimeOf(workspace.accountA.id)).toEqual({
    status: "exhausted",
    resetsAt: mock.resetEpoch,
  });
  expect(runtimeOf(workspace.accountB.id)).toEqual({ status: "ready" });
}

async function expectRotationWithoutRerun(rig: Rig): Promise<void> {
  const { workspace, mock, observation } = rig;
  expect(await readEffectLines(workspace.repo)).toEqual(EXPECTED_EFFECT_LINES);
  expectContextPackage(requestsOf(mock, KEY_B)[0]);
  expectBHandoverOrder(mock);
  await expectSwitchEntry(rig);
  expect(observation.spawned).toBe(2);
  expect(observation.runAGoneAtSecondSpawn).toBe(true);
  await expectAccountsAfterRotation(rig);
  const view = await sessionOf(rig);
  expect(view.activeAccountId).toBe(workspace.accountB.id);
}

afterEach(async () => {
  await cleanup.run();
}, CLEANUP_TIMEOUT_MS);

describe("rotation with the real codex CLI and a local Responses mock", () => {
  it(
    "codex_rotation_ask_switches_after_approval",
    async () => {
      const rig = await rotate();

      await expectRotationWithoutRerun(rig);
    },
    TEST_TIMEOUT_MS,
  );
});
