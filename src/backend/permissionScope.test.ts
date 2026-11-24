import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PermissionContext } from "../domain/pathScope";
import { decidePermission } from "../domain/permissionPolicy";
import { PermissionProfile } from "../domain/types";

import {
  realEditPaths,
  realLocation,
  realPermissionContext,
  withRealPaths,
} from "./permissionScope";

const ALLOW = { action: "allow" };
const ASK = { action: "ask" };
const CAN_LINK = process.platform !== "win32";

let base = "";
let home = "";
let outside = "";

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "codeweave-scope-")));
  home = join(base, "home");
  outside = join(base, "outside");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, "proj"), { recursive: true });
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(!CAN_LINK)("realLocation", () => {
  it("resolves_a_symlink_to_its_target", async () => {
    await symlink(join(home, ".ssh"), join(home, "link"), "dir");

    expect(await realLocation(join(home, "link"))).toBe(join(home, ".ssh"));
  });

  it("keeps_the_missing_tail_below_the_real_ancestor", async () => {
    await symlink(join(home, ".ssh"), join(home, "link"), "dir");

    expect(await realLocation(join(home, "link", "new", "file.txt"))).toBe(
      join(home, ".ssh", "new", "file.txt"),
    );
  });

  it("follows_a_dangling_symlink_to_where_a_write_would_land", async () => {
    await symlink(join(home, ".ssh", "later"), join(home, "dangling"));

    expect(await realLocation(join(home, "dangling"))).toBe(
      join(home, ".ssh", "later"),
    );
  });

  it("returns_a_missing_path_below_an_existing_dir_unchanged", async () => {
    expect(await realLocation(join(home, "proj", "nope", "x"))).toBe(
      join(home, "proj", "nope", "x"),
    );
  });

  it("surfaces_a_symlink_loop_so_the_decision_stays_with_the_user", async () => {
    await symlink(join(home, "b"), join(home, "a"));
    await symlink(join(home, "a"), join(home, "b"));

    await expect(realLocation(join(home, "a"))).rejects.toMatchObject({
      code: "ELOOP",
    });
  });
});

describe.skipIf(!CAN_LINK)("realPermissionContext", () => {
  it("resolves_the_root_the_home_and_adds_real_protected_paths", async () => {
    const alias = join(base, "alias");
    await symlink(home, alias, "dir");

    const context = await realPermissionContext({
      worktreeRoot: alias,
      homeDir: alias,
      protectedPaths: [
        join(alias, ".ssh"),
        join(alias, ".config", "*", "auth*"),
      ],
    });

    expect(context.worktreeRoots).toEqual([alias, home]);
    expect(context.homeDir).toBe(home);
    expect(context.protectedPaths).toEqual([
      join(alias, ".ssh"),
      join(alias, ".config", "*", "auth*"),
      join(home, ".ssh"),
      join(home, ".config", "*", "auth*"),
    ]);
  });
});

describe.skipIf(!CAN_LINK)("withRealPaths", () => {
  it("adds_the_real_locations_to_the_edit_paths", async () => {
    await symlink(join(home, ".ssh"), join(home, "proj", "link"), "dir");
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [],
    });

    const query = await withRealPaths(
      {
        kind: "edit",
        paths: [join(home, "proj", "link", "k"), join(home, "proj", "a.txt")],
      },
      context,
    );

    expect(query).toEqual({
      kind: "edit",
      paths: [
        join(home, "proj", "link", "k"),
        join(home, ".ssh", "k"),
        join(home, "proj", "a.txt"),
      ],
    });
  });

  it("resolves_tilde_and_relative_edit_paths_before_the_lookup", async () => {
    await symlink(outside, join(home, "proj", "out"), "dir");
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [],
    });

    expect(
      await realEditPaths(["~/proj/out/f", "proj/out/g"], context),
    ).toEqual([
      join(home, "proj", "out", "f"),
      join(outside, "f"),
      join(home, "proj", "out", "g"),
      join(outside, "g"),
    ]);
  });
});

describe.skipIf(!CAN_LINK)("withRealPaths for other queries", () => {
  it("keeps_unresolvable_paths_as_given", async () => {
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [],
    });

    expect(await realEditPaths(["~other/x"], context)).toEqual(["~other/x"]);
  });

  it("replaces_an_execute_cwd_with_its_real_location", async () => {
    await symlink(join(home, ".ssh"), join(home, "proj", "link"), "dir");
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [],
    });

    const query = await withRealPaths(
      { kind: "execute", command: "ls", cwd: join(home, "proj", "link") },
      context,
    );

    expect(query).toEqual({
      kind: "execute",
      command: "ls",
      cwd: join(home, ".ssh"),
    });
  });

  it("leaves_other_queries_untouched", async () => {
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [],
    });

    expect(await withRealPaths({ kind: "read" }, context)).toEqual({
      kind: "read",
    });
    expect(
      await withRealPaths({ kind: "execute", command: "ls" }, context),
    ).toEqual({ kind: "execute", command: "ls" });
  });
});

