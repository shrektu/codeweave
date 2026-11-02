import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PermissionProfile } from "../../src/domain/types";
import {
  createAgyRig,
  removeAgyRigDirs,
  replyTurn,
  startAgyHandle,
  type AgyRig,
} from "../fakes/fakeAgy";

const CONV = "conv-1";
const CONFIG_SEGMENT = "config";
const WRAPPER_FILES = ["codeweave-agy-hook.sh", "codeweave-agy-hook.cmd"];
const HOOKS_FILE = "hooks.json";
const HOOK_TIMEOUT_SECONDS = 10;
const LAUNCHER =
  'delete process.env.ELECTRON_RUN_AS_NODE;import(require("node:url").pathToFileURL(process.argv[1]).href)';

afterEach(async () => {
  await removeAgyRigDirs();
});

function agySpawnAt(
  rig: AgyRig,
  index: number,
): ReturnType<typeof rig.container.agySpawns>[number] {
  const spawn = rig.container.agySpawns()[index];
  if (spawn === undefined) {
    throw new Error(`agy spawn ${String(index)} does not exist`);
  }
  return spawn;
}

describe("agy adapter hook configuration", () => {
  it("hooks_json_with_an_inline_command_exists_before_the_agy_process_spawns", async () => {
    const rig = await createAgyRig();
    await startAgyHandle(rig);
    const spawn = agySpawnAt(rig, 0);

    expect(rig.hookWrites).toEqual([
      { configDir: rig.configDir, spawnsBefore: 0 },
    ]);
    expect(spawn.configFilesAtSpawn).toEqual([HOOKS_FILE]);
    expect(JSON.parse(spawn.hooksJsonAtSpawn ?? "null")).toEqual({
      codeweave: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: `ELECTRON_RUN_AS_NODE=1 exec '/opt/Codeweave/codeweave' -e '${LAUNCHER}' '/opt/Codeweave/resources/app.asar.unpacked/out/main/agyHook.js'`,
                timeout: HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        ],
      },
    });
  });

  it("stale_hook_files_are_rewritten_before_every_spawn", async () => {
    const rig = await createAgyRig();
    const configPath = join(rig.configDir, CONFIG_SEGMENT);
    await mkdir(configPath, { recursive: true });
    await writeFile(join(configPath, HOOKS_FILE), '{"stale":true}');
    const { handle } = await startAgyHandle(rig);
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    await handle.setProfile(PermissionProfile.plan);
    await writeFile(join(configPath, HOOKS_FILE), '{"stale":"again"}');
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two");

    expect(agySpawnAt(rig, 0).hooksJsonAtSpawn).toContain('"PreToolUse"');
    expect(agySpawnAt(rig, 1).hooksJsonAtSpawn).toContain('"PreToolUse"');
    expect(rig.hookWrites.map((write) => write.spawnsBefore)).toEqual([0, 1]);
  });
});

describe("agy adapter hook tampering", () => {
  it("wrapper_tampering_cannot_disable_gate_next_spawn_restores_the_config", async () => {
    const rig = await createAgyRig();
    const configPath = join(rig.configDir, CONFIG_SEGMENT);
    const { handle } = await startAgyHandle(rig);
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    const original = await readFile(join(configPath, HOOKS_FILE), "utf8");
    await writeFile(join(configPath, HOOKS_FILE), "{}");
    await Promise.all(
      WRAPPER_FILES.map((file) => writeFile(join(configPath, file), "")),
    );
    await handle.setProfile(PermissionProfile.plan);
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two");

    expect(agySpawnAt(rig, 1).hooksJsonAtSpawn).toBe(original);
    expect(agySpawnAt(rig, 1).configFilesAtSpawn).toEqual([HOOKS_FILE]);
  });

  it("wrapper_tampering_cannot_disable_gate_a_deleted_config_dir_is_recreated", async () => {
    const rig = await createAgyRig();
    const { handle } = await startAgyHandle(rig);
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    await rm(join(rig.configDir, CONFIG_SEGMENT), {
      recursive: true,
      force: true,
    });
    await handle.setProfile(PermissionProfile.plan);
    rig.container.scriptTurn(replyTurn(CONV, "two"));

    await handle.prompt("two");

    expect(agySpawnAt(rig, 1).configFilesAtSpawn).toEqual([HOOKS_FILE]);
  });
});

describe("agy adapter hook environment", () => {
  it("agy_env_carries_the_profile_and_the_worktree_root", async () => {
    const rig = await createAgyRig();
    const { handle } = await startAgyHandle(rig, PermissionProfile.unattended);
    rig.container.scriptTurn(replyTurn(CONV, "one"));
    await handle.prompt("one");
    await handle.setProfile(PermissionProfile.plan);
    rig.container.scriptTurn(replyTurn(CONV, "two"));
    await handle.prompt("two");

    expect(agySpawnAt(rig, 0).spec.env).toMatchObject({
      CODEWEAVE_AGY_PROFILE: "unattended",
      CODEWEAVE_AGY_WORKTREE: rig.cwd,
    });
    expect(agySpawnAt(rig, 1).spec.env).toMatchObject({
      CODEWEAVE_AGY_PROFILE: "plan",
      CODEWEAVE_AGY_WORKTREE: rig.cwd,
    });
  });
});
