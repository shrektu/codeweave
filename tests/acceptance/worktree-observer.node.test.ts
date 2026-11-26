import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createAgentProcesses } from "../../src/backend/agentProcesses";
import { fakeAttachmentStore } from "../fakes/fakeAttachmentStore";
import { createClaudeAcpAdapter } from "../../src/backend/claude/acpAdapter";
import { createLeaseModes } from "../../src/backend/leaseModes";
import {
  LeaseMode,
  WorktreeBusyError,
  WorktreeLocks,
} from "../../src/backend/locks";
import {
  createSessionPool,
  type SessionPool,
} from "../../src/backend/sessionPool";
import { createJsonStore } from "../../src/backend/storage";
import { ACCOUNT_A } from "../fakes/backendRig";
import {
  RIG_ADAPTER_ENTRY,
  RIG_EXEC_PATH,
  ScriptedAcpContainer,
} from "../fakes/fakeAcpAgent";
import { resolvePathLockKey } from "../fakes/rigProcesses";

interface Composition {
  readonly pool: SessionPool;
  readonly cwd: string;
  readonly spawn: (runId: string) => Promise<unknown>;
}

const dirs: string[] = [];
const pools: SessionPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function compose(): Promise<Composition> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-observer-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-observer-cwd-"));
  dirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT_A]);
  const leaseModes = createLeaseModes();
  const processes = createAgentProcesses({
    container: new ScriptedAcpContainer(),
    locks: new WorktreeLocks(),
    resolveLockKey: resolvePathLockKey,
    leaseModeOf: (runId) => leaseModes.modeOf(runId),
  });
  let counter = 0;
  const pool = createSessionPool({
    adapter: createClaudeAcpAdapter({
      processes,
      envFor: () => ({}),
      execPath: RIG_EXEC_PATH,
      adapterEntry: RIG_ADAPTER_ENTRY,
    }),
    store,
    broadcast: () => undefined,
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => {
      counter += 1;
      return `agent-${String(counter)}`;
    },
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder: (requested) => Promise.resolve(requested ?? "/home/u"),
    attachments: fakeAttachmentStore(),
    protectedPaths: () => Promise.resolve([]),
    leaseModes,
  });
  pools.push(pool);
  return {
    pool,
    cwd,
    spawn: (runId) =>
      processes.start({
        command: "/usr/bin/claude",
        args: [],
        env: {},
        cwd,
        runId,
      }),
  };
}

it("an_observer_main_session_and_an_exclusive_node_session_share_a_worktree", async () => {
  const { pool, cwd, spawn } = await compose();

  await expect(
    pool.createMain().start({ cwd }, { leaseMode: LeaseMode.observer }),
  ).resolves.toMatchObject({ phase: { phase: "running" } });
  await expect(pool.forRun("run-a").start({ cwd })).resolves.toMatchObject({
    phase: { phase: "running" },
  });

  await expect(spawn("third-agent")).rejects.toBeInstanceOf(WorktreeBusyError);
  await expect(pool.forRun("run-b").start({ cwd })).rejects.toThrow(
    "Worktree is already in use",
  );
});

it("an_exclusive_main_session_still_blocks_a_node_session_on_its_worktree", async () => {
  const { pool, cwd } = await compose();
  await pool.createMain().start({ cwd });

  await expect(pool.forRun("run-a").start({ cwd })).rejects.toThrow(
    "Worktree is already in use",
  );
});
