import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  ATTACHMENT_ID_PATTERN,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  IMAGE_MIME_BY_EXTENSION,
  IMAGE_MIME_TYPES,
  ImageMimeType,
} from "../domain/attachments";
import { IpcError, IpcErrorCode } from "../shared/protocol";
import type { AttachmentView } from "../shared/views";

import { TEMP_FILE_SUFFIX } from "./constants";
import { isMissingError } from "./fileSnapshot";
import { SESSION_ID_SCHEMA } from "./sessionHistory";

const STAGING_DIR = "staging";
const HASH_ALGORITHM = "sha256";
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_CHUNK = 4;
const EMPTY_BASE64 = "";
const INVALID_ATTACHMENT_MESSAGE = "Invalid attachment data";
const INVALID_ATTACHMENT_ID_MESSAGE = "Invalid attachment id";
const INVALID_SESSION_MESSAGE = "Invalid session id";
const ATTACHMENT_NOT_FOUND_MESSAGE = "Attachment not found";
const ATTACHMENT_TOO_LARGE_MESSAGE = "Attachment is too large";
const ATTACHMENT_MISMATCH_MESSAGE = "Attachment type does not match its data";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIGNATURES: readonly string[] = ["GIF87a", "GIF89a"];
const GIF_HEADER_BYTES = 6;
const RIFF_SIGNATURE = Buffer.from("RIFF", "latin1");
const WEBP_SIGNATURE = Buffer.from("WEBP", "latin1");
const WEBP_MARKER_OFFSET = 8;
const WEBP_MARKER_END = 12;

const EPERM_CODE = "EPERM";
const EACCES_CODE = "EACCES";
const EEXIST_CODE = "EEXIST";
const PUBLISH_COLLISION_CODES: readonly string[] = [
  EPERM_CODE,
  EACCES_CODE,
  EEXIST_CODE,
];

const MAGIC_SIGNATURES: Readonly<
  Record<ImageMimeType, (bytes: Buffer) => boolean>
> = {
  [ImageMimeType.png]: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE),
  [ImageMimeType.jpeg]: (bytes) =>
    bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE),
  [ImageMimeType.gif]: (bytes) =>
    GIF_SIGNATURES.includes(
      bytes.subarray(0, GIF_HEADER_BYTES).toString("latin1"),
    ),
  [ImageMimeType.webp]: (bytes) =>
    bytes.length >= WEBP_MARKER_END &&
    bytes.subarray(0, RIFF_SIGNATURE.length).equals(RIFF_SIGNATURE) &&
    bytes.subarray(WEBP_MARKER_OFFSET, WEBP_MARKER_END).equals(WEBP_SIGNATURE),
};

export interface AttachmentStageInput {
  readonly name: string;
  readonly mimeType: ImageMimeType;
  readonly dataBase64: string;
}

export interface AttachmentData {
  readonly mimeType: ImageMimeType;
  readonly dataBase64: string;
}

export interface AttachmentStore {
  stage(input: AttachmentStageInput): Promise<AttachmentView>;
  claim(sessionId: string, view: AttachmentView): Promise<string>;
  read(sessionId: string | undefined, id: string): Promise<AttachmentData>;
}

export interface AttachmentFs {
  readonly rename: (from: string, to: string) => Promise<void>;
}

export interface AttachmentStoreDeps {
  readonly dir: string;
  readonly fs?: AttachmentFs;
}

const DEFAULT_FS: AttachmentFs = { rename };

function validation(message: string): IpcError {
  return new IpcError(IpcErrorCode.VALIDATION, message);
}

function decodeCanonical(dataBase64: string): Buffer {
  const validShape =
    dataBase64 !== EMPTY_BASE64 &&
    dataBase64.length % BASE64_CHUNK === 0 &&
    BASE64_PATTERN.test(dataBase64);
  if (!validShape) {
    throw validation(INVALID_ATTACHMENT_MESSAGE);
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== dataBase64) {
    throw validation(INVALID_ATTACHMENT_MESSAGE);
  }
  return bytes;
}

function fileNameOf(id: string, mimeType: ImageMimeType): string {
  return `${id}.${IMAGE_EXTENSIONS[mimeType]}`;
}

