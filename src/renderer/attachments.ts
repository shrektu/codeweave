import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PER_PROMPT,
  IMAGE_MIME_TYPES,
  type ImageMimeType,
} from "../domain/attachments";
import type { AttachmentView } from "../shared/views";

export interface ImageFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export type ImageErrorKind = "tooLarge" | "wrongType" | "tooMany";

export type ImageCheck =
  | { readonly ok: true; readonly mimeType: ImageMimeType }
  | { readonly ok: false; readonly kind: ImageErrorKind };

const BASE64_CHUNK_BYTES = 0x8000;

function mimeTypeOf(value: string): ImageMimeType | null {
  const normalized = value.toLowerCase();
  return IMAGE_MIME_TYPES.find((mimeType) => mimeType === normalized) ?? null;
}

export function isImageMimeType(value: string): value is ImageMimeType {
  return mimeTypeOf(value) !== null;
}

export function validateImageFile(file: ImageFile, count: number): ImageCheck {
  const mimeType = mimeTypeOf(file.type);
  if (mimeType === null) {
    return { ok: false, kind: "wrongType" };
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return { ok: false, kind: "tooLarge" };
  }
  if (count >= IMAGE_MAX_PER_PROMPT) {
    return { ok: false, kind: "tooMany" };
  }
  return { ok: true, mimeType };
}

export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const chunks: string[] = [];
  for (let offset = 0; offset < view.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = view.subarray(offset, offset + BASE64_CHUNK_BYTES);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

export function canSendAttachments(
  attachments: readonly AttachmentView[],
  imageInput: boolean,
): boolean {
  return attachments.length === 0 || imageInput;
}

export const THUMBNAIL_CACHE_MAX_CHARS = 32 * 1024 * 1024;

export const THUMBNAIL_CACHE_MAX_ENTRIES = 50;

export interface ThumbnailCache {
  get(key: string): string | null | undefined;
  set(key: string, src: string | null): void;
}

function charCountOf(src: string | null): number {
  return src === null ? 0 : src.length;
}

export function createThumbnailCache(
  maxChars: number,
  maxEntries: number,
): ThumbnailCache {
  const entries = new Map<string, string | null>();
  let totalChars = 0;

  const drop = (key: string): void => {
    totalChars -= charCountOf(entries.get(key) ?? null);
    entries.delete(key);
  };

  return {
    get: (key) => {
      if (!entries.has(key)) {
        return undefined;
      }
      const value = entries.get(key) ?? null;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set: (key, src) => {
      if (entries.has(key)) {
        drop(key);
      }
      if (charCountOf(src) > maxChars) {
        return;
      }
      entries.set(key, src);
      totalChars += charCountOf(src);
      while (totalChars > maxChars || entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) {
          break;
        }
        drop(oldest.value);
      }
    },
  };
}

export const thumbnailCache = createThumbnailCache(
  THUMBNAIL_CACHE_MAX_CHARS,
  THUMBNAIL_CACHE_MAX_ENTRIES,
);
