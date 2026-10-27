import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgentProcesses,
  type AgentFailure,
  type AgentProcess,
} from "../../src/backend/agentProcesses";
import {
  resolveLockKey,
  WorktreeBusyError,
  WorktreeLocks,
} from "../../src/backend/locks";
import { spawnChild } from "../../src/backend/process/contained";
import { createSystemdScopeContainer } from "../../src/backend/process/linux";
import {
  StopFailureReason,
  type SpawnSpec,
} from "../../src/backend/process/container";
import { FakeContainer } from "../fakes/fakeContainer";
import { createHangingExec, raceAgainstHang } from "../fakes/hangingExec";
import {
  collectLines,
  isRunning,
  KEEP_ALIVE_SCRIPT,
  killQuietly,
  makeTempDir,
  nodeArgs,
  runGit,
  SPAWN_SETSID_SLEEPER_SCRIPT,
  stringEnv,
  systemdUserAvailable,
  WAIT_TIMEOUT_MS,
} from "../fakes/processHelpers";

const execFileAsync = promisify(execFile);
const SYSTEMD_AVAILABLE = await systemdUserAvailable();
const GRACE_MS = 200;
const UNIT_NOT_LOADED_MESSAGE = "not loaded";
const TEST_INSTANCE_ID = `acc${String(process.pid)}`;
const HANG_MS = 1000;
const SUBDIRECTORY = "packages/app";

let worktree = "";
let runCounter = 0;
const startedRunIds: string[] = [];
const trackedPids: number[] = [];

function nextRunId(): string {
  runCounter += 1;
  const runId = `t${String(process.pid)}x${String(runCounter)}`;
  startedRunIds.push(runId);
  return runId;
}

function specFor(script: string, cwd = worktree): SpawnSpec {
  return {
    command: process.execPath,
    args: nodeArgs(script),
    env: stringEnv(),
    cwd,
    runId: nextRunId(),
  };
}

