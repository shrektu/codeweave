import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
} from "react";

import type { AttachmentView } from "../../shared/views";
import {
  isImageMimeType,
  toBase64,
  validateImageFile,
  type ImageCheck,
} from "../attachments";
import type { IpcClient } from "../ipc";

import { PROMPT_INPUT_STRINGS } from "./promptInputStrings";

export interface AttachmentStaging {
  readonly error: string | null;
  readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
  readonly onRemove: (id: string) => void;
  readonly dismiss: () => void;
}

const FILES_DRAG_TYPE = "Files";

function imageErrorText(
  check: Extract<ImageCheck, { readonly ok: false }>,
  name: string,
): string {
  switch (check.kind) {
    case "tooLarge":
      return PROMPT_INPUT_STRINGS.imageTooLarge(name);
    case "wrongType":
      return PROMPT_INPUT_STRINGS.imageWrongType(name);
    case "tooMany":
      return PROMPT_INPUT_STRINGS.tooManyImages;
  }
}

interface StageFileArgs {
  readonly client: IpcClient;
  readonly file: File;
  readonly attachments: readonly AttachmentView[];
  readonly pendingCount: number;
  readonly onAttached: (view: AttachmentView) => void;
  readonly onError: (message: string) => void;
}

function appendAttachment(
  current: readonly AttachmentView[],
  view: AttachmentView,
): readonly AttachmentView[] {
  return current.some((item) => item.id === view.id)
    ? current
    : [...current, view];
}

async function stageFile({
  client,
  file,
  attachments,
  pendingCount,
  onAttached,
  onError,
}: StageFileArgs): Promise<void> {
  const check = validateImageFile(
    { name: file.name, type: file.type, size: file.size },
    attachments.length + pendingCount - 1,
  );
  if (!check.ok) {
    onError(imageErrorText(check, file.name));
    return;
  }
  try {
    const dataBase64 = toBase64(await file.arrayBuffer());
    const view = await client.request("attachments/stage", {
      name: file.name,
      mimeType: check.mimeType,
      dataBase64,
    });
    onAttached(view);
  } catch (caught: unknown) {
    console.warn(`could not stage attachment ${file.name}`, caught);
    onError(PROMPT_INPUT_STRINGS.attachFailed(file.name));
  }
}

function imageFilesOf(files: FileList): readonly File[] {
  return Array.from(files).filter((file) => isImageMimeType(file.type));
}

function carriesFiles(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.files.length > 0 ||
    Array.from(dataTransfer.types).includes(FILES_DRAG_TYPE)
  );
}

interface StagingArgs {
  readonly client: IpcClient;
  readonly attachments: readonly AttachmentView[];
  readonly onAttachmentsChange: (
    update: (current: readonly AttachmentView[]) => readonly AttachmentView[],
  ) => void;
  readonly generation: number;
  readonly onPendingChange: (pending: boolean) => void;
}

interface StageFiles {
  readonly error: string | null;
  readonly setError: (message: string | null) => void;
  readonly attach: (files: readonly File[]) => Promise<void>;
}

function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function useStageFiles({
  client,
  attachments,
  onAttachmentsChange,
  generation,
  onPendingChange,
}: StagingArgs): StageFiles {
  const [error, setError] = useState<string | null>(null);
  const attachmentsRef = useLatestRef(attachments);
  const generationRef = useLatestRef(generation);
  const pendingRef = useRef(0);

  const shiftPending = (delta: number): void => {
    pendingRef.current += delta;
    onPendingChange(pendingRef.current > 0);
  };

  const start = async (file: File): Promise<void> => {
    const precheck = validateImageFile(
      { name: file.name, type: file.type, size: file.size },
      0,
    );
    if (!precheck.ok) {
      setError(imageErrorText(precheck, file.name));
      return;
    }
    const startedIn = generationRef.current;
    shiftPending(1);
    try {
      await stageFile({
        client,
        file,
        attachments: attachmentsRef.current,
        pendingCount: pendingRef.current,
        onAttached: (view) => {
          if (generationRef.current === startedIn) {
            onAttachmentsChange((current) => appendAttachment(current, view));
          }
        },
        onError: setError,
      });
    } finally {
      shiftPending(-1);
    }
  };

  const attach = async (files: readonly File[]): Promise<void> => {
    await Promise.all(files.map((file) => start(file)));
  };

  return { error, setError, attach };
}

export function useAttachmentStaging(args: StagingArgs): AttachmentStaging {
  const { error, setError, attach } = useStageFiles(args);
  const { onAttachmentsChange } = args;

  return {
    error,
    onPaste: (event) => {
      const images = imageFilesOf(event.clipboardData.files);
      if (images.length === 0) {
        return;
      }
      event.preventDefault();
      void attach(images);
    },
    onDragOver: (event) => {
      if (carriesFiles(event.dataTransfer)) {
        event.preventDefault();
      }
    },
    onDrop: (event) => {
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      void attach(files);
    },
    onRemove: (id) => {
      onAttachmentsChange((current) =>
        current.filter((item) => item.id !== id),
      );
    },
    dismiss: () => {
      setError(null);
    },
  };
}
