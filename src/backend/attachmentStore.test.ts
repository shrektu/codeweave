import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createAttachmentStore, type AttachmentFs } from "./attachmentStore";
import { IMAGE_MAX_BYTES, ImageMimeType } from "../domain/attachments";
import { IpcErrorCode } from "../shared/protocol";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const OTHER_PNG_BYTES = Buffer.concat([
  PNG_BYTES,
  Buffer.from([0x00, 0x01, 0x02, 0x03]),
]);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const tempDirs: string[] = [];

function idOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function renameError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

function storeWithFs(
  dir: string,
  fs: AttachmentFs,
): ReturnType<typeof createAttachmentStore> {
  return createAttachmentStore({ dir, fs });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function storeOn(): Promise<{
  dir: string;
  store: ReturnType<typeof createAttachmentStore>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-attachments-"));
  tempDirs.push(dir);
  return { dir, store: createAttachmentStore({ dir }) };
}

it("rejects_a_png_declared_as_jpeg", async () => {
  const { store } = await storeOn();

  await expect(
    store.stage({
      name: "photo.jpg",
      mimeType: ImageMimeType.jpeg,
      dataBase64: PNG_BYTES.toString("base64"),
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: "Attachment type does not match its data",
  });
});

it("rejects_oversize_images", async () => {
  const { store } = await storeOn();
  const oversize = Buffer.concat([PNG_BYTES, Buffer.alloc(IMAGE_MAX_BYTES)]);

  await expect(
    store.stage({
      name: "big.png",
      mimeType: ImageMimeType.png,
      dataBase64: oversize.toString("base64"),
    }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: "Attachment is too large",
  });
});

it("rejects_invalid_base64", async () => {
  const { store } = await storeOn();

  await expect(
    store.stage({
      name: "bad.png",
      mimeType: ImageMimeType.png,
      dataBase64: "abc",
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
  await expect(
    store.stage({
      name: "bad.png",
      mimeType: ImageMimeType.png,
      dataBase64: "aGVsbG8=",
    }),
  ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
});

it("stage_is_idempotent_for_the_same_bytes", async () => {
  const { dir, store } = await storeOn();
  const input = {
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  };

  const first = await store.stage(input);
  const second = await store.stage(input);

  expect(second).toEqual(first);
  expect(await readdir(join(dir, "staging"))).toEqual([`${first.id}.png`]);
});

it("claim_rejects_an_invalid_session_id", async () => {
  const { store } = await storeOn();
  const staged = await store.stage({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });

  await expect(store.claim("not-a-uuid", staged)).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: "Invalid session id",
  });
});

it("read_prefers_the_session_copy", async () => {
  const { dir, store } = await storeOn();
  const staged = await store.stage({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });
  const claimed = await store.claim(SESSION_ID, staged);
  expect(claimed).toBe(join(dir, SESSION_ID, `${staged.id}.png`));
  await writeFile(claimed, OTHER_PNG_BYTES);

  expect(await store.read(SESSION_ID, staged.id)).toEqual({
    mimeType: ImageMimeType.png,
    dataBase64: OTHER_PNG_BYTES.toString("base64"),
  });
  expect(await store.read(undefined, staged.id)).toEqual({
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });
  expect(await readFile(claimed)).toEqual(OTHER_PNG_BYTES);
});

it("concurrent_stages_of_the_same_image_all_succeed", async () => {
  const { dir, store } = await storeOn();
  const input = {
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  };

  const staged = await Promise.all([
    store.stage(input),
    store.stage(input),
    store.stage(input),
  ]);

  expect(staged.map((view) => view.id)).toEqual([
    idOf(PNG_BYTES),
    idOf(PNG_BYTES),
    idOf(PNG_BYTES),
  ]);
  expect(await readdir(join(dir, "staging"))).toEqual([
    `${idOf(PNG_BYTES)}.png`,
  ]);
});

it("claim_replaces_a_truncated_session_file", async () => {
  const { dir, store } = await storeOn();
  const staged = await store.stage({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });
  const sessionDir = join(dir, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, `${staged.id}.png`);
  await writeFile(sessionFile, PNG_BYTES.subarray(0, 4));

  const claimed = await store.claim(SESSION_ID, staged);

  expect(claimed).toBe(sessionFile);
  expect(await readFile(claimed)).toEqual(PNG_BYTES);
  expect(await store.read(SESSION_ID, staged.id)).toEqual({
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });
});

it("stage_rename_collision_with_identical_target_succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-attachments-"));
  tempDirs.push(dir);
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      if (to.endsWith(".png")) {
        await writeFile(to, await readFile(from));
        throw renameError("EPERM");
      }
      await rename(from, to);
    },
  };
  const store = storeWithFs(dir, fs);

  const staged = await store.stage({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });

  expect(await readFile(join(dir, "staging", `${staged.id}.png`))).toEqual(
    PNG_BYTES,
  );
  expect(await readdir(join(dir, "staging"))).toEqual([`${staged.id}.png`]);
});

it("claim_rename_collision_with_identical_target_succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-attachments-"));
  tempDirs.push(dir);
  let sessionTarget = "";
  let armed = false;
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      if (armed && to === sessionTarget) {
        await writeFile(to, await readFile(from));
        throw renameError("EPERM");
      }
      await rename(from, to);
    },
  };
  const store = storeWithFs(dir, fs);
  const staged = await store.stage({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });
  sessionTarget = join(dir, SESSION_ID, `${staged.id}.png`);
  armed = true;

  const claimed = await store.claim(SESSION_ID, staged);

  expect(claimed).toBe(sessionTarget);
  expect(await readFile(claimed)).toEqual(PNG_BYTES);
  expect(await readdir(join(dir, SESSION_ID))).toEqual([`${staged.id}.png`]);
});

it("rename_collision_with_different_target_rethrows_and_cleans_temp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-attachments-"));
  tempDirs.push(dir);
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      if (to.includes(SESSION_ID)) {
        throw renameError("EPERM");
      }
      await rename(from, to);
    },
  };
  const store = storeWithFs(dir, fs);
  const staged = await store.stage({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  });
  const sessionDir = join(dir, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const target = join(sessionDir, `${staged.id}.png`);
  await writeFile(target, OTHER_PNG_BYTES);

  await expect(store.claim(SESSION_ID, staged)).rejects.toMatchObject({
    code: "EPERM",
  });
  expect(await readdir(sessionDir)).toEqual([`${staged.id}.png`]);
  expect(await readFile(target)).toEqual(OTHER_PNG_BYTES);
});

it("concurrent_stages_of_the_same_image_write_once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-attachments-"));
  tempDirs.push(dir);
  let renames = 0;
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      renames += 1;
      await rename(from, to);
    },
  };
  const store = storeWithFs(dir, fs);
  const input = {
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BYTES.toString("base64"),
  };

  await Promise.all([
    store.stage(input),
    store.stage(input),
    store.stage(input),
  ]);

  expect(renames).toBe(1);
});
