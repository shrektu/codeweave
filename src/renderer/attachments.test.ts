import { expect, it } from "vitest";

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PER_PROMPT,
  ImageMimeType,
} from "../domain/attachments";
import type { AttachmentView } from "../shared/views";

import {
  canSendAttachments,
  createThumbnailCache,
  isImageMimeType,
  toBase64,
  validateImageFile,
} from "./attachments";

const PNG_FILE = {
  name: "pixel.png",
  type: ImageMimeType.png,
  size: 64,
};

const VIEW: AttachmentView = {
  id: "a".repeat(64),
  name: "pixel.png",
  mimeType: ImageMimeType.png,
  bytes: 64,
};

const LARGE_BYTES = 200 * 1024;

it("validate_accepts_an_image_at_the_size_limit", () => {
  expect(validateImageFile({ ...PNG_FILE, size: IMAGE_MAX_BYTES }, 0)).toEqual({
    ok: true,
    mimeType: ImageMimeType.png,
  });
});

it("validate_rejects_one_byte_over_the_size_limit", () => {
  expect(
    validateImageFile({ ...PNG_FILE, size: IMAGE_MAX_BYTES + 1 }, 0),
  ).toEqual({ ok: false, kind: "tooLarge" });
});

it("validate_accepts_the_ninth_image_and_rejects_the_eleventh", () => {
  const lastAllowed = IMAGE_MAX_PER_PROMPT - 1;
  expect(validateImageFile(PNG_FILE, lastAllowed)).toEqual({
    ok: true,
    mimeType: ImageMimeType.png,
  });
  expect(validateImageFile(PNG_FILE, IMAGE_MAX_PER_PROMPT)).toEqual({
    ok: false,
    kind: "tooMany",
  });
});

it("validate_normalizes_the_mime_case", () => {
  expect(validateImageFile({ ...PNG_FILE, type: "IMAGE/PNG" }, 0)).toEqual({
    ok: true,
    mimeType: ImageMimeType.png,
  });
});

it("validate_rejects_an_unknown_mime_type", () => {
  expect(validateImageFile({ ...PNG_FILE, type: "image/svg+xml" }, 0)).toEqual({
    ok: false,
    kind: "wrongType",
  });
  expect(validateImageFile({ ...PNG_FILE, type: "" }, 0)).toEqual({
    ok: false,
    kind: "wrongType",
  });
});

it("is_image_mime_type_ignores_case", () => {
  expect(isImageMimeType("IMAGE/WEBP")).toBe(true);
  expect(isImageMimeType("text/plain")).toBe(false);
});

it("to_base64_matches_buffer_for_a_large_payload", () => {
  const bytes = new Uint8Array(LARGE_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 256;
  }
  expect(toBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
});

it("to_base64_handles_an_empty_payload", () => {
  expect(toBase64(new ArrayBuffer(0))).toBe("");
});

it("can_send_attachments_requires_image_input", () => {
  expect(canSendAttachments([], false)).toBe(true);
  expect(canSendAttachments([VIEW], true)).toBe(true);
  expect(canSendAttachments([VIEW], false)).toBe(false);
});

it("thumbnail_cache_evicts_by_size", () => {
  const cache = createThumbnailCache(10, 50);
  cache.set("a", "aaaa");
  cache.set("b", "bbbb");
  cache.set("c", "cccc");

  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBe("bbbb");

  cache.set("d", "dddd");

  expect(cache.get("c")).toBeUndefined();
  expect(cache.get("b")).toBe("bbbb");
  expect(cache.get("d")).toBe("dddd");

  cache.set("big", "x".repeat(11));

  expect(cache.get("big")).toBeUndefined();
});
