import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { locateClaudeAcpEntry } from "../../src/backend/claude/launch";
import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
} from "../../src/backend/process/container";
import { createProcessContainer } from "../../src/backend/process/select";
import {
  createClaudeExecutableResolver,
  startBackend,
  type Backend,
} from "../../src/backend/startup";
import { inspectWorktree } from "../../src/backend/worktree";
import { PermissionProfile, SwitchReason } from "../../src/domain/types";
import type { SessionView } from "../../src/shared/views";
import {
  startAnthropicMock,
  userTexts,
  type AnthropicMock,
} from "../fakes/anthropicMock";

import {
  ALLOW_ONCE_KIND,
  KEY_A,
  KEY_B,
  ROTATION_COMMAND,
  ROTATION_PROMPT,
  ROTATION_SCENARIOS,
  createCleanupStack,
  createRotationWorkspace,
  readEffectLines,
  rotationAgentEnv,
  type RotationWorkspace,
} from "./rotationFixture";

const TEST_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const EFFECTS_FILE = "effects.log";
const EXPECTED_EFFECT_LINES = ["deploy-side-effect"];
const WAIT_OPTIONS = {
  timeout: STEP_TIMEOUT_MS,
  interval: POLL_INTERVAL_MS,
} as const;

interface Observation {
  spawnedAtFirstBRequest: number;
  runAGoneAtFirstBRequest: boolean | null;
  runAGoneAtSecondSpawn: boolean | null;
}

interface Rig {
  readonly backend: Backend;
  readonly mock: AnthropicMock;
  readonly workspace: RotationWorkspace;
  readonly observation: Observation;
}

const cleanup = createCleanupStack();

function recordingContainer(
  inner: ProcessContainer,
  spawned: Contained[],
  observation: Observation,
): ProcessContainer {
  return {
    kind: inner.kind,
    async spawn(spec: SpawnSpec): Promise<Contained> {
      const [runA] = spawned;
      if (runA !== undefined && observation.runAGoneAtSecondSpawn === null) {
        observation.runAGoneAtSecondSpawn = await runA.isEmpty();
      }
      const contained = await inner.spawn(spec);
      spawned.push(contained);
      return contained;
    },
    sweepOrphans: (stale) => inner.sweepOrphans(stale),
  };
}

async function openRig(profile: PermissionProfile): Promise<Rig> {
  const workspace = await createRotationWorkspace(profile);
  cleanup.add(() => workspace.dispose());
  const spawned: Contained[] = [];
  const observation: Observation = {
    spawnedAtFirstBRequest: 0,
    runAGoneAtFirstBRequest: null,
    runAGoneAtSecondSpawn: null,
  };
  const mock = await startAnthropicMock({
    scenarios: ROTATION_SCENARIOS,
    toolCommand: ROTATION_COMMAND,
    onMainRequest: async (key) => {
      const [runA] = spawned;
      if (key === KEY_B && observation.runAGoneAtFirstBRequest === null) {
        observation.spawnedAtFirstBRequest = spawned.length;
        observation.runAGoneAtFirstBRequest = (await runA?.isEmpty()) ?? null;
      }
    },
  });
  cleanup.add(() => mock.close());
  const backend = await startBackend({
    args: {
      userData: workspace.userData,
      testAgentEnv: rotationAgentEnv(mock.url),
    },
    broadcast: () => undefined,
    createContainer: async (instanceId) =>
      recordingContainer(
        await createProcessContainer(process.platform, undefined, instanceId),
        spawned,
        observation,
      ),
    execPath: process.execPath,
    adapterEntry: locateClaudeAcpEntry(),
    parentEnv: process.env,
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
    resolveClaudeExecutable: createClaudeExecutableResolver(
      process.env,
      process.platform,
    ),
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
  expect(permission?.command).toBe(ROTATION_COMMAND);
  expect(existsSync(join(rig.workspace.repo, EFFECTS_FILE))).toBe(false);
  await rig.backend.handlers["permission/answer"]({
    requestId: permission?.requestId ?? "",
    optionId: allow?.optionId ?? "",
  });
}

async function rotate(
  profile: PermissionProfile,
  answerPermission: boolean,
): Promise<Rig> {
  const rig = await openRig(profile);
  const { handlers } = rig.backend;
  await handlers["session/start"]({ cwd: rig.workspace.repo, profile });
  await handlers["session/prompt"]({ text: ROTATION_PROMPT });
  if (answerPermission) {
    await approveCommand(rig);
  }
  await vi.waitFor(async () => {
    const view = await sessionOf(rig);
    expect(view.activeAccountId).toBe(rig.workspace.accountB.id);
    expect(view.turnInFlight).toBe(false);
    expect(view.lastTurn).not.toBeNull();
  }, WAIT_OPTIONS);
  return rig;
}

async function expectRotationWithoutRerun(rig: Rig): Promise<void> {
  const { workspace, mock, observation } = rig;
  expect(await readEffectLines(workspace.repo)).toEqual(EXPECTED_EFFECT_LINES);

  const firstMainB = mock.requests.find(
    (request) => request.key === KEY_B && request.isMain,
  );
  expect(firstMainB).toBeDefined();
  const packageText = userTexts(firstMainB?.body ?? { messages: [] }).join(
    "\n",
  );
  expect(packageText).toContain(
    "You are taking over a coding session from another account that hit its usage limit.",
  );
  expect(packageText).toContain(ROTATION_PROMPT);
  expect(packageText).toContain(ROTATION_COMMAND);
  expect(packageText).toContain("Status: completed");
  expect(packageText).toContain(
    "Side effect: do not re-run automatically; verify its effect first.",
  );
  const lastMainA = mock.requests.findLast(
    (request) => request.key === KEY_A && request.isMain,
  );
  expect(lastMainA?.at).toBeLessThanOrEqual(firstMainB?.at ?? 0);

  const { entries } = await rig.backend.handlers["switchLog/list"]({});
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    from: workspace.accountA.id,
    to: workspace.accountB.id,
    reason: SwitchReason.rateLimit,
  });

  expect(observation.spawnedAtFirstBRequest).toBe(2);
  expect(observation.runAGoneAtSecondSpawn).toBe(true);
  expect(observation.runAGoneAtFirstBRequest).toBe(true);

  const view = await sessionOf(rig);
  expect(view.activeAccountId).toBe(workspace.accountB.id);
  expect(view.phase).toEqual({
    phase: "running",
    accountId: workspace.accountB.id,
  });
  expect(view.lastTurn).toEqual({ kind: "ended", stopReason: "end_turn" });
}

afterEach(async () => {
  await cleanup.run();
}, CLEANUP_TIMEOUT_MS);

describe("rotation with the real claude CLI and a local API mock", () => {
  it(
    "rotation_unattended_switches_without_rerun",
    async () => {
      const rig = await rotate(PermissionProfile.unattended, false);

      await expectRotationWithoutRerun(rig);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rotation_ask_switches_after_approval",
    async () => {
      const rig = await rotate(PermissionProfile.ask, true);

      await expectRotationWithoutRerun(rig);
    },
    TEST_TIMEOUT_MS,
  );
});
