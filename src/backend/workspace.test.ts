import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import { resolveSessionFolder } from "./workspace";

const NO_DEFAULT = { defaultWorkspace: null } as const;

async function failureOf(call: () => Promise<unknown>): Promise<IpcError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof IpcError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
}

it("requested_folder_wins_and_is_not_checked", async () => {
  const home = await makeTempDir();
  const missing = join(home, "not-created");

  expect(
    await resolveSessionFolder(missing, { defaultWorkspace: home }, home),
  ).toBe(missing);
});

it("default_workspace_wins_over_home", async () => {
  const home = await makeTempDir();
  const workspace = await makeTempDir();

  expect(
    await resolveSessionFolder(
      undefined,
      { defaultWorkspace: workspace },
      home,
    ),
  ).toBe(workspace);
});

it("home_is_used_when_no_default_is_set", async () => {
  const home = await makeTempDir();

  expect(await resolveSessionFolder(undefined, NO_DEFAULT, home)).toBe(home);
});

it("missing_home_fails_validation_naming_the_path", async () => {
  const home = join(await makeTempDir(), "gone");

  const error = await failureOf(() =>
    resolveSessionFolder(undefined, NO_DEFAULT, home),
  );

  expect(error.code).toBe(IpcErrorCode.VALIDATION);
  expect(error.message).toBe(`Default workspace does not exist: ${home}`);
});

it("a_file_is_not_a_workspace", async () => {
  const dir = await makeTempDir();
  const file = join(dir, "notes.txt");
  await writeFile(file, "x");

  const error = await failureOf(() =>
    resolveSessionFolder(undefined, { defaultWorkspace: file }, dir),
  );

  expect(error.code).toBe(IpcErrorCode.VALIDATION);
});

it("a_dangling_symlink_is_not_a_workspace", async () => {
  const dir = await makeTempDir();
  const link = join(dir, "link");
  await symlink(join(dir, "nowhere"), link);

  const error = await failureOf(() =>
    resolveSessionFolder(undefined, { defaultWorkspace: link }, dir),
  );

  expect(error.code).toBe(IpcErrorCode.VALIDATION);
});

it("a_symlink_to_a_directory_is_kept_as_given", async () => {
  const dir = await makeTempDir();
  const target = join(dir, "real");
  const link = join(dir, "link");
  await mkdir(target);
  await symlink(target, link, "dir");

  expect(
    await resolveSessionFolder(undefined, { defaultWorkspace: link }, dir),
  ).toBe(link);
});

const CAN_BLOCK_STAT = process.platform !== "win32" && process.getuid?.() !== 0;
const NO_ACCESS_MODE = 0o000;
const FULL_ACCESS_MODE = 0o755;

let lockedDir: string | null = null;

afterEach(async () => {
  if (lockedDir !== null) {
    await chmod(lockedDir, FULL_ACCESS_MODE);
    lockedDir = null;
  }
});

it.skipIf(!CAN_BLOCK_STAT)(
  "default_workspace_inaccessible_is_validation",
  async () => {
    const dir = await makeTempDir();
    const inside = join(dir, "work");
    await mkdir(inside);
    await chmod(dir, NO_ACCESS_MODE);
    lockedDir = dir;

    const error = await failureOf(() =>
      resolveSessionFolder(undefined, { defaultWorkspace: inside }, dir),
    );

    expect(error.code).toBe(IpcErrorCode.VALIDATION);
    expect(error.message).toBe(
      `Default workspace is not accessible: ${inside}`,
    );
  },
);
