import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintAgentsDir,
  WorkspaceWalkLimitError,
  type GuardLimits,
} from "./workspaceGuard";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function newWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-guard-"));
  dirs.push(dir);
  return dir;
}

async function plant(
  worktree: string,
  relative: string,
  content: string,
): Promise<void> {
  const file = join(worktree, ".agents", relative);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

describe("fingerprintAgentsDir", () => {
  it("a_missing_dir_and_an_empty_dir_have_the_same_fingerprint", async () => {
    const missing = await newWorktree();
    const empty = await newWorktree();
    await mkdir(join(empty, ".agents"));

    expect(await fingerprintAgentsDir(missing)).toBe(
      await fingerprintAgentsDir(empty),
    );
  });

  it("planted_workspace_hook_blocks_respawn_new_file_changes_it", async () => {
    const worktree = await newWorktree();
    const before = await fingerprintAgentsDir(worktree);

    await plant(worktree, "hooks.json", "{}");

    expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
  });

  it("planted_workspace_hook_blocks_respawn_edited_content_changes_it", async () => {
    const worktree = await newWorktree();
    await plant(worktree, "hooks.json", "{}");
    const before = await fingerprintAgentsDir(worktree);

    await plant(worktree, "hooks.json", '{"a":1}');

    expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
  });

  it("planted_workspace_hook_blocks_respawn_nested_file_changes_it", async () => {
    const worktree = await newWorktree();
    await plant(worktree, "plugins/a/plugin.json", "1");
    const before = await fingerprintAgentsDir(worktree);

    await plant(worktree, "plugins/a/plugin.json", "2");

    expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
  });

  it("planted_workspace_hook_blocks_respawn_an_empty_subdir_changes_it", async () => {
    const worktree = await newWorktree();
    await mkdir(join(worktree, ".agents"));
    const before = await fingerprintAgentsDir(worktree);

    await mkdir(join(worktree, ".agents", "plugins"));

    expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "planted_workspace_hook_blocks_respawn_a_symlink_target_changes_it",
    async () => {
      const worktree = await newWorktree();
      await mkdir(join(worktree, ".agents"));
      await symlink("/a", join(worktree, ".agents", "link"));
      const before = await fingerprintAgentsDir(worktree);
      await rm(join(worktree, ".agents", "link"));
      await symlink("/b", join(worktree, ".agents", "link"));

      expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
    },
  );
});

describe("fingerprintAgentsDir stability", () => {
  it("unchanged_workspace_config_respawns_same_fingerprint", async () => {
    const worktree = await newWorktree();
    await plant(worktree, "hooks.json", "{}");
    await plant(worktree, "plugins/p.json", "x");

    expect(await fingerprintAgentsDir(worktree)).toBe(
      await fingerprintAgentsDir(worktree),
    );
  });

  it("teamwork_change_does_not_block_respawn_files_below_teamwork", async () => {
    const worktree = await newWorktree();
    await plant(worktree, "hooks.json", "{}");
    const before = await fingerprintAgentsDir(worktree);

    await plant(worktree, "teamwork/t1/state.json", "1");
    await plant(worktree, "teamwork/t1/state.json", "2");

    expect(await fingerprintAgentsDir(worktree)).toBe(before);
  });

  it("teamwork_change_does_not_block_respawn_only_the_top_level_one", async () => {
    const worktree = await newWorktree();
    const before = await fingerprintAgentsDir(worktree);

    await plant(worktree, "plugins/teamwork/x.json", "1");

    expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
  });
});

describe("fingerprintAgentsDir symlinks", () => {
  it.skipIf(process.platform === "win32")(
    "symlinked_agents_target_change_blocks_respawn_linked_dir_content",
    async () => {
      const worktree = await newWorktree();
      await mkdir(join(worktree, ".agents"));
      await mkdir(join(worktree, "shared"));
      await writeFile(join(worktree, "shared", "plugin.js"), "1");
      await symlink("../shared", join(worktree, ".agents", "plugins"));
      const before = await fingerprintAgentsDir(worktree);

      await writeFile(join(worktree, "shared", "plugin.js"), "2");

      expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "symlinked_agents_target_change_blocks_respawn_linked_file_content",
    async () => {
      const worktree = await newWorktree();
      await mkdir(join(worktree, ".agents"));
      await writeFile(join(worktree, "real.json"), "1");
      await symlink("../real.json", join(worktree, ".agents", "hooks.json"));
      const before = await fingerprintAgentsDir(worktree);

      await writeFile(join(worktree, "real.json"), "2");

      expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "symlinked_agents_target_change_blocks_respawn_agents_dir_is_a_link",
    async () => {
      const worktree = await newWorktree();
      await mkdir(join(worktree, "cfg"));
      await writeFile(join(worktree, "cfg", "hooks.json"), "1");
      await symlink("cfg", join(worktree, ".agents"));
      const before = await fingerprintAgentsDir(worktree);

      await writeFile(join(worktree, "cfg", "hooks.json"), "2");

      expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
    },
  );
});

const CHAIN_DEPTH = 30;
const FAST_WALK_MS = 1000;
const SMALL_LIMITS: GuardLimits = {
  maxEntries: 50,
  maxBytes: 1_000_000,
  maxDepth: 8,
};

function chainNode(level: number): string {
  return `d${String(level)}`;
}

async function plantChain(worktree: string, depth: number): Promise<void> {
  const chain = join(worktree, "chain");
  await mkdir(chain);
  await mkdir(join(worktree, ".agents"));
  await symlink("../chain/d0", join(worktree, ".agents", "skills"));
  for (let level = 0; level <= depth; level += 1) {
    const dir = join(chain, chainNode(level));
    await mkdir(dir);
    if (level < depth) {
      await symlink(`../${chainNode(level + 1)}`, join(dir, "a"));
      await symlink(`../${chainNode(level + 1)}`, join(dir, "b"));
    }
  }
  await writeFile(join(chain, chainNode(depth), "leaf.json"), "1");
}

describe("fingerprintAgentsDir bounds", () => {
  it.skipIf(process.platform === "win32")(
    "fingerprint_walk_is_bounded_shared_node_chain_finishes_fast",
    async () => {
      const worktree = await newWorktree();
      await plantChain(worktree, CHAIN_DEPTH);
      const started = performance.now();

      await fingerprintAgentsDir(worktree);

      expect(performance.now() - started).toBeLessThan(FAST_WALK_MS);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fingerprint_walk_is_bounded_shared_node_leaf_change_is_detected",
    async () => {
      const worktree = await newWorktree();
      await plantChain(worktree, CHAIN_DEPTH);
      const before = await fingerprintAgentsDir(worktree);

      await writeFile(
        join(worktree, "chain", chainNode(CHAIN_DEPTH), "leaf.json"),
        "2",
      );

      expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
    },
  );

  it("fingerprint_walk_is_bounded_too_many_entries_throws", async () => {
    const worktree = await newWorktree();
    for (let index = 0; index <= SMALL_LIMITS.maxEntries; index += 1) {
      await plant(worktree, `f${String(index)}.json`, "1");
    }

    await expect(
      fingerprintAgentsDir(worktree, SMALL_LIMITS),
    ).rejects.toBeInstanceOf(WorkspaceWalkLimitError);
  });

  it("fingerprint_walk_is_bounded_too_many_bytes_throws", async () => {
    const worktree = await newWorktree();
    await plant(worktree, "big.bin", "x".repeat(SMALL_LIMITS.maxBytes + 1));

    await expect(
      fingerprintAgentsDir(worktree, SMALL_LIMITS),
    ).rejects.toBeInstanceOf(WorkspaceWalkLimitError);
  });

  it("fingerprint_walk_is_bounded_too_deep_throws", async () => {
    const worktree = await newWorktree();
    const deep = Array.from({ length: SMALL_LIMITS.maxDepth + 1 }, () => "d");
    await plant(worktree, join(...deep, "f.json"), "1");

    await expect(
      fingerprintAgentsDir(worktree, SMALL_LIMITS),
    ).rejects.toBeInstanceOf(WorkspaceWalkLimitError);
  });

  it("fingerprint_walk_is_bounded_within_limits_does_not_throw", async () => {
    const worktree = await newWorktree();
    await plant(worktree, "a/b/c.json", "1");

    await expect(fingerprintAgentsDir(worktree, SMALL_LIMITS)).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("fingerprintAgentsDir symlink edge cases", () => {
  it.skipIf(process.platform === "win32")(
    "symlinked_agents_target_change_blocks_respawn_cycles_terminate",
    async () => {
      const worktree = await newWorktree();
      await mkdir(join(worktree, ".agents", "a"), { recursive: true });
      await symlink("..", join(worktree, ".agents", "a", "loop"));
      await writeFile(join(worktree, ".agents", "hooks.json"), "1");
      const before = await fingerprintAgentsDir(worktree);

      await writeFile(join(worktree, ".agents", "hooks.json"), "2");

      expect(await fingerprintAgentsDir(worktree)).not.toBe(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "symlinked_agents_target_change_blocks_respawn_dangling_link_is_its_string",
    async () => {
      const worktree = await newWorktree();
      await mkdir(join(worktree, ".agents"));
      await symlink("/nowhere/a", join(worktree, ".agents", "dead"));
      const first = await fingerprintAgentsDir(worktree);
      await rm(join(worktree, ".agents", "dead"));
      await symlink("/nowhere/b", join(worktree, ".agents", "dead"));

      expect(await fingerprintAgentsDir(worktree)).not.toBe(first);
    },
  );
});