async function firstOutputPid(agent: AgentProcess): Promise<number> {
  const lines = collectLines(agent.contained.stdout);
  await vi.waitFor(
    () => {
      expect(lines.length).toBeGreaterThan(0);
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  const pid = Number(lines[0]);
  trackedPids.push(pid);
  return pid;
}

const SPAWN_SLEEPER_AND_STAY = `${SPAWN_SETSID_SLEEPER_SCRIPT}${KEEP_ALIVE_SCRIPT}`;
const SPAWN_SLEEPER_AND_EXIT = SPAWN_SETSID_SLEEPER_SCRIPT;

beforeEach(async () => {
  worktree = await makeTempDir();
  await runGit(worktree, ["init", "--quiet"]);
});

afterEach(async () => {
  for (const runId of startedRunIds.splice(0)) {
    await execFileAsync("systemctl", [
      "--user",
      "kill",
      "--signal=SIGKILL",
      `codeweave-${TEST_INSTANCE_ID}-${runId}.scope`,
    ]).catch((error: unknown) => {
      if (!String(error).includes(UNIT_NOT_LOADED_MESSAGE)) {
        console.warn("cleanup kill failed", error);
      }
    });
  }
  for (const pid of trackedPids.splice(0)) {
    killQuietly(pid);
  }
});

function createAgents(): ReturnType<typeof createAgentProcesses> {
  return createAgentProcesses({
    container: createSystemdScopeContainer({ instanceId: TEST_INSTANCE_ID }),
    locks: new WorktreeLocks(),
  });
}

describe.runIf(SYSTEMD_AVAILABLE)("systemd scope container", () => {
  it("scope_container_streams_stdout_lines", async () => {
    const container = createSystemdScopeContainer({
      instanceId: TEST_INSTANCE_ID,
    });
    const spec = specFor(
      `console.log("first"); setTimeout(() => console.log("second"), 150); ${KEEP_ALIVE_SCRIPT}`,
    );
    const contained = await container.spawn(spec);
    const lines = collectLines(contained.stdout);

    await vi.waitFor(
      () => {
        expect(lines).toEqual(["first", "second"]);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const cgroup = await readFile(
      `/proc/${String(contained.pid)}/cgroup`,
      "utf8",
    );
    expect(cgroup).toContain(
      `codeweave-${TEST_INSTANCE_ID}-${spec.runId}.scope`,
    );
    expect((await contained.stop(GRACE_MS)).ok).toBe(true);
  });

  it("stop_kills_setsid_grandchild", async () => {
    const agent = await createAgents().start(specFor(SPAWN_SLEEPER_AND_STAY));
    const grandchild = await firstOutputPid(agent);
    expect(await isRunning(grandchild)).toBe(true);

    const result = await agent.stop(GRACE_MS);

    expect(result).toEqual({ ok: true });
    expect(await isRunning(grandchild)).toBe(false);
    expect(await agent.contained.isEmpty()).toBe(true);
  });

  it("stop_waits_for_empty_container", async () => {
    const stubbornScript = `process.on("SIGTERM", () => {}); ${SPAWN_SLEEPER_AND_STAY}`;
    const agent = await createAgents().start(specFor(stubbornScript));
    const grandchild = await firstOutputPid(agent);
    const startedAt = Date.now();

    const result = await agent.stop(GRACE_MS);

    expect(result).toEqual({ ok: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(GRACE_MS);
    expect(await isRunning(agent.contained.pid)).toBe(false);
    expect(await isRunning(grandchild)).toBe(false);
  });
});

describe.runIf(SYSTEMD_AVAILABLE)("scope container lock lifecycle", () => {
  it("second_start_in_same_worktree_is_busy", async () => {
    const agents = createAgents();
    const first = await agents.start(specFor(KEEP_ALIVE_SCRIPT));
    const subdirectory = join(worktree, SUBDIRECTORY);
    await execFileAsync("mkdir", ["-p", subdirectory]);

    await expect(
      agents.start(specFor(KEEP_ALIVE_SCRIPT, subdirectory)),
    ).rejects.toBeInstanceOf(WorktreeBusyError);

    expect(await first.stop(GRACE_MS)).toEqual({ ok: true });
    const second = await agents.start(specFor(KEEP_ALIVE_SCRIPT));
    expect((await second.stop(GRACE_MS)).ok).toBe(true);
  });
  it("container_releases_lock_when_child_exits", async () => {
    const agents = createAgents();
    const first = await agents.start(specFor(SPAWN_SLEEPER_AND_EXIT));
    const grandchild = await firstOutputPid(first);

    let second: AgentProcess | undefined;
    await vi.waitFor(
      async () => {
        second = await agents.start(specFor(KEEP_ALIVE_SCRIPT));
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    expect(await isRunning(grandchild)).toBe(false);
    expect((await second?.stop(GRACE_MS))?.ok).toBe(true);
  });
});

describe("worktree lock lifecycle", () => {
  it("lock_key_is_worktree_root_for_subdirectory", async () => {
    const subdirectory = join(worktree, SUBDIRECTORY);
    await execFileAsync("mkdir", ["-p", subdirectory]);

    expect(await resolveLockKey(subdirectory)).toBe(await realpath(worktree));
  });

  it("lease_double_release_keeps_new_lock", async () => {
    const container = new FakeContainer([]);
    container.holdStops();
    const agents = createAgentProcesses({
      container,
      locks: new WorktreeLocks(),
    });
    const first = await agents.start(specFor(KEEP_ALIVE_SCRIPT));
    const firstContained = container.spawned[0];

    firstContained?.emitExit(0);
    const explicitStop = first.stop(GRACE_MS);
    firstContained?.resolveOldestHeldStop();
    await vi.waitFor(async () => {
      const second = await agents.start(specFor(KEEP_ALIVE_SCRIPT));
      expect(second.contained.runId).toBeTruthy();
    });
    firstContained?.resolveHeldStops();
    await explicitStop;

    expect(firstContained?.stopCalls).toEqual([0]);
    await expect(
      agents.start(specFor(KEEP_ALIVE_SCRIPT)),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  it("lock_held_while_setsid_descendant_alive", async () => {
    const survivors = [777];
    const container = new FakeContainer([
      { ok: false, reason: "not_empty_after_timeout", survivors },
      { ok: true },
    ]);
    const failures: AgentFailure[] = [];
    const agents = createAgentProcesses({
      container,
      locks: new WorktreeLocks(),
      onFailure: (failure) => failures.push(failure),
    });
    const agent = await agents.start(specFor(KEEP_ALIVE_SCRIPT));

    container.spawned[0]?.emitExit(0);

    await vi.waitFor(() => {
      expect(failures).toHaveLength(1);
    });
    expect(failures[0]?.survivors).toEqual(survivors);
    await expect(
      agents.start(specFor(KEEP_ALIVE_SCRIPT)),
    ).rejects.toBeInstanceOf(WorktreeBusyError);

    expect(await agent.stop(0)).toEqual({ ok: true });
    const next = await agents.start(specFor(KEEP_ALIVE_SCRIPT));
    expect(next.contained.runId).toBeTruthy();
  });
});

async function idleChild(): ReturnType<typeof spawnChild> {
  const child = await spawnChild(
    process.execPath,
    nodeArgs(KEEP_ALIVE_SCRIPT),
    {},
  );
  if (child.pid !== undefined) {
    trackedPids.push(child.pid);
  }
  return child;
}

describe("systemd container call timeouts", () => {
  it("systemd_call_timeout_keeps_lock", async () => {
    const { exec } = createHangingExec(["show"]);
    const failures: AgentFailure[] = [];
    const agents = createAgentProcesses({
      container: createSystemdScopeContainer({
        exec,
        instanceId: TEST_INSTANCE_ID,
        spawnChild: idleChild,
      }),
      locks: new WorktreeLocks(),
      onFailure: (failure) => failures.push(failure),
    });
    const agent = await agents.start(specFor(KEEP_ALIVE_SCRIPT));

    const result = await raceAgainstHang(agent.stop(0), HANG_MS);

    expect(result).toEqual({
      ok: false,
      reason: StopFailureReason.notEmptyAfterTimeout,
      survivors: [],
    });
    expect(failures).toHaveLength(1);
    await expect(
      agents.start(specFor(KEEP_ALIVE_SCRIPT)),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });
});

describe("systemd container orphan sweep", () => {
  it("sweep_spares_live_instance_and_own_scope", async () => {
    const killedUnits: string[] = [];
    const container = createSystemdScopeContainer({
      instanceId: "self2",
      exec: (_file, args) => {
        if (args.includes("kill")) {
          killedUnits.push(args.at(-1) ?? "");
          return Promise.resolve("");
        }
        return Promise.resolve(
          [
            "codeweave-dead0-run1.scope loaded active running a",
            "codeweave-alive1-run2.scope loaded active running b",
            "codeweave-self2-run3.scope loaded active running c",
            "codeweave-dead0-run4.scope loaded active running d",
            "",
          ].join("\n"),
        );
      },
      readFile: () =>
        Promise.resolve("0::/app.slice/codeweave-dead0-run4.scope\n"),
    });

    expect(await container.sweepOrphans(["dead0"])).toBe(1);

    expect(killedUnits).toEqual(["codeweave-dead0-run1.scope"]);
  });
});
