import type {
  AttachmentStore,
  AttachmentData,
} from "../../src/backend/attachmentStore";
import type { AttachmentView } from "../../src/shared/views";

export function fakeAttachmentStore(
  overrides: Partial<AttachmentStore> = {},
): AttachmentStore {
  return {
    stage: (input) =>
      Promise.resolve<AttachmentView>({
        id: "0".repeat(64),
        name: input.name,
        mimeType: input.mimeType,
        bytes: 1,
      }),
    claim: (_sessionId, view) => Promise.resolve(view.id),
    read: () =>
      Promise.resolve<AttachmentData>({
        mimeType: "image/png",
        dataBase64: "",
      }),
    ...overrides,
  };
}
