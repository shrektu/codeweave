import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { createFileExclusively, replaceFileAtomically } from "./atomicFile";

const faults = vi.hoisted(() => ({
  linkCode: undefined as string | undefined,
  renameFails: false,
  linkCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (existing: string, target: string): Promise<void> => {
      faults.linkCalls += 1;
      if (faults.linkCode === undefined) {
        return actual.link(existing, target);
      }
      return Promise.reject(
        Object.assign(new Error(`link failed: ${faults.linkCode}`), {
          code: faults.linkCode,
        }),
      );
    },
    rename: (from: string, to: string): Promise<void> => {
      if (faults.renameFails) {
        return Promise.reject(new Error("rename exploded"));
      }
      return actual.rename(from, to);
    },
  };
});

const UNSUPPORTED_CODES = ["EPERM", "ENOTSUP", "EXDEV", "EISDIR"] as const;

afterEach(() => {
  faults.linkCode = undefined;
  faults.renameFails = false;
  faults.linkCalls = 0;
});

describe("createFileExclusively", () => {
  it("create_file_exclusively_uses_link_when_supported", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "coder.md");

    await createFileExclusively(target, "text");

    expect(faults.linkCalls).toBe(1);
    expect(await readFile(target, "utf8")).toBe("text");
    expect(await readdir(dir)).toEqual(["coder.md"]);
  });

  it.each(UNSUPPORTED_CODES)(
    "create_file_exclusively_falls_back_on_%s",
    async (code) => {
      const dir = await makeTempDir();
      const target = join(dir, "coder.md");
      faults.linkCode = code;

      await createFileExclusively(target, "text");

      expect(await readFile(target, "utf8")).toBe("text");
      expect(await readdir(dir)).toEqual(["coder.md"]);
    },
  );

  it("create_file_exclusively_fallback_refuses_existing_target", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "coder.md");
    await writeFile(target, "original");
    faults.linkCode = "EPERM";

    await expect(createFileExclusively(target, "text")).rejects.toThrow(
      "EEXIST",
    );

    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(dir)).toEqual(["coder.md"]);
  });

  it("create_file_exclusively_removes_reservation_when_rename_fails", async () => {
    const dir = await makeTempDir();
    faults.linkCode = "EXDEV";
    faults.renameFails = true;

    await expect(
      createFileExclusively(join(dir, "coder.md"), "text"),
    ).rejects.toThrow("rename exploded");

    expect(await readdir(dir)).toEqual([]);
  });

  it("create_file_exclusively_propagates_other_link_errors", async () => {
    const dir = await makeTempDir();
    faults.linkCode = "EACCES";

    await expect(
      createFileExclusively(join(dir, "coder.md"), "text"),
    ).rejects.toThrow("link failed: EACCES");

    expect(await readdir(dir)).toEqual([]);
  });
});

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
