import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { replaceFileAtomically } from "./atomicFile";

it.skipIf(process.platform === "win32")(
  "replace_file_atomically_preserves_file_mode",
  async () => {
    const dir = await makeTempDir();
    const target = join(dir, "flow.md");
    await writeFile(target, "old");
    await chmod(target, 0o600);

    await replaceFileAtomically(target, "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  },
);

it("replace_file_atomically_leaves_no_temp_file", async () => {
  const dir = await makeTempDir();
  const target = join(dir, "flow.md");
  await writeFile(target, "old");

  await replaceFileAtomically(target, "new");

  expect(await readdir(dir)).toEqual(["flow.md"]);
});

it("replace_file_atomically_rejects_missing_target_without_writing", async () => {
  const dir = await makeTempDir();

  await expect(
    replaceFileAtomically(join(dir, "gone.md"), "new"),
  ).rejects.toThrow("ENOENT");

  expect(await readdir(dir)).toEqual([]);
});
