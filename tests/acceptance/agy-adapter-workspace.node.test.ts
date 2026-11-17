import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_WALK_LIMIT_MESSAGE,
  WORKSPACE_WALK_MAX_ENTRIES,
} from "../../src/backend/agy/constants";
import { fingerprintAgentsDir } from "../../src/backend/agy/workspaceGuard";
import { PermissionProfile } from "../../src/domain/types";
import {
  createAgyRig,
  delayFor,
  initStep,
  removeAgyRigDirs,
  replyTurn,
  startAgyHandle,
  type AgyRig,
} from "../fakes/fakeAgy";
import { settlesWithin } from "../fakes/fakeCodexAppServer";

const CONV = "conv-1";
const AGENTS_DIR = ".agents";
const CHANGED_MESSAGE =
  "Gemini workspace config (.agents) changed during this session; review it and start a new session";

afterEach(async () => {
  await removeAgyRigDirs();
});

async function plant(
  rig: AgyRig,
  relative: string,
  content: string,
): Promise<void> {
  const file = join(rig.cwd, AGENTS_DIR, relative);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

async function firstTurnDone(rig: AgyRig): ReturnType<typeof startAgyHandle> {
  const started = await startAgyHandle(rig);
  rig.container.scriptTurn(replyTurn(CONV, "one"));
  await started.handle.prompt("one", { model: null });
  return started;
}

describe("agy adapter workspace config guard", () => {
  it("planted_workspace_hook_blocks_respawn", async () => {
    const rig = await createAgyRig();
    const { handle, events } = await firstTurnDone(rig);
    await plant(rig, "hooks.json", '{"evil":true}');
    await handle.setProfile(PermissionProfile.plan);

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: CHANGED_MESSAGE,
    });
  });

  it("planted_workspace_hook_blocks_respawn_after_a_plugin_edit", async () => {
    const rig = await createAgyRig();
    await plant(rig, "plugins/p/plugin.json", "1");
    const { handle, events } = await firstTurnDone(rig);
    await plant(rig, "plugins/p/plugin.json", "2");
    await handle.setProfile(PermissionProfile.unattended);

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      message: CHANGED_MESSAGE,
    });
  });

  it("unchanged_workspace_config_respawns", async () => {
    const rig = await createAgyRig();
    await plant(rig, "hooks.json", "{}");
    const { handle } = await firstTurnDone(rig);
    await handle.setProfile(PermissionProfile.plan);
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(2);
  });

  it("teamwork_change_does_not_block_respawn", async () => {
    const rig = await createAgyRig();
    const { handle, events } = await firstTurnDone(rig);
    await plant(rig, "teamwork/t1/state.json", "{}");
    await handle.setProfile(PermissionProfile.plan);
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(2);
    expect(events.map((event) => event.type)).not.toContain("turn_error");
  });
});

const LATE_CHECK_MS = 100;
const SETTLE_BOUND_MS = 5000;

function slowAfterFirst(): (worktreeRoot: string) => Promise<string> {
  let calls = 0;
  return async (worktreeRoot) => {
    calls += 1;
    if (calls > 1) {
      await new Promise((resolve) => setTimeout(resolve, LATE_CHECK_MS));
    }
    return fingerprintAgentsDir(worktreeRoot);
  };
}

describe("agy adapter fast result waits for the init workspace check", () => {
  it("fast_result_waits_for_init_workspace_check_planted_hook", async () => {
    const rig = await createAgyRig({ fingerprintWorkspace: slowAfterFirst() });
    const { handle, events } = await startAgyHandle(rig);
    await plant(rig, "hooks.json", '{"evil":true}');
    rig.container.scriptTurn(replyTurn(CONV, "one"));

    await handle.prompt("one", { model: null });

    expect(events.map((event) => event.type)).not.toContain("turn_end");
    expect(events.filter((event) => event.type === "turn_error")).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: CHANGED_MESSAGE,
      },
    ]);
    expect(rig.container.agySpawns()[0]?.contained.hasExited).toBe(true);
  });

  it("fast_result_waits_for_init_workspace_check_unchanged_ends_turn", async () => {
    const rig = await createAgyRig({ fingerprintWorkspace: slowAfterFirst() });
    const { handle, events } = await startAgyHandle(rig);
    rig.container.scriptTurn(replyTurn(CONV, "one"));

    await handle.prompt("one", { model: null });

    expect(events.map((event) => event.type)).not.toContain("turn_error");
    expect(events.at(-1)).toMatchObject({ type: "turn_end" });
  });
});

