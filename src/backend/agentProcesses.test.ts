import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FakeContainer } from "../../tests/fakes/fakeContainer";
import { makeTempDir } from "../../tests/fakes/processHelpers";
import { resolvePathLockKey } from "../../tests/fakes/rigProcesses";

import { createAgentProcesses } from "./agentProcesses";
import { WorktreeBusyError, WorktreeLocks } from "./locks";
import type { Contained, SpawnSpec } from "./process/container";

const SHARED_KEY = "/shared/lock/key";
const RESOLVER_FAILURE = new Error("cannot resolve the lock key");
const SPAWN_FAILURE = new Error("cannot spawn the agent");

class FlakyContainer extends FakeContainer {
  private failures = 1;

  override spawn(spec: SpawnSpec): Promise<Contained> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(SPAWN_FAILURE);
    }
    return super.spawn(spec);
  }
}

function specIn(cwd: string): SpawnSpec {
  return {
    command: "agent",
    args: [],
    env: {},
    cwd,
    runId: "run-1",
  };
}

describe("agent processes lock key", () => {
  it("start_locks_on_the_key_the_injected_resolver_returns", async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const recorded: string[] = [];
    const agents = createAgentProcesses({
      container: new FakeContainer([]),
      locks: new WorktreeLocks(),
      resolveLockKey: (cwd) => {
        recorded.push(cwd);
        return Promise.resolve(SHARED_KEY);
      },
    });

    await agents.start(specIn(dirA));
    await expect(agents.start(specIn(dirB))).rejects.toBeInstanceOf(
      WorktreeBusyError,
    );

    expect(recorded).toEqual([dirA, dirB]);
  });

  it("start_spawns_nothing_when_the_resolver_rejects", async () => {
    const dir = await makeTempDir();
    const container = new FakeContainer([]);
    let calls = 0;
    const agents = createAgentProcesses({
      container,
      locks: new WorktreeLocks(),
      resolveLockKey: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(RESOLVER_FAILURE)
          : Promise.resolve(SHARED_KEY);
      },
    });

    await expect(agents.start(specIn(dir))).rejects.toBe(RESOLVER_FAILURE);

    expect(container.spawned).toEqual([]);
    await agents.start(specIn(dir));
    expect(container.spawned).toHaveLength(1);
  });
});

describe("agent processes lock lifecycle", () => {
  it("spawn_failure_releases_the_resolved_key", async () => {
    const dir = await makeTempDir();
    const container = new FlakyContainer([]);
    const agents = createAgentProcesses({
      container,
      locks: new WorktreeLocks(),
      resolveLockKey: resolvePathLockKey,
    });

    await expect(agents.start(specIn(dir))).rejects.toBe(SPAWN_FAILURE);

    await agents.start(specIn(dir));
    expect(container.spawned).toHaveLength(1);
  });

  it("second_start_on_the_same_resolved_key_is_busy_until_stop", async () => {
    const dir = await makeTempDir();
    const agents = createAgentProcesses({
      container: new FakeContainer([]),
      locks: new WorktreeLocks(),
      resolveLockKey: resolvePathLockKey,
    });
    const first = await agents.start(specIn(dir));

    await expect(agents.start(specIn(dir))).rejects.toBeInstanceOf(
      WorktreeBusyError,
    );

    await first.stop(0);
    await expect(agents.start(specIn(dir))).resolves.toBeDefined();
  });
});

describe("path lock key", () => {
  it.skipIf(process.platform === "win32")(
    "path_lock_key_resolves_symlinks",
    async () => {
      const target = await makeTempDir();
      const linkParent = await makeTempDir();
      const link = join(linkParent, "link");
      await symlink(target, link);

      expect(await resolvePathLockKey(link)).toBe(target);
    },
  );
});
