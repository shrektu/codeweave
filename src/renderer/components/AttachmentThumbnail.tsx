import { useEffect, useState, type JSX } from "react";

import type { AttachmentView } from "../../shared/views";
import { thumbnailCache } from "../attachments";
import { useApp } from "../services";

interface LoadedImage {
  readonly key: string;
  readonly src: string | null;
}

const BASE64_SEPARATOR = ";base64,";

function cacheKeyOf(
  attachmentId: string,
  sessionId: string | undefined,
): string {
  return sessionId === undefined
    ? attachmentId
    : `${sessionId}:${attachmentId}`;
}

function dataUrlOf(mimeType: string, dataBase64: string): string {
  return `data:${mimeType}${BASE64_SEPARATOR}${dataBase64}`;
}

export function AttachmentThumbnail({
  attachment,
  sessionId,
}: {
  readonly attachment: AttachmentView;
  readonly sessionId?: string | undefined;
}): JSX.Element {
  const { client } = useApp();
  const key = cacheKeyOf(attachment.id, sessionId);
  const [loaded, setLoaded] = useState<LoadedImage | null>(() => {
    const cached = thumbnailCache.get(key);
    return cached === undefined ? null : { key, src: cached };
  });

  useEffect(() => {
    if (loaded?.key === key) {
      return;
    }
    let active = true;
    const params =
      sessionId === undefined
        ? { id: attachment.id }
        : { id: attachment.id, sessionId };
    client
      .request("attachments/get", params)
      .then((data) => {
        const src = dataUrlOf(data.mimeType, data.dataBase64);
        thumbnailCache.set(key, src);
        if (active) {
          setLoaded({ key, src });
        }
      })
      .catch((error: unknown) => {
        console.warn(`could not load attachment ${attachment.id}`, error);
        thumbnailCache.set(key, null);
        if (active) {
          setLoaded({ key, src: null });
        }
      });
    return () => {
      active = false;
    };
  }, [client, key, attachment.id, sessionId, loaded]);

  const src = loaded?.key === key ? loaded.src : null;
  return (
    <span className="attachment-thumb">
      {src !== null && (
        <img
          className="attachment-thumb-image"
          src={src}
          alt={attachment.name}
        />
      )}
      <span className="attachment-name" title={attachment.name}>
        {attachment.name}
      </span>
    </span>
  );
}
