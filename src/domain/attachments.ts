import { ProviderId } from "./types";

export const ImageMimeType = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;
export type ImageMimeType = (typeof ImageMimeType)[keyof typeof ImageMimeType];

export const IMAGE_EXTENSIONS: Readonly<Record<ImageMimeType, string>> = {
  [ImageMimeType.png]: "png",
  [ImageMimeType.jpeg]: "jpg",
  [ImageMimeType.gif]: "gif",
  [ImageMimeType.webp]: "webp",
};

export const IMAGE_MIME_TYPES: readonly ImageMimeType[] =
  Object.values(ImageMimeType);

export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, ImageMimeType>> =
  {
    png: ImageMimeType.png,
    jpg: ImageMimeType.jpeg,
    gif: ImageMimeType.gif,
    webp: ImageMimeType.webp,
  };

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const IMAGE_MAX_PER_PROMPT = 10;

export const ATTACHMENT_BASE64_PADDING = 4;

export const ATTACHMENT_BASE64_MAX_CHARS =
  Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + ATTACHMENT_BASE64_PADDING;

export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{64}$/;

export const PROVIDER_IMAGE_INPUT: Readonly<Record<ProviderId, boolean>> = {
  [ProviderId.claude]: true,
  [ProviderId.codex]: true,
  [ProviderId.opencode]: true,
  [ProviderId.gemini]: false,
};