function mimeOfFileName(name: string): ImageMimeType | null {
  const extension = name.slice(name.lastIndexOf(".") + 1);
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function fileMatchesId(file: string, id: string): Promise<boolean> {
  try {
    const bytes = await readFile(file);
    return createHash(HASH_ALGORITHM).update(bytes).digest("hex") === id;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

function isPublishCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    PUBLISH_COLLISION_CODES.includes(error.code)
  );
}

type WriteTemp = (temporary: string) => Promise<void>;

async function publishContentAddressed(
  target: string,
  id: string,
  writeTemp: WriteTemp,
  fs: AttachmentFs,
): Promise<void> {
  const temporary = `${target}.${randomUUID()}${TEMP_FILE_SUFFIX}`;
  try {
    await writeTemp(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (isPublishCollision(error) && (await fileMatchesId(target, id))) {
      await rm(temporary, { force: true });
      return;
    }
    await rm(temporary, { force: true });
    throw error;
  }
}

function requireSessionId(sessionId: string): void {
  if (!SESSION_ID_SCHEMA.safeParse(sessionId).success) {
    throw validation(INVALID_SESSION_MESSAGE);
  }
}

function requireAttachmentId(id: string): void {
  if (!ATTACHMENT_ID_PATTERN.test(id)) {
    throw validation(INVALID_ATTACHMENT_ID_MESSAGE);
  }
}

function notFound(): IpcError {
  return new IpcError(IpcErrorCode.NOT_FOUND, ATTACHMENT_NOT_FOUND_MESSAGE);
}

async function pathIn(dir: string, id: string): Promise<string | null> {
  for (const mimeType of IMAGE_MIME_TYPES) {
    const file = join(dir, fileNameOf(id, mimeType));
    if (await fileExists(file)) {
      return file;
    }
  }
  return null;
}

async function readStored(file: string): Promise<AttachmentData> {
  const mimeType = mimeOfFileName(file);
  if (mimeType === null) {
    throw notFound();
  }
  const bytes = await readFile(file);
  return { mimeType, dataBase64: bytes.toString("base64") };
}

async function stageAttachment(
  stagingDir: string,
  input: AttachmentStageInput,
  publish: (target: string, id: string, writeTemp: WriteTemp) => Promise<void>,
): Promise<AttachmentView> {
  const bytes = decodeCanonical(input.dataBase64);
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw validation(ATTACHMENT_TOO_LARGE_MESSAGE);
  }
  if (!MAGIC_SIGNATURES[input.mimeType](bytes)) {
    throw validation(ATTACHMENT_MISMATCH_MESSAGE);
  }
  const id = createHash(HASH_ALGORITHM).update(bytes).digest("hex");
  const file = join(stagingDir, fileNameOf(id, input.mimeType));
  if (!(await fileExists(file))) {
    await mkdir(stagingDir, { recursive: true });
    await publish(file, id, (temporary) => writeFile(temporary, bytes));
  }
  return {
    id,
    name: input.name,
    mimeType: input.mimeType,
    bytes: bytes.length,
  };
}

async function claimAttachment(
  attachmentsDir: string,
  stagingDir: string,
  sessionId: string,
  view: AttachmentView,
  publish: (target: string, id: string, writeTemp: WriteTemp) => Promise<void>,
): Promise<string> {
  requireSessionId(sessionId);
  requireAttachmentId(view.id);
  const sessionDir = join(attachmentsDir, sessionId);
  const sessionFile = join(sessionDir, fileNameOf(view.id, view.mimeType));
  if (await fileMatchesId(sessionFile, view.id)) {
    return sessionFile;
  }
  const staged = join(stagingDir, fileNameOf(view.id, view.mimeType));
  if (!(await fileExists(staged))) {
    throw notFound();
  }
  await mkdir(sessionDir, { recursive: true });
  await publish(sessionFile, view.id, (temporary) =>
    copyFile(staged, temporary),
  );
  return sessionFile;
}

async function readAttachment(
  attachmentsDir: string,
  stagingDir: string,
  sessionId: string | undefined,
  id: string,
): Promise<AttachmentData> {
  requireAttachmentId(id);
  if (sessionId !== undefined) {
    requireSessionId(sessionId);
    const sessionFile = await pathIn(join(attachmentsDir, sessionId), id);
    if (sessionFile !== null) {
      return readStored(sessionFile);
    }
  }
  const staged = await pathIn(stagingDir, id);
  if (staged === null) {
    throw notFound();
  }
  return readStored(staged);
}

export function createAttachmentStore(
  deps: AttachmentStoreDeps,
): AttachmentStore {
  const stagingDir = join(deps.dir, STAGING_DIR);
  const fs = deps.fs ?? DEFAULT_FS;
  const inFlight = new Map<string, Promise<void>>();

  function publish(
    target: string,
    id: string,
    writeTemp: WriteTemp,
  ): Promise<void> {
    const existing = inFlight.get(target);
    if (existing !== undefined) {
      return existing;
    }
    const pending = publishContentAddressed(target, id, writeTemp, fs).finally(
      () => {
        if (inFlight.get(target) === pending) {
          inFlight.delete(target);
        }
      },
    );
    inFlight.set(target, pending);
    return pending;
  }

  return {
    stage: (input) => stageAttachment(stagingDir, input, publish),
    claim: (sessionId, view) =>
      claimAttachment(deps.dir, stagingDir, sessionId, view, publish),
    read: (sessionId, id) =>
      readAttachment(deps.dir, stagingDir, sessionId, id),
  };
}