describe("agy adapter workspace walk is bounded", () => {
  it.skipIf(process.platform === "win32")(
    "fingerprint_walk_is_bounded_link_to_huge_tree_fails_closed",
    async () => {
      const rig = await createAgyRig();
      const { handle, events } = await firstTurnDone(rig);
      const huge = join(rig.cwd, "huge");
      await mkdir(huge);
      await Promise.all(
        Array.from({ length: WORKSPACE_WALK_MAX_ENTRIES + 1 }, (_, index) =>
          writeFile(join(huge, `f${String(index)}`), ""),
        ),
      );
      await mkdir(join(rig.cwd, AGENTS_DIR));
      await symlink("../huge", join(rig.cwd, AGENTS_DIR, "skills"));
      await handle.setProfile(PermissionProfile.plan);
      rig.container.scriptTurn(replyTurn(CONV, "two"));

      const prompt = handle.prompt("two", { model: null });

      expect(await settlesWithin(prompt, SETTLE_BOUND_MS)).toBe(true);
      expect(rig.container.agySpawns()).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: WORKSPACE_WALK_LIMIT_MESSAGE,
      });
    },
    30_000,
  );
});

describe("agy adapter workspace config guard around the spawn", () => {
  it("agents_change_during_spawn_is_caught_after_init", async () => {
    const rig = await createAgyRig();
    const { handle, events } = await startAgyHandle(rig);
    await plant(rig, "hooks.json", '{"evil":true}');
    rig.container.scriptTurn([
      initStep(CONV),
      delayFor(150),
      ...replyTurn(CONV, "one").slice(1),
    ]);

    await handle.prompt("one", { model: null });

    expect(events.at(-1)).toEqual({
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: CHANGED_MESSAGE,
    });
    expect(rig.container.agySpawns()[0]?.contained.hasExited).toBe(true);
  });

  it("agents_change_during_spawn_is_caught_after_init_fingerprint_follows_hook_write", async () => {
    const observed: number[] = [];
    let writes: readonly unknown[] = [];
    const rig = await createAgyRig({
      fingerprintWorkspace: () => {
        observed.push(writes.length);
        return Promise.resolve("same");
      },
    });
    writes = rig.hookWrites;
    const { handle } = await firstTurnDone(rig);
    await handle.setProfile(PermissionProfile.plan);
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two", { model: null });

    expect(observed.slice(0, 3)).toEqual([1, 1, 2]);
  });

  it("workspace_fingerprint_failure_fails_closed_before_the_spawn", async () => {
    let calls = 0;
    const rig = await createAgyRig({
      fingerprintWorkspace: () => {
        calls += 1;
        return calls === 1 || calls === 2
          ? Promise.resolve("same")
          : Promise.reject(new Error("cannot read .agents"));
      },
    });
    const { handle, events } = await firstTurnDone(rig);
    await handle.setProfile(PermissionProfile.plan);

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      message: "cannot read .agents",
    });
  });
});

describe("agy adapter workspace guard follows symlinks", () => {
  it("symlinked_agents_target_change_blocks_respawn", async () => {
    const rig = await createAgyRig();
    await mkdir(join(rig.cwd, "shared"));
    await writeFile(join(rig.cwd, "shared", "plugin.js"), "1");
    await mkdir(join(rig.cwd, AGENTS_DIR));
    await symlink("../shared", join(rig.cwd, AGENTS_DIR, "plugins"));
    const { handle, events } = await firstTurnDone(rig);
    await writeFile(join(rig.cwd, "shared", "plugin.js"), "2");
    await handle.setProfile(PermissionProfile.plan);

    await handle.prompt("two", { model: null });

    expect(rig.container.agySpawns()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_error",
      message: CHANGED_MESSAGE,
    });
  });
});
