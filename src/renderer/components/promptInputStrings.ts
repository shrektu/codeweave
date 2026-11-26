export const PROMPT_INPUT_STRINGS = {
  mentionListLabel: "File and folder suggestions",
  mentionEmpty: "No matching files or folders",
  mentionLoading: "Loading…",
  folderSuffixHint: "folder",
  attachmentListLabel: "Attached images",
  removeAttachment: (name: string): string => `Remove ${name}`,
  imagesUnsupported: (provider: string): string =>
    `${provider} cannot read images. Remove them or switch agents to send.`,
  imageTooLarge: (name: string): string => `${name} exceeds 5 MB.`,
  imageWrongType: (name: string): string =>
    `${name} is not a PNG, JPEG, GIF, or WebP image.`,
  tooManyImages: "You can attach up to 10 images per prompt.",
  attachFailed: (name: string): string => `Could not attach ${name}.`,
  dismissError: "Dismiss error",
};
