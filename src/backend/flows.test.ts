import type { Dirent, PathLike, Stats } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { listFlows } from "./flows";

const NOT_A_DIRECTORY_CODE = "ENOTDIR";
const MISSING_CODE = "ENOENT";
const DENIED_CODE = "EACCES";
const LOCKED_NAME = "locked-library";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdirLikeWindows = async (
    path: PathLike,
    options: { readonly withFileTypes: true },
  ): Promise<Dirent[]> => {
    try {
      return await actual.readdir(path, options);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === NOT_A_DIRECTORY_CODE
      ) {
        throw Object.assign(new Error(error.message), { code: MISSING_CODE });
      }
      throw error;
    }
  };
  const statDenyingLocked = async (path: PathLike): Promise<Stats> => {
    if (String(path).endsWith(LOCKED_NAME)) {
      throw Object.assign(new Error("permission denied"), {
        code: DENIED_CODE,
      });
    }
    return actual.stat(path);
  };
  return { ...actual, readdir: readdirLikeWindows, stat: statDenyingLocked };
});

it("library_file_is_reported_when_readdir_says_missing_like_windows", async () => {
  const project = await makeTempDir();
  const library = join(await makeTempDir(), "notes.md");
  await writeFile(library, "not a folder");

  const result = await listFlows({ project, library });

  expect(result.errors.map(({ file, source }) => ({ file, source }))).toEqual([
    { file: "flows", source: "library" },
    { file: "agents", source: "library" },
  ]);
});

it("library_root_that_cannot_be_checked_is_reported_not_thrown", async () => {
  const project = await makeTempDir();
  const library = join(await makeTempDir(), LOCKED_NAME);

  await expect(listFlows({ project, library })).resolves.toMatchObject({
    errors: [
      { file: "flows", source: "library" },
      { file: "agents", source: "library" },
    ],
  });
});