describe.skipIf(!CAN_LINK)("symlinks and the permission policy", () => {
  async function editDecision(path: string): Promise<unknown> {
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [join(home, ".ssh")],
    });
    const query = await withRealPaths({ kind: "edit", paths: [path] }, context);
    return decidePermission(query, PermissionProfile.unattended, context);
  }

  it("symlink-into-protected-edit", async () => {
    await symlink(join(home, ".ssh"), join(home, "proj", "link"), "dir");

    expect(
      await editDecision(join(home, "proj", "link", "authorized_keys")),
    ).toEqual(ASK);
  });

  it("a_symlink_pointing_outside_the_root_asks", async () => {
    await symlink(outside, join(home, "proj", "out"), "dir");

    expect(await editDecision(join(home, "proj", "out", "f.txt"))).toEqual(ASK);
  });

  it("a_symlink_pointing_inside_the_root_is_allowed", async () => {
    await mkdir(join(home, "proj", "real"));
    await symlink(
      join(home, "proj", "real"),
      join(home, "proj", "alias"),
      "dir",
    );

    expect(await editDecision(join(home, "proj", "alias", "f.txt"))).toEqual(
      ALLOW,
    );
  });
});

describe.skipIf(!CAN_LINK)("symlinked roots and cwds", () => {
  it("a_symlinked_root_alias_does_not_make_inside_paths_ask", async () => {
    const alias = join(base, "alias");
    await symlink(home, alias, "dir");
    const context = await realPermissionContext({
      worktreeRoot: alias,
      homeDir: alias,
      protectedPaths: [join(alias, ".ssh")],
    });
    const query = await withRealPaths(
      { kind: "edit", paths: [join(alias, "proj", "a.txt")] },
      context,
    );

    expect(
      decidePermission(query, PermissionProfile.unattended, context),
    ).toEqual(ALLOW);
    const protectedQuery = await withRealPaths(
      { kind: "edit", paths: [join(alias, ".ssh", "k")] },
      context,
    );
    expect(
      decidePermission(protectedQuery, PermissionProfile.unattended, context),
    ).toEqual(ASK);
  });

  it("a_cwd_symlinked_into_a_protected_dir_scopes_mutations", async () => {
    await symlink(join(home, ".ssh"), join(home, "proj", "link"), "dir");
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [join(home, ".ssh")],
    });
    const query = await withRealPaths(
      {
        kind: "execute",
        command: "touch x",
        cwd: join(home, "proj", "link"),
      },
      context,
    );

    expect(
      decidePermission(query, PermissionProfile.unattended, context),
    ).toEqual(ASK);
  });
});

async function folderContext(): Promise<{
  folder: string;
  context: PermissionContext;
}> {
  await mkdir(join(base, "data", "p"), { recursive: true });
  const folder = join(home, "folder");
  await symlink(join(base, "data", "p"), folder, "dir");
  const context = await realPermissionContext({
    worktreeRoot: folder,
    homeDir: home,
    protectedPaths: [join(home, ".ssh")],
  });
  return { folder, context };
}

async function decideRun(
  command: string,
  folder: string,
  context: PermissionContext,
): Promise<unknown> {
  const query = await withRealPaths(
    { kind: "execute", command, cwd: folder },
    context,
  );
  return decidePermission(query, PermissionProfile.unattended, context);
}

describe.skipIf(!CAN_LINK)("symlinked session folders", () => {
  it("symlinked-root-original-spelling-inside", async () => {
    const { folder, context } = await folderContext();

    expect(
      await decideRun(`rm -rf ${join(folder, "build")}`, folder, context),
    ).toEqual(ALLOW);
    expect(
      await decideRun(`echo x > ${join(folder, "f")}`, folder, context),
    ).toEqual(ALLOW);
    expect(await decideRun("touch x", folder, context)).toEqual(ALLOW);
    expect(
      await decideRun(
        `rm -rf ${join(base, "data", "p", "build")}`,
        folder,
        context,
      ),
    ).toEqual(ALLOW);
    expect(await decideRun(`rm -rf ${outside}/x`, folder, context)).toEqual({
      action: "deny",
      reason: "recursive or forced delete outside the worktree is blocked",
    });
  });

  it("symlinked-root-edit-paths-keep-both-spellings", async () => {
    const { folder, context } = await folderContext();

    const query = await withRealPaths(
      { kind: "edit", paths: [join(folder, "a.txt")] },
      context,
    );

    expect(query).toEqual({
      kind: "edit",
      paths: [join(folder, "a.txt"), join(base, "data", "p", "a.txt")],
    });
    expect(
      decidePermission(query, PermissionProfile.unattended, context),
    ).toEqual(ALLOW);
  });
});

describe.skipIf(!CAN_LINK)("the spellings of a root", () => {
  it("the_context_lists_the_given_root_first_then_its_real_path", async () => {
    const { folder, context } = await folderContext();

    expect(context.worktreeRoots).toEqual([folder, join(base, "data", "p")]);
  });

  it("a_root_without_a_symlink_has_a_single_spelling", async () => {
    const context = await realPermissionContext({
      worktreeRoot: home,
      homeDir: home,
      protectedPaths: [],
    });

    expect(context.worktreeRoots).toEqual([home]);
  });
});

describe.skipIf(!CAN_LINK)("symlinked protected files", () => {
  it("glob-protected-symlinked-edit-asks", async () => {
    await mkdir(join(home, ".config", "app"), { recursive: true });
    await writeFile(join(home, "proj", "plain.txt"), "x");
    await symlink(
      join(home, "proj", "plain.txt"),
      join(home, ".config", "app", "auth.json"),
    );
    const context = await realPermissionContext({
      worktreeRoot: join(home, "proj"),
      homeDir: home,
      protectedPaths: [join(home, ".config", "*", "auth*")],
    });

    const query = await withRealPaths(
      {
        kind: "edit",
        paths: [join(home, ".config", "app", "auth.json")],
      },
      context,
    );

    expect(
      decidePermission(query, PermissionProfile.unattended, context),
    ).toEqual(ASK);
  });
});
